#!/usr/bin/env node
// Monte-Carlo simulator for "Το φιδάκι της Προπαίδειας".
// Node built-ins only. It runs the real rules: <script id="game-core"> is loaded from index.html.
// Seeded RNG, so the same arguments always print the same numbers.
//
// Usage:
//   node tools/simulate.mjs                 baseline (original game) next to the current GAME_CONFIG
//   node tools/simulate.mjs --compare       the Phase 3 candidate configurations against the targets
//   node tools/simulate.mjs --players 4 --p 0.6 --mode pvp --games 50000 --seed 7
//   node tools/simulate.mjs --json

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
export const INDEX_HTML = join(HERE, '..', 'index.html');

// ---------------------------------------------------------------------------
// Load the real rules
// ---------------------------------------------------------------------------
export function loadCore(htmlPath = INDEX_HTML) {
    const html = readFileSync(htmlPath, 'utf8');
    const match = html.match(/<script id="game-core">([\s\S]*?)<\/script>/);
    if (!match) throw new Error(`No <script id="game-core"> in ${htmlPath}`);
    const context = vm.createContext({});
    return vm.runInContext(`${match[1]}\n;({ GAME_CONFIG, GameCore })`, context);
}

// Plain-object deep merge for config overrides (arrays and snake/ladder maps are replaced, not merged).
export function withOverrides(base, overrides = {}) {
    const out = JSON.parse(JSON.stringify(base));
    for (const [key, value] of Object.entries(overrides)) {
        const replace = key === 'snakes' || key === 'ladders' || Array.isArray(value);
        if (!replace && value && typeof value === 'object' && out[key] && typeof out[key] === 'object') {
            out[key] = withOverrides(out[key], value);
        } else {
            out[key] = JSON.parse(JSON.stringify(value));
        }
    }
    return out;
}

// The original game, expressed as GAME_CONFIG overrides.
export const BASELINE_OVERRIDES = {
    snakes: { 99: 54, 95: 75, 87: 24, 62: 19, 48: 26, 36: 6, 16: 4 },
    ladders: { 2: 38, 7: 14, 8: 31, 15: 26, 21: 42, 28: 84, 51: 67, 71: 91, 78: 98 },
    questions: { minFactor: 0, maxFactor: 10, density: 1, noQuestionCells: [1, 67, 100] },
    finishRule: 'exact',
    wrongAnswerPenalty: 'turnStart',
    computer: { answersQuestions: false, accuracy: 0.75 },
    easterEgg67: { cell: 67, durationMs: 5500 },
};

// ---------------------------------------------------------------------------
// Timings (seconds), taken from the code in index.html
// ---------------------------------------------------------------------------
export const TIMING = {
    humanHandover: 2.0,     // ASSUMPTION: child notices it is their turn and presses «Ρίξε το Ζάρι»
    computerThink: 1.8,     // endTurn later(1000) + wait(800)
    die: 1.5,               // animateDieRoll: 1000 spin + 500
    perStep: 0.45,          // animateToCell 300 + wait(150) per cell
    plainLanding: 0.3,      // wait(300)
    overshoot: 1.5,         // wait(1500) so the message can be read (original: 0)
    snakeOrLadder: 2.4,     // 300 + overlay 1500 + slide 300 + 300
    childAnswer: 8.0,       // ASSUMPTION (brief): time for a child to answer
    correctFeedback: 2.5,   // wait(2000) + wait(500)
    wrongFeedback: 3.3,     // wait(2500) + slide back 300 + wait(500)
    computerAnswer: 2.3,    // computerAnswer wait(1800) + wait(500)
    computerWrongExtra: 0.3 // slide back
};
const BASELINE_TIMING = { ...TIMING, overshoot: 0 };

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------
const MAX_TURNS = 20000; // safety cap; reported if ever hit

