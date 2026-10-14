// Tests for the pure game rules in <script id="game-core">.
// Node built-ins only:  node --test   (or)   node tests/core.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const html = readFileSync(HTML_PATH, 'utf8');

function loadCore() {
    const match = html.match(/<script id="game-core">([\s\S]*?)<\/script>/);
    assert.ok(match, 'index.html has a <script id="game-core"> block');
    return vm.runInContext(`${match[1]}\n;({ GAME_CONFIG, GameCore })`, vm.createContext({}));
}

const { GAME_CONFIG, GameCore } = loadCore();
const rules = GameCore.buildRules(GAME_CONFIG);
const clone = (obj) => JSON.parse(JSON.stringify(obj));

function configWith(overrides) {
    return { ...clone(GAME_CONFIG), ...overrides };
}

// ---------------------------------------------------------------------------
test('getCellPosition: 100 unique cells in serpentine order', () => {
    const seen = new Set();
    for (let n = 1; n <= 100; n++) {
        const { row, col, x, y } = GameCore.getCellPosition(n);
        assert.equal(row, Math.floor((n - 1) / 10), `row of ${n}`);
        const offset = (n - 1) % 10;
        assert.equal(col, row % 2 === 0 ? offset : 9 - offset, `col of ${n}`);
        const key = `${x},${y}`;
        assert.ok(!seen.has(key), `cell ${n} has a unique position`);
        seen.add(key);

        if (n > 1) {
            // Each cell touches the previous one: same row one column over, or one row up at the turn
            const prev = GameCore.getCellPosition(n - 1);
            const steps = Math.abs(prev.row - row) + Math.abs(prev.col - col);
            assert.equal(steps, 1, `cell ${n} is next to cell ${n - 1}`);
        }
    }
    assert.equal(seen.size, 100);
    assert.deepEqual([GameCore.getCellPosition(1).row, GameCore.getCellPosition(1).col], [0, 0]);
    assert.deepEqual([GameCore.getCellPosition(100).row, GameCore.getCellPosition(100).col], [9, 0]);
});

test('getCellPosition matches the DOM grid built by createBoard()', () => {
    // createBoard() walks the grid from the top-left; this is its numbering formula.
    for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) {
            const boardRow = 9 - r;
            const cellNum = boardRow % 2 === 0 ? boardRow * 10 + c + 1 : boardRow * 10 + (10 - c);
            const pos = GameCore.getCellPosition(cellNum, 55, 3);
            assert.equal(pos.col, c, `cell ${cellNum} column`);
            assert.equal(pos.row, boardRow, `cell ${cellNum} row`);
            assert.equal(pos.x, c * 58 + 27.5);
            assert.equal(pos.y, r * 58 + 27.5);
        }
    }
});

// ---------------------------------------------------------------------------
test('board: no cell is both a snake head and a ladder bottom', () => {
    for (const head of rules.snakes.keys()) {
        assert.ok(!rules.ladders.has(head), `cell ${head}`);
    }
});

test('board: no snake or ladder ends on another snake or ladder start', () => {
    const starts = new Set([...rules.snakes.keys(), ...rules.ladders.keys()]);
    for (const [from, to] of [...rules.snakes, ...rules.ladders]) {
        assert.ok(!starts.has(to), `${from}->${to} ends on a start`);
    }
});

test('board: validateBoard() finds no problems and the design rules hold', () => {
    assert.deepEqual([...GameCore.validateBoard(GAME_CONFIG)], []);
    assert.ok(rules.snakes.size >= 6, 'at least 6 snakes');
    assert.ok([...rules.snakes.keys()].some((h) => h >= 80 && h <= 99), 'a snake in 80–99');
    for (const [bottom, top] of rules.ladders) {
        assert.ok(top - bottom <= 50, `ladder ${bottom}->${top} skips at most 50`);
    }
    for (const [head, tail] of rules.snakes) assert.ok(tail < head && tail >= 1);
});

test('board: validateBoard() catches broken boards', () => {
    const bad = configWith({
        snakes: { 50: 10, 40: 30 },
        ladders: { 50: 60, 3: 40, 5: 90 }
    });
    const problems = GameCore.validateBoard(bad).join('\n');
    assert.match(problems, /both a snake head and a ladder bottom/);
    assert.match(problems, /ends on another snake or ladder/);
    assert.match(problems, /skips more than 50/);
});

test('question cells: none on 1, 67, 100 or any snake/ladder end', () => {
    const blocked = [1, 67, 100, ...rules.snakes.keys(), ...rules.snakes.values(),
        ...rules.ladders.keys(), ...rules.ladders.values()];
    for (const cell of blocked) assert.ok(!rules.questionCells.has(cell), `cell ${cell}`);
    assert.ok(rules.questionCells.size >= 50, `${rules.questionCells.size} question cells`);

    const half = GameCore.buildRules(configWith({ questions: { ...GAME_CONFIG.questions, density: 0.5 } }));
    assert.ok(Math.abs(half.questionCells.size - rules.questionCells.size / 2) <= 1, 'density 0.5 halves them');
    for (const cell of half.questionCells) assert.ok(rules.questionCells.has(cell));
});

