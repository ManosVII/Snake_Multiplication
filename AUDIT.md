# AUDIT: Το φιδακι της Προπαιδειας.html

This is a read-only audit. The original file was not changed. Line numbers refer to the original file (3,118 lines: CSS 8–1635, HTML 1637–1860, JS 1862–3116).
"Evidence: code" means I traced it in the source. "Evidence: sim" means it comes from `tools/simulate.mjs`. I did not run anything in a browser in Phase 1. The built-in browser pane cannot open `file://`, and I did not create a server config because this phase is read-only.

---

## 1. How the game works

| Stage | What happens | Where |
|---|---|---|
| **Setup** | `initSetup()` shows the setup overlay. In pvp you choose 2–4 players. In pve you get 1 human plus the computer as player 2. Each human picks a name (`onchange` → `setupData`) and a unique emoji. | 2152–2290 |
| **Start** | `startGame()` builds `players{}`, the player cards (`innerHTML`) and the board (100 `div`s in serpentine order). It then draws the SVG snakes and ladders using `getCellPosition()` with the fixed `CELL_SIZE = 55`, `GAP = 3`. | 2292–2658 |
| **Turn** | `rollDice()` is guarded by `gameOver`/`isAnimating`. The die spins for 1000 ms, then waits 500 ms, then calls `movePlayer(roll)`. | 2664–2685 |
| **Movement** | If `pos + roll > 100`, the turn is wasted (exact finish). Otherwise the token moves one cell at a time (300 ms animation + 150 ms pause per step). | 2687–2706 |
| **Victory** | Landing exactly on 100 sets `gameOver`, calls `showVictory()`, shows the full-screen overlay and launches confetti. | 2709, 3041 |
| **Snakes / ladders** | A 1.5 s overlay, then the token jumps to the tail/top, then `endTurn()`. A ladder that ends on 67 also plays the 67 animation. | 2716–2751 |
| **Cell 67** | `showNeon67()` runs for 5.5 s and cannot be skipped. | 2754, 3024 |
| **Questions** | Question cells are every cell except 1, 67, 100 and all snake/ladder ends: **67 cells**. A human who lands on one gets `a × b`, with a, b ∈ 0–10. Correct: 2 s feedback, the token stays. Wrong: 2.5 s feedback, the token returns to the cell the turn started on. The computer is never asked. | 1910–1928, 2763, 2801 |
| **Computer turn** | `endTurn()` sees `isComputer`, waits 1 s, then `computerPlay()` waits 0.8 s and rolls. | 2943–2982 |
| **Reset** | `resetGame()` hides the victory overlay, shows setup, re-enables the roll button and clears four flags. It does **not** cancel anything already running. | 3087–3106 |

There is no shared turn token or cancellation anywhere. All sequencing is `setTimeout` plus `async/await sleep()`, and the only guard is the boolean `isAnimating`.

---

## 2. Defects

Severity: **Functional** (game breaks or gives wrong results) · **Fairness** · **UX** · **Security** · **Publishing**.

### 2a. The suspicions in the brief

| ID | Suspicion | Verdict | Evidence |
|---|---|---|---|
| S1 | Reset during a move, question or computer turn leaves timers and moves running | **Confirmed** | → D1, D2 |
| S2 | Empty answer counts as wrong; Enter + click can run `endTurn` twice | **Empty = wrong: confirmed** (D6). **Double submit: partly confirmed** (D5). There is no re-entry guard. In Chromium the race is closed by accident, and I did not verify it in other browsers. I found a *certain* path to an extra `endTurn` instead (D4). | code |
| S3 | Player names injected into `innerHTML` / `value="..."` | **Confirmed** | → D10 |
| S4 | SVG drifts below 900 px; phones overflow | **Confirmed, and it is worse than suspected.** The SVG is also misaligned on desktop. | → D8, D9 |
| S5 | Question cells are not marked though the legend lists them | **Confirmed** | → D11 |
| S6 | Computer is never sent back, so it has a large advantage | **Rule confirmed. "Large" rejected.** The human still wins 43.4 % at p = 0.75 and 39.3 % at p = 0.6 (sim). The penalty only costs one roll's progress. | → D12 |
| S7 | Cells have hover/pointer styles but are not clickable | **Confirmed** (the die too) | → D13 |