export function playGame(GameCore, rules, { players, mode, p }, rng, timing = TIMING) {
    const { config } = rules;
    const n = mode === 'pve' ? 2 : players;
    const isComputer = (i) => mode === 'pve' && i === 1; // player 2 is the computer
    const state = Array.from({ length: n }, () => GameCore.newPlayerState());
    const questions = new Array(n).fill(0);
    const turnsTaken = new Array(n).fill(0);
    let seconds = 0;
    let turn = 0;
    let cur = 0;

    while (turn < MAX_TURNS) {
        turn++;
        turnsTaken[cur]++;
        const cpu = isComputer(cur);
        const player = state[cur];
        seconds += (cpu ? timing.computerThink : timing.humanHandover) + timing.die;

        const roll = 1 + Math.floor(rng() * 6);
        const outcome = GameCore.resolveRoll(rules, player, roll, cpu);
        player.wastedFinishRolls = outcome.wastedFinishRolls;
        seconds += outcome.path.length * timing.perStep;

        switch (outcome.kind) {
            case 'overshoot':
                seconds += timing.overshoot;
                break;
            case 'win':
                player.position = 100;
                return { winner: cur, turns: turn, seconds, questions, turnsTaken, isComputer, n };
            case 'snake':
            case 'ladder':
                player.position = outcome.end;
                seconds += timing.snakeOrLadder + (outcome.egg ? config.easterEgg67.durationMs / 1000 + 0.3 : 0);
                break;
            case 'question': {
                questions[cur]++;
                const correct = rng() < (cpu ? config.computer.accuracy : p);
                player.position = GameCore.positionAfterAnswer(rules, outcome, correct);
                if (cpu) {
                    seconds += timing.computerAnswer + (correct ? 0 : timing.computerWrongExtra);
                } else {
                    seconds += timing.childAnswer + (correct ? timing.correctFeedback : timing.wrongFeedback);
                }
                break;
            }
            default:
                player.position = outcome.end;
                seconds += outcome.egg ? config.easterEgg67.durationMs / 1000 : timing.plainLanding;
        }
        if (!(player.position >= 1 && player.position <= 100)) {
            throw new Error(`position out of range: ${player.position}`);
        }
        cur = (cur + 1) % n;
    }
    return { winner: -1, turns: turn, seconds, questions, turnsTaken, isComputer, n };
}

// ---------------------------------------------------------------------------
// Scenario statistics
// ---------------------------------------------------------------------------
function quantile(sorted, q) {
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[i];
}

export function scenarioSeed(seed, s) {
    return seed + s.players * 100 + Math.round(s.p * 100) + (s.mode === 'pve' ? 7 : 0);
}

export function runScenario(GameCore, config, scenario, games, seed, timing = TIMING) {
    const rules = GameCore.buildRules(config);
    const rng = GameCore.createRng(scenarioSeed(seed, scenario));
    const turns = [];
    const minutes = [];
    let over30 = 0, unfinished = 0, humanWins = 0;
    let humanQuestions = 0, humanPlayerGames = 0, humanTurns = 0;

    for (let g = 0; g < games; g++) {
        const r = playGame(GameCore, rules, scenario, rng, timing);
        if (r.winner < 0) unfinished++;
        turns.push(r.turns);
        const m = r.seconds / 60;
        minutes.push(m);
        if (m > 30) over30++;
        for (let i = 0; i < r.n; i++) {
            if (r.isComputer(i)) continue;
            humanQuestions += r.questions[i];
            humanTurns += r.turnsTaken[i];
            humanPlayerGames++;
        }
        if (scenario.mode === 'pve' && r.winner === 0) humanWins++;
    }
    turns.sort((a, b) => a - b);
    minutes.sort((a, b) => a - b);
    const n = scenario.mode === 'pve' ? 2 : scenario.players;
    return {
        mode: scenario.mode,
        players: n,
        p: scenario.p,
        games,
        turnsMedian: quantile(turns, 0.5),
        turnsP90: quantile(turns, 0.9),
        turnsP99: quantile(turns, 0.99),
        roundsMedian: Math.ceil(quantile(turns, 0.5) / n),
        minMedian: quantile(minutes, 0.5),
        minP90: quantile(minutes, 0.9),
        minP99: quantile(minutes, 0.99),
        pctOver30: (100 * over30) / games,
        questionsPerPlayer: humanQuestions / humanPlayerGames,
        questionsPerTurn: humanQuestions / humanTurns,
        humanWinPct: scenario.mode === 'pve' ? (100 * humanWins) / games : null,
        unfinished,
    };
}

export function defaultScenarios() {
    const list = [];
    for (const players of [2, 3, 4]) {
        for (const p of [0.6, 0.75, 0.9]) list.push({ mode: 'pvp', players, p });
    }
    for (const p of [0.6, 0.75, 0.9]) list.push({ mode: 'pve', players: 2, p });
    return list;
}

const f1 = (x) => x.toFixed(1);