// ---------------------------------------------------------------------------
// Finish and penalty rules, positions 94–99, every die value.
// An empty board isolates the rules from snakes and ladders.
const EMPTY_BOARD = { snakes: {}, ladders: {} };

for (const finishRule of ['exact', 'reachOrPass', 'exactThenAny']) {
    test(`finish rule '${finishRule}' on 94–99`, () => {
        const r = GameCore.buildRules(configWith({ ...EMPTY_BOARD, finishRule, exactFinishAttempts: 2 }));
        for (let start = 94; start <= 99; start++) {
            for (let roll = 1; roll <= 6; roll++) {
                for (const wasted of [0, 1, 2, 3]) {
                    const player = { position: start, wastedFinishRolls: wasted };
                    const out = GameCore.resolveRoll(r, player, roll);
                    const reach = start + roll;
                    const anyRollWins = finishRule === 'reachOrPass' || (finishRule === 'exactThenAny' && wasted >= 2);
                    const label = `${finishRule} start ${start} roll ${roll} wasted ${wasted}`;

                    assert.equal(player.position, start, `${label}: resolveRoll does not change the player`);
                    if (reach === 100 || (reach > 100 && anyRollWins)) {
                        assert.equal(out.kind, 'win', label);
                        assert.equal(out.end, 100, label);
                        assert.equal(out.path.at(-1), 100, label);
                    } else if (reach > 100) {
                        assert.equal(out.kind, 'overshoot', label);
                        assert.equal(out.end, start, label);
                        assert.equal(out.path.length, 0, label);
                        assert.equal(out.needed, 100 - start, label);
                        assert.equal(out.wastedFinishRolls, wasted + 1, label);
                    } else {
                        assert.ok(['plain', 'question'].includes(out.kind), label);
                        assert.equal(out.landing, reach, label);
                        assert.deepEqual([...out.path], Array.from({ length: roll }, (_, i) => start + 1 + i), label);
                    }
                    assert.ok(out.end >= 1 && out.end <= 100, label);
                }
            }
        }
    });
}

for (const wrongAnswerPenalty of ['turnStart', 'halfRoll']) {
    test(`wrong-answer penalty '${wrongAnswerPenalty}' on 94–99`, () => {
        const r = GameCore.buildRules(configWith({ ...EMPTY_BOARD, wrongAnswerPenalty }));
        let checked = 0;
        for (let start = 94; start <= 99; start++) {
            for (let roll = 1; roll <= 6; roll++) {
                const out = GameCore.resolveRoll(r, { position: start, wastedFinishRolls: 0 }, roll);
                if (out.kind !== 'question') continue;
                checked++;
                const label = `start ${start} roll ${roll}`;
                assert.equal(GameCore.positionAfterAnswer(r, out, true), out.landing, `${label}: correct keeps the cell`);
                const back = GameCore.positionAfterAnswer(r, out, false);
                const expected = wrongAnswerPenalty === 'turnStart' ? start : out.landing - Math.floor(roll / 2);
                assert.equal(back, expected, label);
                assert.ok(back >= start && back <= out.landing, `${label}: stays between start and landing`);
            }
        }
        assert.ok(checked >= 15, `${checked} question landings checked`);
    });
}

test('the computer gets questions only when GAME_CONFIG.computer.answersQuestions is true', () => {
    const cell = [...rules.questionCells].find((c) => c > 7);
    const player = { position: cell - 3, wastedFinishRolls: 0 };
    const on = GameCore.buildRules(configWith({ computer: { answersQuestions: true, accuracy: 0.75 } }));
    const off = GameCore.buildRules(configWith({ computer: { answersQuestions: false, accuracy: 0.75 } }));
    assert.equal(GameCore.resolveRoll(on, player, 3, true).kind, 'question');
    assert.equal(GameCore.resolveRoll(off, player, 3, true).kind, 'plain');
    assert.equal(GameCore.resolveRoll(off, player, 3, false).kind, 'question');
});

test('snakes, ladders and cell 67 resolve to their ends', () => {
    for (const [from, to] of [...rules.snakes, ...rules.ladders]) {
        if (from < 2) continue;
        const roll = Math.min(6, from - 1);
        const out = GameCore.resolveRoll(rules, { position: from - roll, wastedFinishRolls: 0 }, roll);
        assert.equal(out.landing, from);
        assert.equal(out.end, to, `${from}->${to}`);
        assert.equal(out.egg, to === GAME_CONFIG.easterEgg67.cell);
    }
    const onto67 = GameCore.resolveRoll(rules, { position: 64, wastedFinishRolls: 0 }, 3);
    assert.equal(onto67.kind, 'plain');
    assert.equal(onto67.egg, true);
});

