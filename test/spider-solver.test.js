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

function replay(state, plan, forbiddenKeys = []) {
  for (const action of plan) {
    if (action.type === 'deal') state = rules.dealNextRound(state);
    else {
      const legal = rules.legalMoves(state).find(move => move.fromCol === action.fromCol &&
        move.fromIndex === action.fromIndex && move.toCol === action.toCol);
      assert.ok(legal, 'each returned action must be legal on its actual predecessor');
      state = rules.applyMove(state, legal);
    }
    assert.ok(state, 'a replayed stock action must be legal');
    assert.equal(forbiddenKeys.includes(SpiderSolver.canonicalKey(state)), false,
      'an independent continuation must not undo its opening back to the original position');
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

test('a verified reference solution maps actual column permutations before replaying its route', () => {
  const referenceState = {
    cols: [Array.from({ length: 12 }, (_, index) => up(13 - index)), [up(1)], [], [], [], [], [], [], [], []],
    stock: [], completed: 7
  };
  const referencePlan = [{ type: 'move', fromCol: 1, fromIndex: 0, toCol: 0 }];
  const state = { cols: referenceState.cols.slice(2).concat(referenceState.cols.slice(0, 2)), stock: [], completed: 7 };
  const snapshot = JSON.stringify({ state, referenceState, referencePlan });
  const result = solver.solve(state, { referenceState, referencePlan, nodeLimit: 1, timeLimitMs: 500 });
  assert.equal(result.status, 'solved');
  assert.equal(result.plan[0].fromCol, 9, 'the actual Ace is in the permuted column');
  assert.equal(result.plan[0].toCol, 8, 'the actual King run is in the other permuted column');
  assert.equal(replay(state, result.plan).completed, 8);
  assert.equal(JSON.stringify({ state, referenceState, referencePlan }), snapshot, 'reference reuse must not mutate either board');
});

test('reference column mappings preserve the future stock assigned to every physical column', () => {
  let random = 19;
  const generated = rules.createSolvableDeal(max => ((random = (random * 1664525 + 1013904223) >>> 0) % max));
  const referenceState = generated.state;
  const state = {
    cols: referenceState.cols.slice().reverse(),
    stock: referenceState.stock.slice().reverse(),
    completed: referenceState.completed
  };
  const wrongStockAssignment = { ...state, stock: referenceState.stock.slice() };
  assert.equal(SpiderSolver.canonicalKey(state), SpiderSolver.canonicalKey(referenceState));
  assert.notEqual(SpiderSolver.canonicalKey(wrongStockAssignment), SpiderSolver.canonicalKey(referenceState));
  const result = solver.solve(state, {
    referenceState, referencePlan: generated.plan, nodeLimit: 1, timeLimitMs: 800, maxDepth: 800
  });
  assert.equal(result.status, 'solved', 'a true stock-preserving permutation should reuse the fully verified route');
  const won = replay(state, result.plan);
  assert.equal(won.completed, 8);
  assert.equal(won.stock.length, 0);
  assert.ok(won.cols.every(col => !col.length));
  const wrong = solver.solve(wrongStockAssignment, {
    referenceState, referencePlan: generated.plan, nodeLimit: 1, timeLimitMs: 800, maxDepth: 800
  });
  assert.notEqual(wrong.status, 'solved', 'matching current cards alone must not reuse a route with different future deals');
});

test('invalid reference actions and forbidden positions cannot manufacture a winning proof', () => {
  const blocked = { cols: Array.from({ length: 10 }, () => [up(13)]), stock: [], completed: 0 };
  const invalid = solver.solve(blocked, {
    referenceState: blocked,
    referencePlan: [{ type: 'move', fromCol: 0, fromIndex: 0, toCol: 1 }]
  });
  assert.equal(invalid.status, 'dead-end', 'an illegal reference move must be rejected before indexing');
  assert.equal(invalid.plan.length, 0);
  const state = {
    cols: [Array.from({ length: 12 }, (_, index) => up(13 - index)), [up(1)], [], [], [], [], [], [], [], []],
    stock: [], completed: 7
  };
  const referencePlan = [{ type: 'move', fromCol: 1, fromIndex: 0, toCol: 0 }];
  const won = replay(state, referencePlan);
  const result = solver.solve(state, {
    referenceState: state, referencePlan, forbiddenKeys: [SpiderSolver.canonicalKey(won)], nodeLimit: 1000, timeLimitMs: 500
  });
  assert.equal(result.status, 'unknown', 'a restricted search must not claim the underlying game is a dead end');
  assert.equal(result.plan.length, 0, 'a forbidden position must be checked inside a reused continuation');
});

test('generated games support three distinct independently solved opening branches', () => {
  for (let seed = 1; seed <= 5; seed++) {
    let random = seed;
    const generated = rules.createSolvableDeal(max => ((random = (random * 1664525 + 1013904223) >>> 0) % max));
    const state = generated.state;
    const initialSnapshot = JSON.stringify(state);
    const proof = replay(state, generated.plan);
    assert.equal(proof.completed, 8, `seed ${seed} should have a complete generated proof`);
    const positions = new Map();
    const forbiddenKeys = [SpiderSolver.canonicalKey(state)];
    for (const move of rules.legalMoves(state)) {
      const next = rules.applyMove(state, move);
      positions.set(SpiderSolver.canonicalKey(next), next);
    }
    assert.ok(positions.size >= 3, `seed ${seed} opening choices must lead to genuinely different positions`);
    let solved = 0;
    const outcomes = [];
    for (const next of [...positions.values()].slice(0, 16)) {
      const snapshot = JSON.stringify(next);
      const result = solver.solve(next, {
        referenceState: state, referencePlan: generated.plan, forbiddenKeys,
        timeLimitMs: 800, nodeLimit: 30000, maxDepth: 800
      });
      outcomes.push(result.status);
      assert.equal(JSON.stringify(next), snapshot, 'searching an alternative must not rewrite cards');
      if (result.status !== 'solved') continue;
      const won = replay(next, result.plan, forbiddenKeys);
      assert.equal(won.completed, 8, `seed ${seed} each claimed solution must collect every run`);
      assert.equal(won.stock.length, 0);
      assert.ok(won.cols.every(col => col.length === 0));
      solved++;
      if (solved === 3) break;
    }
    assert.equal(solved, 3,
      `seed ${seed} needs three independently proved continuations; search outcomes: ${outcomes.join(', ')}`);
    assert.equal(JSON.stringify(state), initialSnapshot, 'testing alternatives must leave the original game intact');
  }
});