export function formatTable(rows) {
    const head = '| Mode | Pl | p | Turns med / P90 / P99 | Rounds med | Minutes med / P90 / P99 | >30 min | Q per player | Q per turn | Human win (pve) |';
    const sep = '|---|---|---|---|---|---|---|---|---|---|';
    const lines = rows.map((r) =>
        `| ${r.mode} | ${r.players} | ${r.p} | ${r.turnsMedian} / ${r.turnsP90} / ${r.turnsP99} | ${r.roundsMedian} | ` +
        `${f1(r.minMedian)} / ${f1(r.minP90)} / ${f1(r.minP99)} | ${f1(r.pctOver30)}% | ${f1(r.questionsPerPlayer)} | ` +
        `${r.questionsPerTurn.toFixed(2)} | ${r.humanWinPct === null ? '–' : f1(r.humanWinPct) + '%'} |` +
        (r.unfinished ? ` (${r.unfinished} unfinished)` : ''));
    return [head, sep, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Phase 3: candidate configurations and targets
// ---------------------------------------------------------------------------
export const TARGET_SCENARIOS = {
    two: { mode: 'pvp', players: 2, p: 0.75 },
    four: { mode: 'pvp', players: 4, p: 0.75 },
    pve: { mode: 'pve', players: 2, p: 0.75 },
};

export function checkTargets(two, four, pve) {
    const checks = {
        'median 12–18': two.minMedian >= 12 && two.minMedian <= 18, // also covers "at least 10"
        'P90 ≤ 25': two.minP90 <= 25,
        '>30 < 3%': two.pctOver30 < 3,
        '4p median ≤ 30': four.minMedian <= 30,
        'pve 40–60%': pve.humanWinPct >= 40 && pve.humanWinPct <= 60,
        'Q/turn ≥ 0.5': two.questionsPerTurn >= 0.5 && four.questionsPerTurn >= 0.5 && pve.questionsPerTurn >= 0.5,
    };
    return { checks, all: Object.values(checks).every(Boolean) };
}

// Each candidate lists only what it changes from the original game (plus the fairness fix, lever f).
const FAIR = { computer: { answersQuestions: true, accuracy: 0.75 } };
const SNAKES_SOFT = { 99: 80, 95: 75, 87: 57, 62: 19, 48: 26, 36: 6, 16: 4 };
const SNAKES_G = { 99: 80, 95: 75, 87: 66, 62: 19, 48: 26, 36: 6, 16: 4 };
// 28→84 skips 56 cells, which breaks the 50-cell rule, so every board candidate fixes it.
const LADDERS_58 = { 2: 38, 7: 14, 8: 31, 15: 26, 21: 42, 28: 58, 51: 67, 71: 91, 78: 98 };
export const CANDIDATES = [
    { id: 'B', label: 'Baseline (original)', overrides: {}, changes: 0 },
    { id: 'F', label: 'f: computer answers too', overrides: { ...FAIR }, changes: 1 },
    { id: 'C1', label: 'f + finish: reach or pass', overrides: { ...FAIR, finishRule: 'reachOrPass' }, changes: 2 },
    { id: 'C2', label: 'f + finish: exact, any after 2', overrides: { ...FAIR, finishRule: 'exactThenAny', exactFinishAttempts: 2 }, changes: 2 },
    { id: 'D2', label: 'f + penalty: half the roll', overrides: { ...FAIR, wrongAnswerPenalty: 'halfRoll' }, changes: 2 },
    { id: 'A', label: 'f + soft snakes 99→80, 87→57', overrides: { ...FAIR, snakes: SNAKES_SOFT }, changes: 3 },
    { id: 'C2+D2', label: 'f + exact/any after 2 + half roll', overrides: { ...FAIR, finishRule: 'exactThenAny', wrongAnswerPenalty: 'halfRoll' }, changes: 3 },
    { id: 'C1+D2', label: 'f + reach or pass + half roll', overrides: { ...FAIR, finishRule: 'reachOrPass', wrongAnswerPenalty: 'halfRoll' }, changes: 3 },
    { id: 'C2+A', label: 'f + exact/any after 2 + soft snakes', overrides: { ...FAIR, finishRule: 'exactThenAny', snakes: SNAKES_SOFT }, changes: 4 },
    { id: 'C1+A', label: 'f + reach or pass + soft snakes', overrides: { ...FAIR, finishRule: 'reachOrPass', snakes: SNAKES_SOFT }, changes: 4 },
    { id: 'L', label: 'f + ladder 28→58', overrides: { ...FAIR, ladders: LADDERS_58 }, changes: 2 },
    { id: 'G', label: 'f + ladder 28→58 + snakes 99→80, 87→66', overrides: { ...FAIR, ladders: LADDERS_58, snakes: SNAKES_G }, changes: 4 },
    { id: 'G+C2', label: 'G + exact/any after 2', overrides: { ...FAIR, ladders: LADDERS_58, snakes: SNAKES_G, finishRule: 'exactThenAny' }, changes: 5 },
    { id: 'G+D2', label: 'G + half roll', overrides: { ...FAIR, ladders: LADDERS_58, snakes: SNAKES_G, wrongAnswerPenalty: 'halfRoll' }, changes: 5 },
];

function runCompare(GameCore, baseConfig, games, seed) {
    const head = '| ID | Candidate | 2p min med / P90 / P99 | 2p >30 | 2p turns med / P90 | 4p min med / P90 | 4p >30 | pve human win | pve min med | Q/turn 2p | Q/player 2p | Targets |';
    const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|';
    const lines = [];
    const results = [];
    for (const c of CANDIDATES) {
        const config = withOverrides(withOverrides(baseConfig, BASELINE_OVERRIDES), c.overrides);
        const timing = c.id === 'B' ? BASELINE_TIMING : TIMING;
        const two = runScenario(GameCore, config, TARGET_SCENARIOS.two, games, seed, timing);
        const four = runScenario(GameCore, config, TARGET_SCENARIOS.four, games, seed, timing);
        const pve = runScenario(GameCore, config, TARGET_SCENARIOS.pve, games, seed, timing);
        const t = checkTargets(two, four, pve);
        const failed = Object.entries(t.checks).filter(([, ok]) => !ok).map(([k]) => k);
        results.push({ ...c, two, four, pve, targets: t });
        lines.push(`| ${c.id} | ${c.label} | ${f1(two.minMedian)} / ${f1(two.minP90)} / ${f1(two.minP99)} | ${f1(two.pctOver30)}% | ` +
            `${two.turnsMedian} / ${two.turnsP90} | ${f1(four.minMedian)} / ${f1(four.minP90)} | ${f1(four.pctOver30)}% | ` +
            `${f1(pve.humanWinPct)}% | ${f1(pve.minMedian)} | ${two.questionsPerTurn.toFixed(2)} | ${f1(two.questionsPerPlayer)} | ` +
            `${t.all ? '✅ all' : '❌ ' + failed.join(', ')} |`);
    }
    return { table: [head, sep, ...lines].join('\n'), results };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
    const { values } = parseArgs({
        options: {
            players: { type: 'string' },
            p: { type: 'string' },
            mode: { type: 'string' },
            games: { type: 'string', default: '20000' },
            seed: { type: 'string', default: '20261014' },
            compare: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    });
    const games = Number(values.games);
    const seed = Number(values.seed);
    const { GAME_CONFIG, GameCore } = loadCore();

    if (values.compare) {
        const { table, results } = runCompare(GameCore, GAME_CONFIG, games, seed);
        if (values.json) {
            console.log(JSON.stringify(results, null, 2));
        } else {
            console.log(`Candidates, ${games} games per scenario, seed ${seed}, p = 0.75`);
            console.log(table);
        }
    } else {
        let scenarios = defaultScenarios();
        if (values.mode) scenarios = scenarios.filter((s) => s.mode === values.mode);
        if (values.players) scenarios = scenarios.filter((s) => s.players === Number(values.players));
        if (values.p) scenarios = scenarios.filter((s) => s.p === Number(values.p));
        if (scenarios.length === 0) {
            console.error('No scenario matches. Valid: --mode pvp|pve, --players 2|3|4, --p 0.6|0.75|0.9');
            process.exit(1);
        }

        const baseline = withOverrides(GAME_CONFIG, BASELINE_OVERRIDES);
        const baseRows = scenarios.map((s) => runScenario(GameCore, baseline, s, games, seed, BASELINE_TIMING));
        const curRows = scenarios.map((s) => runScenario(GameCore, GAME_CONFIG, s, games, seed, TIMING));
        const two = curRows.find((r) => r.mode === 'pvp' && r.players === 2 && r.p === 0.75);
        const four = curRows.find((r) => r.mode === 'pvp' && r.players === 4 && r.p === 0.75);
        const pve = curRows.find((r) => r.mode === 'pve' && r.p === 0.75);

        if (values.json) {
            console.log(JSON.stringify({ games, seed, timing: TIMING, baseline: baseRows, current: curRows }, null, 2));
        } else {
            console.log(`${games} games per scenario, seed ${seed}\n`);
            console.log('BASELINE (original game)');
            console.log(formatTable(baseRows));
            console.log('\nCURRENT GAME_CONFIG (index.html)');
            console.log(formatTable(curRows));
            if (two && four && pve) {
                const t = checkTargets(two, four, pve);
                console.log('\nTargets (2 players, p = 0.75):');
                for (const [name, ok] of Object.entries(t.checks)) console.log(`  ${ok ? '✅' : '❌'} ${name}`);
            }
        }
    }
}