// ---------------------------------------------------------------------------
test('answers: empty or non-numeric input is neither right nor wrong', () => {
    const q = { num1: 6, num2: 7, answer: 42 };
    assert.equal(GameCore.checkAnswer(q, ''), null);
    assert.equal(GameCore.checkAnswer(q, '   '), null);
    assert.equal(GameCore.checkAnswer(q, 'abc'), null);
    assert.equal(GameCore.checkAnswer(q, '4.2'), null);
    assert.equal(GameCore.checkAnswer(q, undefined), null);
    assert.equal(GameCore.checkAnswer(q, '42'), true);
    assert.equal(GameCore.checkAnswer(q, ' 42 '), true);
    assert.equal(GameCore.checkAnswer(q, '41'), false);
    assert.equal(GameCore.checkAnswer(q, '-42'), false);
});

test('questions stay inside the times-table range and wrong guesses are believable', () => {
    const rng = GameCore.createRng(1);
    const { minFactor, maxFactor } = GAME_CONFIG.questions;
    for (let i = 0; i < 5000; i++) {
        const q = GameCore.generateQuestion(rules, rng);
        assert.ok(q.num1 >= minFactor && q.num1 <= maxFactor);
        assert.ok(q.num2 >= minFactor && q.num2 <= maxFactor);
        assert.equal(q.answer, q.num1 * q.num2);
        const wrong = GameCore.wrongAnswerFor(q, rng);
        assert.ok(wrong !== q.answer && wrong >= 0 && Math.abs(wrong - q.answer) <= 3);
    }
});

test('seeded RNG is reproducible', () => {
    const a = GameCore.createRng(42), b = GameCore.createRng(42);
    for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

// ---------------------------------------------------------------------------
function playSeededGame(r, rng, players, computerSeat) {
    const state = Array.from({ length: players }, () => GameCore.newPlayerState());
    let cur = 1;
    for (let turn = 1; turn <= 20000; turn++) {
        const player = state[cur - 1];
        const isComputer = cur === computerSeat;
        const roll = 1 + Math.floor(rng() * 6);
        const out = GameCore.resolveRoll(r, player, roll, isComputer);
        for (const cell of out.path) assert.ok(cell >= 1 && cell <= 100, `path cell ${cell}`);
        player.wastedFinishRolls = out.wastedFinishRolls;
        player.position = out.kind === 'question'
            ? GameCore.positionAfterAnswer(r, out, rng() < 0.75)
            : out.end;
        assert.ok(Number.isInteger(player.position) && player.position >= 1 && player.position <= 100,
            `position ${player.position}`);
        if (out.kind === 'win') return turn;
        cur = GameCore.nextPlayer(cur, players);
    }
    return Infinity;
}

test('10,000 seeded full games terminate and never leave 1–100', () => {
    const rng = GameCore.createRng(20261014);
    let longest = 0;
    for (let g = 0; g < 10000; g++) {
        const players = 2 + (g % 3);
        const turns = playSeededGame(rules, rng, players, g % 4 === 0 ? 2 : 0);
        assert.ok(Number.isFinite(turns), `game ${g} finished`);
        longest = Math.max(longest, turns);
    }
    assert.ok(longest < 20000);
});

test('every finish/penalty combination also terminates (1,000 games each)', () => {
    for (const finishRule of ['exact', 'reachOrPass', 'exactThenAny']) {
        for (const wrongAnswerPenalty of ['turnStart', 'halfRoll']) {
            const r = GameCore.buildRules(configWith({ finishRule, wrongAnswerPenalty }));
            const rng = GameCore.createRng(7);
            for (let g = 0; g < 1000; g++) {
                assert.ok(Number.isFinite(playSeededGame(r, rng, 2, 2)), `${finishRule}/${wrongAnswerPenalty} game ${g}`);
            }
        }
    }
});

// ---------------------------------------------------------------------------
test('publishing: one self-contained file, no console noise, only Google Fonts outside', () => {
    assert.ok(!/console\.(log|warn|error|debug|info)/.test(html), 'no console calls');
    const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) || [];
    for (const url of urls) {
        assert.ok(/^https:\/\/fonts\.googleapis\.com\//.test(url) || url === 'http://www.w3.org/2000/svg',
            `unexpected external URL ${url}`);
    }
    assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
    assert.ok(html.includes('Created by Manos Chatzidakis'), 'credits kept');
    assert.ok(html.includes('manoshatzidakis93@gmail.com'), 'credits email kept');
});
