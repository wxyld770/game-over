const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'games', 'spider.html'), 'utf8');
const context = vm.createContext({});
for (const id of ['spiderSolver', 'spiderRules']) {
  const script = html.match(new RegExp('<script\\s+id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'));
  assert.ok(script, `Spider page must contain ${id}`);
  new vm.Script(script[1], { filename: id + '.js' }).runInContext(context);
}
const SpiderSolver = context.SpiderSolver;
const rules = context.SpiderPlanner;
const solver = SpiderSolver.create(rules);
const up = r => ({ r, up: true });

function replay(state, plan) {
  for (const action of plan) {
    if (action.type === 'deal') state = rules.dealNextRound(state);
    else {
      const legal = rules.legalMoves(state).find(move => move.fromCol === action.fromCol &&
        move.fromIndex === action.fromIndex && move.toCol === action.toCol);
      assert.ok(legal, 'each returned action must be legal on its actual predecessor');
      state = rules.applyMove(state, legal);
    }
  }
  return state;
}

test('solver proves and replays complete collection without mutating its input', () => {
  const state = {
    cols: [Array.from({ length: 12 }, (_, index) => up(13 - index)), [up(1)], [], [], [], [], [], [], [], []],
    stock: [], completed: 7
  };
  const snapshot = JSON.stringify(state);
  const result = solver.solve(state);
  assert.equal(result.status, 'solved');
  assert.equal(result.plan.length, 1);
  const won = replay(state, result.plan);
  assert.equal(won.completed, 8);
  assert.ok(won.cols.every(col => col.length === 0));
  assert.equal(JSON.stringify(state), snapshot);
});

test('solver proves a blocked valid eight-run state is a dead end', () => {
  const tops = [...Array(8).fill(13), 11, 11];
  const ranks = Array.from({ length: 8 }, () => Array.from({ length: 13 }, (_, i) => i + 1)).flat();
  for (const rank of tops) ranks.splice(ranks.indexOf(rank), 1);
  const cols = Array.from({ length: 10 }, () => []);
  ranks.forEach((r, i) => cols[i % 10].push({ r, up: false }));
  tops.forEach((r, i) => cols[i].push(up(r)));
  const state = { cols, stock: [], completed: 0 };
  assert.equal(rules.isValidState(state), true);
  assert.equal(rules.legalMoves(state).length, 0);
  const result = solver.solve(state);
  assert.equal(result.status, 'dead-end');
  assert.deepEqual(Array.from(result.plan), []);
});

test('node and depth budgets report unknown rather than inventing a proof', () => {
  const state = {
    cols: [Array.from({ length: 11 }, (_, i) => up(13 - i)), [up(2)], [up(1)], [], [], [], [], [], [], []],
    stock: [], completed: 7
  };
  assert.equal(solver.solve(state, { nodeLimit: 1 }).status, 'unknown');
  assert.equal(solver.solve(state, { maxDepth: 1 }).status, 'unknown');
  const result = solver.solve(state, { nodeLimit: 1000 });
  assert.equal(result.status, 'solved');
  assert.equal(replay(state, result.plan).completed, 8);
});

test('search explores a legal stock action even while ordinary moves exist', () => {
  const initial = { cols: [[up(2)], [up(1)]], stock: [13, 13], completed: 7 };
  const reachedByMove = { cols: [[up(2), up(1)], []], stock: [13, 13], completed: 7 };
  const won = { cols: [[], []], stock: [], completed: 8 };
  let deals = 0;
  const injected = SpiderSolver.create({
    legalMoves: state => state === initial ? [{ fromCol: 1, fromIndex: 0, toCol: 0 }] : [],
    applyMove: () => reachedByMove,
    dealNextRound: state => { deals++; return state === initial ? won : null; }
  });
  const result = injected.solve(initial);
  assert.equal(result.status, 'solved');
  assert.deepEqual(JSON.parse(JSON.stringify(result.plan)), [{ type: 'deal' }]);
  assert.ok(deals > 0);
});

test('canonicalization preserves fixed stock assignments and removes true column permutations', () => {
  const left = { cols: [[up(1)], [up(2)]], stock: [13, 12], completed: 0 };
  const wrongStockAssignment = { cols: [[up(2)], [up(1)]], stock: [13, 12], completed: 0 };
  const sameFuturePosition = { cols: [[up(2)], [up(1)]], stock: [12, 13], completed: 0 };
  assert.notEqual(SpiderSolver.canonicalKey(left), SpiderSolver.canonicalKey(wrongStockAssignment));
  assert.equal(SpiderSolver.canonicalKey(left), SpiderSolver.canonicalKey(sameFuturePosition));
  assert.equal(SpiderSolver.canonicalKey({ ...left, stock: [] }),
    SpiderSolver.canonicalKey({ ...wrongStockAssignment, stock: [] }));
});

test('generated games have several independently verified free-form opening solutions', () => {
  for (let seed = 1; seed <= 6; seed++) {
    let random = seed;
    const state = rules.createSolvableDeal(max => ((random = (random * 1664525 + 1013904223) >>> 0) % max)).state;
    const initial = solver.solve(state, { timeLimitMs: 2000, nodeLimit: 20000 });
    assert.equal(initial.status, 'solved', `seed ${seed} should have a complete searched solution`);
    assert.equal(replay(state, initial.plan).completed, 8);
    const positions = new Map();
    for (const move of rules.legalMoves(state)) {
      const next = rules.applyMove(state, move);
      positions.set(SpiderSolver.canonicalKey(next), next);
    }
    assert.ok(positions.size >= 3, 'opening choices must lead to different positions');
    for (const next of [...positions.values()].slice(0, 3)) {
      const result = solver.solve(next, { timeLimitMs: 2000, nodeLimit: 20000 });
      assert.equal(result.status, 'solved', `seed ${seed} free-form move must permit a complete win`);
      const won = replay(next, result.plan);
      assert.equal(won.completed, 8);
      assert.equal(won.stock.length, 0);
      assert.ok(won.cols.every(col => col.length === 0));
    }
  }
});