### 2b. Defect table

| ID | Function | What goes wrong | How to reproduce | Severity |
|---|---|---|---|---|
| D1 | `resetGame` 3087, `movePlayer` 2687, `computerPlay` 2961, `endTurn` 2943 | Reset cancels nothing. The `async movePlayer` loop, its `sleep()`s, the `setTimeout(movePlayer)` in `rollDice`/`computerPlay`, and the 1 s `computerPlay` timer all keep running. Reset also sets `isAnimating = false` and re-enables the roll button while the old move is in flight. After the next `startGame()`, the old loop calls `animateToCell(currentPlayer, …)`, which looks up the **new** `players[currentPlayer].element`. It drags a token in the new game and then calls `endTurn()`, which skips a player. Two moves can then run at the same time. A pending computer turn also plays **behind** the setup screen, because `computerPlay` only checks `gameOver`/`isAnimating`, and both are false after reset. | Roll a 6 and press «Νέο Παιχνίδι» while the token is stepping. Press «Έναρξη» within ~2 s. A token in the new game moves on its own and the turn order is off by one. | Functional |
| D2 | `resetGame`, `showQuestionModal` 2785, CSS 807/1319 | Reset never closes `#questionModal`. If D1's leftover move lands on a question cell, the modal opens **behind** the setup screen (both use `z-index: 200`; setup comes later in the DOM). It becomes visible as soon as the new game starts, and `pendingMove` comes from the old game. A wrong answer teleports a new-game player to the old `previousPosition`, e.g. from 1 to 43. Also, the global `keypress` listener (2918) only checks whether the modal is active. Pressing Enter while typing a name on the setup screen submits the hidden question. | As D1, but the leftover move ends on a question cell. Type a name and press Enter, or start the game and answer the modal. | Functional |
| D3 | `showVictory` 3041, CSS 1242 | The victory overlay covers the whole screen (`z-index: 300`, `pointer-events: auto`) and has no button or click handler. «Νέο Παιχνίδι» cannot be reached after a win, so the only way out is to reload the page. | Win any game. | Functional |
| D4 | `submitAnswer` 2801, HTML 1782–1786 | Hidden modals use `opacity: 0` + `pointer-events: none`, so their controls are still **focusable**. The answer input also has `autofocus`. Tab reaches the hidden «✓ Απάντηση» button. Pressing Enter or Space runs `submitAnswer()` with the **stale** `currentQuestion`/`pendingMove`. The empty input counts as wrong, the earlier player is moved back to an old cell, and `endTurn()` runs an extra time, which skips the current player. Before any question has been asked, it throws `TypeError: Cannot read properties of null (reading 'answer')`. | After at least one question, press Tab until focus is on the invisible button, then press Space. | Functional |
| D5 | `submitAnswer` 2801, `keypress` listener 2918 | There is no "already answered" guard. Two calls would schedule two feedback timers, so `endTurn()` runs twice and the next player is skipped. In Chromium, the class is removed synchronously and `pointer-events: none` stops a second click, so Enter + click does **not** double-fire there. A browser that synthesises the button click *after* the document `keypress` handler would double-fire. **Not verified in a browser.** | (Theoretical) Focus the submit button and press Enter in such a browser. | Functional (latent) |
| D6 | `submitAnswer` 2802 | `parseInt('')` gives `NaN`, so an empty answer counts as wrong. A stray Enter costs the child the move. | Land on a question and press Enter without typing. | Fairness / UX |
| D7 | `movePlayer` 2692–2695 | When a roll overshoots 100, "Χρειάζεσαι ακριβώς N…" is overwritten in the same tick by `endTurn()`'s "Σειρά: …". The child never sees why nothing happened. | Stand on 97 and roll 4 or more. | UX |
| D8 | `getCellPosition` 2364, `drawConnections` 2375, CSS 187/1610 | (a) Below 900 px the cells are 45 px but `CELL_SIZE` is still 55, so the drawing is computed for a 577 px board shown on a 477 px board. (b) **On desktop too**, `.board-svg` is `position: absolute; inset 0; 100 %` of `.board-wrapper`, which has 15 px padding. The SVG is therefore 607 px across for a 577 px viewBox: 5.2 % scale with no 15 px offset. Snake heads and ladder ends drift by up to ~14 px at the board edges on desktop (¼ of a cell). Below 900 px the drift is ~13 px on a 45 px cell (30 %). Only the centre of the board lines up. | Compare where the snake head at 99 sits against the centre of cell 99. Then resize to under 900 px. | UX |
| D9 | CSS 1600–1634, `body { overflow-x: hidden }` 29 | The minimum board width is 477 + 2×15 + 2×20 + 2×20 = **587 px**. On a 375–430 px phone, `overflow-x: hidden` **clips** the right-hand columns instead of letting them scroll, so cells 1–100 are partly invisible. | Open the page at 390 px width. | UX |
| D10 | `generatePlayerSetups` 2202/2236, `createPlayerCards` 2352 | Names go raw into `value="${name}"` and `innerHTML`. A name with `"` breaks the input. A name like `<img src=x onerror=alert(1)>` runs script in the player card. The input is local only (self-XSS), but this is the kind of thing GitHub reviewers flag, and quotes in real names break the setup screen. Messages and the victory screen use `textContent` and are safe. | Name a player `Ά"ννα` and press «Νέο Παιχνίδι». Or use the `<img …>` name and start a game. | Security |
| D11 | `createBoard` 2598, legend 1755 | The legend shows a purple ✖️ "Ερώτηση Προπαίδειας!" style, but no cell carries a question marker. 67 of the 100 cells are question cells and they look the same as the rest. | Look at the board. | UX |
| D12 | `movePlayer` 2763, setup text 2220 | The computer never gets questions and never takes the penalty. Measured effect: it wins 56.6 % against a 75 %-accurate child (60.7 % against a 60 % child). The edge is real but moderate. | Sim: `--mode pve`. | Fairness |
| D13 | CSS 207/223, 471 | `.cell` has `cursor: pointer` and a lift-on-hover. `.dice` has `cursor: pointer`. Neither has a click handler, so children click them and nothing happens. | Hover or click a cell or the die. | UX |
| D14 | `setGameMode` 2157 | Choosing pve sets `playerCount = 2` without updating the count buttons. When you switch back to pvp, "4" is still highlighted but only 2 player forms appear. | pvp → 4 → pve → pvp. | UX |
| D15 | `updateEmojiAvailability` 2273 | In pve, `setupData[2].emoji` (🐼) still counts as taken, although the computer uses 🤖. The human cannot pick 🐼. | pve setup: 🐼 is greyed out. | UX |
| D16 | `showNeon67` 3024, `movePlayer` 2743/2754 | The 67 animation always blocks for 5.5 s and cannot be skipped. With a ladder it is 5.8 s, because the extra `sleep(300)` comes after it. | Land on 51 or 67. | UX |
| D17 | Game balance | The median is OK, but the tail is long. In 2-player games at p = 0.75, **10 % of games last over 30 min** and P99 is 54 min. In 4-player games, the median is 19 min and 18 % are over 30 min. | Sim, see §3. | Fairness |
| D18 | `resetGame` 3104–3105, `launchConfetti` 3057 | `generatePlayerSetups()` runs twice (`setGameMode` already calls it). The 200 confetti timers are not cancelled on reset. | Code. | Publishing |
| D19 | CSS 95/793/855/… | `'Fredoka One', cursive` falls back to **Comic Sans** (Windows) when Google Fonts is unavailable, e.g. on an offline classroom PC or a filtered school network. `Nunito, sans-serif` is fine. | Block fonts.googleapis.com. | Publishing |

