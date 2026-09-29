const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const spiderPath = path.resolve(__dirname, '..', 'public', 'games', 'spider.html');
const html = fs.readFileSync(spiderPath, 'utf8');

function loadPlanner() {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const source = scripts.find(script => script.includes('globalThis.SpiderPlanner'));
  assert.ok(source, 'spider page should expose its pure planning engine');
  const context = vm.createContext({});
  new vm.Script(source, { filename: 'spider-planner.js' }).runInContext(context);
  return context.SpiderPlanner;
}

const planner = loadPlanner();
const up = r => ({ r, up: true });
const down = r => ({ r, up: false });

test('dynamic planner ranks several continuations without mutating the board', () => {
  const state = {
    cols: [
      [down(8), up(5)], [up(6)], [up(4)], [up(5)], [up(6)],
      [up(7)], [up(3)], [up(4)], [up(8)], [up(9)]
    ],
    stock: [],
    completed: 0
  };
  const before = JSON.stringify(state);
  const result = planner.analyze(state, { depth: 4, breadth: 24, nodeLimit: 2200 });

  assert.ok(result.moves.length >= 4, 'the position should expose multiple legal continuations');
  assert.ok(result.routeCount >= 2, 'the search should retain more than one viable branch');
  assert.ok(result.nodes > 0, 'the result should come from a look-ahead search');
  assert.ok(result.moves.every(move => Number.isFinite(move.value) && move.futureRoutes >= 1));
  assert.equal(result.moves[0].fromCol, 0, 'revealing a hidden card should outrank a cosmetic merge');
  assert.equal(JSON.stringify(state), before, 'planning must be side-effect free');
});

test('moving the ace onto a complete descending run collects the sequence', () => {
  const descendingToTwo = Array.from({ length: 12 }, (_, index) => up(13 - index));
  const state = {
    cols: [descendingToTwo, [up(1)], [], [], [], [], [], [], [], []],
    stock: [],
    completed: 0
  };
  const move = planner.legalMoves(state).find(candidate => candidate.fromCol === 1 && candidate.toCol === 0);
  assert.ok(move, 'ace should be movable onto the two');

  const next = planner.applyMove(state, move);
  assert.equal(next.completed, 1);
  assert.equal(next.cols[0].length, 0);
  assert.equal(state.completed, 0, 'simulation must not collect cards on the source state');
});

test('adaptive reveal evaluates only ranks still hidden from the player', () => {
  const state = {
    cols: [
      [down(9)], [up(13)], [up(12)], [up(11)], [up(10)],
      [up(8)], [up(7)], [up(6)], [up(5)], [up(4)]
    ],
    stock: [1, 2, 2, 3, 3, 4, 7, 8, 9, 10],
    completed: 0
  };
  const allowed = new Set([1, 2, 3, 4, 7, 8, 9, 10]);
  const choices = planner.rankRevealChoices(state, 0);

  assert.ok(choices.length >= 5);
  assert.equal(new Set(choices.map(choice => choice.rank)).size, choices.length);
  assert.ok(choices.every(choice => allowed.has(choice.rank)));
  assert.ok(choices[0].routeCount >= choices[choices.length - 1].routeCount);
});

test('adaptive stock planning preserves the remaining rank multiset', () => {
  const state = {
    cols: [[up(13)], [up(12)], [up(11)], [up(10)], [up(9)], [up(8)], [up(7)], [up(6)], [up(5)], [up(4)]],
    stock: [],
    completed: 0
  };
  for (let copy = 0; copy < 4; copy++) {
    for (let rank = 1; rank <= 12; rank++) state.stock.push(rank);
  }
  state.stock.push(13, 13);
  const before = JSON.stringify(state);
  const first = Array.from(planner.planDeal(state));
  const second = Array.from(planner.planDeal(state));

  assert.equal(first.length, 10);
  assert.deepEqual(first, second, 'the same visible state should produce a stable plan');
  const available = state.stock.reduce((counts, rank) => counts.set(rank, (counts.get(rank) || 0) + 1), new Map());
  for (const rank of first) available.set(rank, available.get(rank) - 1);
  assert.ok([...available.values()].every(count => count >= 0), 'a deal cannot invent a rank');
  assert.equal(JSON.stringify(state), before, 'deal planning must not consume stock before the player deals');
});

test('page wires reveal, deal and hints through the dynamic planner', () => {
  assert.match(html, /SpiderPlanner\.rankRevealChoices\(game, colIndex\)/);
  assert.match(html, /SpiderPlanner\.planDeal\(game\)/);
  assert.match(html, /SpiderPlanner\.analyze\(game,/);
  assert.doesNotMatch(html, /game\.stock\.pop\(\), up: true/);
  assert.match(html, /优先保留多条可继续路线/);
});
