const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const spiderPath = path.resolve(__dirname, '..', 'public', 'games', 'spider.html');
const html = fs.readFileSync(spiderPath, 'utf8');

function loadPlanner() {
  const context = vm.createContext({});
  for (const id of ['spiderSolver', 'spiderRules']) {
    const source = html.match(new RegExp('<script id="' + id + '">([\\s\\S]*?)<\\/script>'));
    assert.ok(source, `spider page must include its ${id} engine`);
    new vm.Script(source[1], { filename: id + '.js' }).runInContext(context);
  }
  return context.SpiderPlanner;
}

const planner = loadPlanner();
const up = r => ({ r, up: true });
const down = r => ({ r, up: false });

function seededRandom(seed) {
  let value = seed >>> 0;
  return max => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value % max;
  };
}

function rankCounts(state) {
  const counts = Array(14).fill(state.completed);
  for (const rank of state.stock) counts[rank]++;
  for (const col of state.cols) for (const card of col) counts[card.r]++;
  return counts.slice(1);
}

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

test('dynamic fallback excludes moves that immediately return to recent positions', () => {
  const previous = {
    cols: [
      [up(7), up(6)], [up(8)], [up(5)], [up(6)], [up(9)],
      [up(10)], [up(4)], [up(3)], [up(2)], [up(1)]
    ],
    stock: [],
    completed: 0
  };
  const forward = planner.legalMoves(previous).find(move =>
    move.fromCol === 0 && move.fromIndex === 0 && move.toCol === 1);
  assert.ok(forward);
  const current = planner.applyMove(previous, forward);
  const reverse = planner.legalMoves(current).find(move =>
    move.fromCol === 1 && move.fromIndex === 1 && move.toCol === 0);
  assert.ok(reverse, 'the immediate reversal should be legal before history filtering');

  const candidates = Array.from(planner.nonRepeatingMoves(current, [previous], {
    depth: 3,
    breadth: 24,
    nodeLimit: 1400
  }));

  assert.ok(candidates.length > 0, 'the fallback should retain other playable moves');
  assert.equal(candidates.some(move => move.fromCol === reverse.fromCol &&
    move.fromIndex === reverse.fromIndex && move.toCol === reverse.toCol), false);
  assert.equal(planner.stateKey(planner.applyMove(current, reverse)), planner.stateKey(previous));
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

test('stock planning preserves the fixed next round without mutating it', () => {
  const state = {
    cols: [[up(13)], [up(12)], [up(11)], [up(10)], [up(9)], [up(8)], [up(7)], [up(6)], [up(5)], [up(4)]],
    stock: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4],
    completed: 0
  };
  const before = JSON.stringify(state);
  const first = Array.from(planner.planDeal(state));
  const second = Array.from(planner.planDeal(state));

  assert.deepEqual(first, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(first, second, 'the same visible state should produce a stable plan');
  assert.equal(JSON.stringify(state), before, 'deal planning must not consume stock before the player deals');
});

test('stock cannot be dealt into an empty column or consumed more than once', () => {
  const state = {
    cols: Array.from({ length: 10 }, (_, index) => index === 3 ? [] : [up(index + 1)]),
    stock: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    completed: 0
  };
  const snapshot = JSON.stringify(state);
  assert.equal(planner.dealNextRound(state), null, 'fill every column before dealing');
  assert.equal(JSON.stringify(state), snapshot, 'an unavailable deal must not consume or replace any card');
  state.cols[3].push(up(13));
  const next = planner.dealNextRound(state);
  assert.ok(next);
  assert.equal(next.stock.length, 0);
  assert.deepEqual(Array.from(next.cols, col => col.at(-1).r), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(planner.dealNextRound(next), null, 'only one round of stock is available');
});

test('randomized eight-run deals conserve every card and replay a complete winning proof', () => {
  assert.equal(planner.config.TARGET_RUNS, 8);
  assert.equal(planner.config.TOTAL_CARDS, 104);
  assert.equal(planner.config.INITIAL_CARDS, 94);
  assert.equal(planner.config.DEAL_ROUNDS, 1);
  const layouts = new Set();
  const stockLayouts = new Set();
  let hiddenAces = 0;
  let revealedAces = 0;

  for (let seed = 1; seed <= 30; seed++) {
    const generated = planner.createSolvableDeal(seededRandom(seed));
    let state = generated.state;
    const initialSnapshot = JSON.stringify(state);
    layouts.add(state.cols.map(col => col.map(card => card.r).join(',')).sort().join('|'));
    stockLayouts.add(state.stock.join(','));
    assert.equal(state.cols.reduce((sum, col) => sum + col.length, 0), 94, `seed ${seed} should start with 94 cards`);
    assert.equal(state.stock.length, 10, `seed ${seed} should reserve one deal round`);
    assert.deepEqual(rankCounts(state), Array(13).fill(8), `seed ${seed} should contain eight of every rank`);
    assert.ok(new Set(state.stock).size >= 4, `seed ${seed} stock must mix at least four ranks`);
    assert.ok(state.cols.flat().filter(card => card.r === 13).length >= 5,
      `seed ${seed} must keep most Kings on the table instead of reserving them for stock`);
    assert.ok(state.cols.filter(col => col.some(card => card.r === 1)).length >= 3,
      `seed ${seed} Aces should be spread across several columns`);
    const adjacentPairs = state.cols.reduce((sum, col) => sum + Math.max(0, col.length - 1), 0);
    const descendingPairs = state.cols.reduce((sum, col) => sum + col.slice(1)
      .filter((card, index) => col[index].r === card.r + 1).length, 0);
    assert.ok(descendingPairs <= adjacentPairs / 2,
      `seed ${seed} must contain genuinely mixed columns, rather than reordered complete descending runs`);
    assert.ok(state.cols.flat().filter(card => !card.up).length >= 20, `seed ${seed} should retain enough cards to uncover`);
    assert.ok(state.cols.flat().some(card => card.r === 1 && card.up), `seed ${seed} should not hide every Ace`);
    assert.equal(state.cols.every(col => col.length > 0 && col.at(-1).up), true);
    assert.equal(planner.isValidState(state), true);
    const openings = Array.from(planner.legalMoves(state));
    const nextPositions = new Set(openings.map(move => planner.canonicalKey(planner.applyMove(state, move))));
    assert.ok(nextPositions.size >= 3, `seed ${seed} should offer at least three distinct opening positions`);
    assert.ok(new Set(openings.map(move => state.cols[move.fromCol][move.fromIndex].r)).size >= 2,
      `seed ${seed} choices should involve different ranks`);
    assert.equal(generated.plan.filter(action => action.type === 'deal').length, 1);
    hiddenAces += state.cols.flat().filter(card => card.r === 1 && !card.up).length;

    for (const action of generated.plan) {
      const acesBefore = state.cols.flat().filter(card => card.r === 1 && !card.up).length;
      if (action.type === 'deal') {
        assert.deepEqual(Array.from(planner.planDeal(state)), Array.from(state.stock.slice(-10)).reverse(),
          `seed ${seed} must preserve the original stock order`);
        state = planner.dealNextRound(state);
        assert.ok(state, `seed ${seed} should allow its planned deal`);
        assert.equal(state.stock.length, 0);
        assert.equal(planner.dealNextRound(state), null, 'a second stock round must be impossible');
      } else {
        const move = Array.from(planner.legalMoves(state)).find(candidate => candidate.fromCol === action.fromCol &&
          candidate.fromIndex === action.fromIndex && candidate.toCol === action.toCol);
        assert.ok(move, `seed ${seed} solution move must remain legal`);
        state = planner.applyMove(state, move);
      }
      const acesAfter = state.cols.flat().filter(card => card.r === 1 && !card.up).length;
      revealedAces += Math.max(0, acesBefore - acesAfter);
      assert.equal(planner.isValidState(state), true, `seed ${seed} must conserve cards after every action`);
      assert.deepEqual(rankCounts(state), Array(13).fill(8));
      assert.equal(state.cols.every(col => !col.length || col.at(-1).up), true,
        `seed ${seed} must expose the new top card after a move or collection`);
    }

    assert.equal(state.completed, 8, `seed ${seed} should collect all eight runs`);
    assert.equal(state.stock.length, 0);
    assert.ok(state.cols.every(col => col.length === 0));
    const replayed = planner.replayPlan(generated.state, generated.plan);
    assert.ok(replayed && replayed.completed === 8 && replayed.cols.every(col => !col.length),
      `seed ${seed} replay proof should reach the win`);
    assert.equal(JSON.stringify(generated.state), initialSnapshot, 'proof playback must not rewrite the initial deal');
  }

  assert.ok(layouts.size >= 25, 'different seeds must vary the actual rank layout, even after ignoring column order');
  assert.ok(stockLayouts.size >= 20, 'the sole stock round must vary across games');
  assert.ok(hiddenAces > 0, 'Aces must not be forced into identical visible starting positions');
  assert.equal(revealedAces, hiddenAces, 'every initially hidden Ace must become available along the full winning proof');
});

test('solver distinguishes a blocked board from an incomplete budget and includes stock transitions', () => {
  const generated = planner.createSolvableDeal(seededRandom(7));
  const limited = planner.solve(generated.state, { nodeLimit: 1, timeLimitMs: 500 });
  assert.equal(limited.status, 'unknown');
  assert.equal(limited.plan.length, 0);
  const full = planner.solve(generated.state, {
    referenceState: generated.state, referencePlan: generated.plan,
    nodeLimit: 20000, timeLimitMs: 500, maxDepth: 800
  });
  assert.equal(full.status, 'solved');
  assert.ok(full.plan.some(action => action.type === 'deal'));
  const won = planner.replayPlan(generated.state, full.plan);
  assert.ok(won && won.completed === 8);
  const blocked = { cols: Array.from({ length: 10 }, () => [down(1), up(13)]), stock: [], completed: 0 };
  assert.equal(planner.legalMoves(blocked).length, 0);
  const dead = planner.solve(blocked, { nodeLimit: 20000, timeLimitMs: 500 });
  assert.equal(dead.status, 'dead-end');
  assert.equal(dead.plan.length, 0);
});

test('planner state keys retain stock assignments when columns move', () => {
  const left = { cols: [[up(1)], [up(2)]], stock: [13, 12], completed: 0 };
  const columnsSwapped = { ...left, cols: [[up(2)], [up(1)]] };
  const futureSwapped = { ...columnsSwapped, stock: [12, 13] };
  assert.notEqual(planner.canonicalKey(left), planner.canonicalKey(columnsSwapped));
  assert.equal(planner.canonicalKey(left), planner.canonicalKey(futureSwapped));
  assert.notEqual(planner.stateKey(left), planner.stateKey(columnsSwapped));
  assert.equal(planner.canonicalKey({ ...left, stock: [] }),
    planner.canonicalKey({ ...columnsSwapped, stock: [] }));
});

test('legacy four-run saves are rejected by the eight-run invariant and use a new storage version', () => {
  const oldState = { cols: Array.from({ length: 10 }, () => []), stock: [], completed: 0 };
  let col = 0;
  for (let copy = 0; copy < 4; copy++) {
    for (let rank = 1; rank <= 13; rank++) {
      oldState.cols[col++ % 10].push(up(rank));
    }
  }
  assert.equal(planner.isValidState(oldState), false);
  assert.match(html, /const STORE_KEY = "game-over-spider-one-suit-v5"/);
  assert.match(html, /LEGACY_STORE_KEYS = \["game-over-spider-one-suit-v1", "game-over-spider-one-suit-v2", "game-over-spider-one-suit-v3", "game-over-spider-one-suit-v4"\]/);
  assert.match(html, /LEGACY_STORE_KEYS\.forEach\(key => localStorage\.removeItem\(key\)\)/);
});

test('page keeps fixed cards and uses background search for optional hints', () => {
  assert.match(html, /SpiderPlanner\.createSolvableDeal\(randomIndex\)/);
  assert.match(html, /SpiderPlanner\.replayPlan\(generated\.state, generated\.plan\)/);
  assert.match(html, /SpiderPlanner\.dealNextRound\(before\)/);
  assert.match(html, /new Worker\(workerUrl\)/);
  assert.match(html, /new Blob\(/);
  assert.doesNotMatch(html, /target\.r =/);
  assert.doesNotMatch(html, /lastIndexOf\(plannedRank\)/);
  const clientScript = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(script => script.includes('const STORE_KEY'));
  assert.doesNotMatch(clientScript, /SpiderPlanner\.readyCertificateActions\(/);
  assert.match(clientScript, /performAction\(/);
  assert.doesNotMatch(clientScript, /牌已留在原位|正在确认这一步之后的完整收牌路线/);
  assert.match(clientScript, /game\.solution/);
  assert.match(clientScript, /status === "solved"/);
  assert.match(clientScript, /unknown/);
});

test('pointer dragging keeps an origin placeholder and renders the complete moving run', () => {
  assert.match(html, /sourceCards\.forEach\(card =>/);
  assert.match(html, /card\.classList\.add\("is-drag-origin"\)/);
  assert.match(html, /document\.body\.appendChild\(preview\)/);
  assert.match(html, /board\.addEventListener\("pointercancel", cancelPointerDrag\)/);
  assert.match(html, /window\.addEventListener\("blur", cancelPointerDrag\)/);
  assert.match(html, /\.card\.face-up \{ cursor: grab; touch-action: none;/);
  assert.doesNotMatch(html, /event\.pointerType === "touch" \|\|/);
  assert.doesNotMatch(html, /addEventListener\("dragstart"/);
  assert.doesNotMatch(html, /element\.draggable = pickable/);
});

test('the complete visible column is a drop target and free play keeps useful hints', () => {
  assert.match(html, /\.column \{[^}]*min-height: var\(--board-min-h\)/);
  assert.match(html, /const boardRect = board\.getBoundingClientRect\(\)/);
  assert.match(html, /if \(x >= rect\.left && x <= rect\.right\) return Number\(candidate\.dataset\.col\)/);
  assert.doesNotMatch(html, /建议撤销最近的自由移动，回到可以完整收完的路线/);
});