### 2c. Other observations (not defects, recorded for Phase 2)
- The board config is valid. No cell is both a snake head and a ladder bottom. No end lands on another start. Cell 26 is both a snake tail (48→26) and a ladder top (15→26). That is harmless and is drawn as a snake tail.
- The die face mapping (`show-N` ↔ `face-N`) is correct for all 6 faces.
- `questionCells.includes()` is O(n) per landing. That is fine at this size, but a `Set` is cleaner.
- `Math.random()` is used in three places (die, question, computer). Phase 2 will route all three through one RNG function so the tests can seed it.

---

## 3. Baseline simulation (current rules)

`node tools/simulate.mjs` runs 20,000 games per scenario with seed 20261014. Reseeding moves the numbers by < 0.5 min.
"Turns" means individual turns by all players together. "Q per player" counts questions answered by each human per game. "Q per turn" counts questions per human turn; the floor is 0.50.

| Mode | Pl | p | Turns med / P90 / P99 | Rounds med | Minutes med / P90 / P99 | >30 min | Q per player | Q per turn | Human win |
|---|---|---|---|---|---|---|---|---|---|
| pvp | 2 | 0.6 | 71 / 164 / 296 | 36 | 15.0 / 35.3 / 64.0 | 15.3% | 29.2 | 0.67 | – |
| pvp | 2 | **0.75** | **64 / 141 / 253** | 32 | **13.3 / 30.0 / 53.8** | **10.0%** | 25.3 | 0.66 | – |
| pvp | 2 | 0.9 | 57 / 123 / 222 | 29 | 11.7 / 25.8 / 46.4 | 6.1% | 22.2 | 0.65 | – |
| pvp | 3 | 0.6 | 86 / 179 / 314 | 29 | 18.2 / 38.6 / 67.7 | 19.6% | 22.5 | 0.67 | – |
| pvp | 3 | 0.75 | 77 / 155 / 269 | 26 | 16.2 / 32.9 / 56.7 | 13.3% | 19.7 | 0.66 | – |
| pvp | 3 | 0.9 | 71 / 138 / 230 | 24 | 14.7 / 28.8 / 48.0 | 8.5% | 17.5 | 0.65 | – |
| pvp | 4 | 0.6 | 100 / 194 / 329 | 25 | 21.1 / 41.7 / 71.1 | 25.6% | 19.0 | 0.67 | – |
| pvp | 4 | 0.75 | 91 / 171 / 283 | 23 | 19.1 / 36.3 / 60.3 | 18.4% | 16.9 | 0.66 | – |
| pvp | 4 | 0.9 | 84 / 154 / 246 | 21 | 17.3 / 32.1 / 51.9 | 12.6% | 15.1 | 0.65 | – |
| pve | 2 | 0.6 | 62 / 134 / 240 | 31 | 9.4 / 20.6 / 37.1 | 2.6% | 24.9 | 0.67 | 39.3% |
| pve | 2 | 0.75 | 58 / 126 / 225 | 29 | 8.7 / 19.1 / 34.4 | 1.9% | 23.1 | 0.66 | 43.4% |
| pve | 2 | 0.9 | 56 / 120 / 212 | 28 | 8.4 / 17.9 / 32.0 | 1.3% | 21.8 | 0.65 | 47.9% |

Against the Phase 3 targets (2 players, p = 0.75):

| Target | Baseline | Status |
|---|---|---|
| median 12–18 min (and ≥ 10) | 13.3 | ✅ |
| P90 ≤ 25 min | 30.0 | ❌ |
| < 3 % over 30 min | 10.0 % | ❌ |
| 4 players: median ≤ 30 min | 19.1 | ✅ |
| pve: human wins 40–60 % | 43.4 % | ✅ (just) |
| ≥ 0.5 questions per human turn | 0.66 | ✅ (room to spare) |

**What this means:** a typical game is not too long. The problem is the **tail**. About one game in ten runs past 30 minutes, and that is the game the teacher remembers. The drivers are the exact-finish rule (on 95–99 most rolls are wasted), the late snakes (99→54, 95→75, 87→24) and the wrong-answer penalty. Phase 3 should cut the tail without moving the median much.

### Time model
| Item | Seconds | Source |
|---|---|---|
| Child presses "Ρίξε" | 2.0 | **assumption** |
| Computer "thinking" | 1.8 | `endTurn` 1000 + `computerPlay` 800 |
| Die | 1.5 | 1000 spin + 500 |
| Per step | 0.45 | 300 animation + 150 |
| Plain landing | 0.3 | `sleep(300)` |
| Snake / ladder | 2.4 | 300 + 1500 overlay + 300 slide + 300 |
| Cell 67 | 5.5 (+0.3 via ladder) | `sleep(5500)` |
| Child answers | 8.0 | **assumption** (brief) |
| Correct / wrong feedback | 2.5 / 3.3 | 2000 + 500 / 2500 + 300 + 500 |

The two assumptions dominate. A class that takes 15 s per answer adds roughly 40 % to every human-turn time. Turn counts do not depend on the timing model, so Phase 3 will check turn targets as well as minute targets.
