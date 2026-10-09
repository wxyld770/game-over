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

test('eight-run deals keep six Aces visible and replay through the only stock round to a complete win', () => {
  assert.equal(planner.config.TARGET_RUNS, 8);
  assert.equal(planner.config.TOTAL_CARDS, 104);
  assert.equal(planner.config.INITIAL_CARDS, 94);
  assert.equal(planner.config.DEAL_ROUNDS, 1);

  for (let seed = 1; seed <= 40; seed++) {
    const generated = planner.createSolvableDeal(seededRandom(seed));
    let state = generated.state;
    assert.equal(state.cols.reduce((sum, col) => sum + col.length, 0), 94, `seed ${seed} should start with 94 cards`);
    assert.equal(state.stock.length, 10, `seed ${seed} should reserve one deal round`);
    assert.deepEqual(rankCounts(state), Array(13).fill(8), `seed ${seed} should contain eight of every rank`);
    const hiddenCount = state.cols.flat().filter(card => !card.up).length;
    assert.ok(hiddenCount >= 30 && hiddenCount <= 60, `seed ${seed} should have varied hidden prefixes`);
    assert.equal(state.cols.flat().filter(card => card.r === 1 && card.up).length, 6,
      `seed ${seed} should show six playable Aces immediately`);
    assert.equal(state.cols.flat().some(card => card.r === 1 && !card.up), false,
      `seed ${seed} must not bury any Ace`);
    assert.equal(state.stock.filter(rank => rank === 1).length, 2);
    const cores = state.cols.filter(col => col.some(card => !card.up));
    assert.equal(cores.length, 6);
    for (const core of cores) {
      const prefix = core.filter(card => !card.up).length;
      assert.ok(prefix >= 5 && prefix <= 10);
      assert.equal(core.length, 12);
      assert.ok(core.every((card, index) => card.r === 12 - index), 'revealed tails should return to their descending predecessor');
    }
    assert.equal(generated.plan.filter(action => action.type === 'deal').length, 1);
    assert.equal(state.cols.every(col => col.length > 0), true);
    assert.equal(planner.isValidState(state), true);

    for (const action of generated.plan) {
      if (action.type === 'deal') {
        const planned = Array.from(planner.planDeal(state));
        assert.deepEqual(planned, Array.from(state.stock.slice(-10)).reverse(), `seed ${seed} must keep stock order fixed`);
        state = planner.dealNextRound(state);
        assert.ok(state, `seed ${seed} should allow its planned deal`);
        assert.equal(state.stock.length, 0);
        assert.equal(planner.dealNextRound(state), null, 'a second stock round must be impossible');
      } else {
        const legal = Array.from(planner.legalMoves(state));
        const move = legal.find(candidate => candidate.fromCol === action.fromCol &&
          candidate.fromIndex === action.fromIndex && candidate.toCol === action.toCol);
        assert.ok(move, `seed ${seed} solution move must remain legal`);
        state = planner.applyMove(state, move);
      }
      assert.equal(planner.isValidState(state), true, `seed ${seed} must conserve cards after every action`);
      assert.deepEqual(rankCounts(state), Array(13).fill(8));
    }

    assert.equal(state.completed, 8, `seed ${seed} should collect all eight runs`);
    assert.equal(state.stock.length, 0);
    assert.ok(state.cols.every(col => col.length === 0));
    const replayed = planner.replayPlan(generated.state, generated.plan);
    assert.ok(replayed && replayed.completed === 8, `seed ${seed} replay proof should reach the win`);
  }
});

test('generator proof starts with stock, allows either bootstrap collection, and finishes all eight runs', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const generated = planner.createSolvableDeal(seededRandom(seed));
    let state = generated.state;
    let certificate = generated.certificate;
    let step = 0;

    assert.equal(planner.isValidCertificate(certificate), true);
    const first = Array.from(planner.readyCertificateActions(state, certificate));
    assert.equal(first.length, 1);
    assert.equal(first[0].type, 'deal', `seed ${seed} stock should open both bootstrap groups`);
    let maxIndependentChoices = 0;

    while (state.completed < 8 && step < certificate.nodes.length) {
      const ready = Array.from(planner.readyCertificateActions(state, certificate));
      assert.ok(ready.length, `seed ${seed} must always expose a certified next action`);
      maxIndependentChoices = Math.max(maxIndependentChoices, ready.length);
      const action = ready[(seed + step) % ready.length];
      const doneBefore = certificate.done.length;
      certificate = planner.advanceCertificate(state, certificate, action);
      assert.equal(certificate.valid, true);
      assert.equal(certificate.done.length, doneBefore + 1);

      if (action.type === 'deal') {
        state = planner.dealNextRound(state);
      } else {
        const move = Array.from(planner.legalMoves(state)).find(candidate =>
          candidate.fromCol === action.fromCol && candidate.fromIndex === action.fromIndex &&
          candidate.toCol === action.toCol);
        assert.ok(move, `seed ${seed} certified move must be legal`);
        state = planner.applyMove(state, move);
      }
      if (step === 0) {
        assert.equal(Array.from(planner.readyCertificateActions(state, certificate)).length, 2,
          `seed ${seed} should allow either bootstrap collection first`);
      }
      step++;
    }

    assert.equal(state.completed, 8, `seed ${seed} should win by following certified hints`);
    assert.ok(maxIndependentChoices >= 2, `seed ${seed} should allow either bootstrap order`);
    assert.equal(certificate.done.length, certificate.nodes.length);
    assert.equal(state.stock.length, 0);
    assert.ok(state.cols.every(col => col.length === 0));
  }
});

test('the longest hidden prefixes retain a valid complete proof', () => {
  const generated = planner.createSolvableDeal(max => max - 1);
  assert.equal(generated.state.cols.flat().filter(card => !card.up).length, 60);
  assert.ok(generated.certificate.nodes.length > 104,
    'uncovering every prefix needs more actions than the number of cards');
  assert.equal(planner.isValidCertificate(generated.certificate), true);
  const won = planner.replayPlan(generated.state, generated.plan);
  assert.ok(won && won.completed === 8 && won.cols.every(col => !col.length));
});

test('ordinary Ace choices outside the generator proof retain a complete solution', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const generated = planner.createSolvableDeal(seededRandom(seed));
    const aces = Array.from(planner.legalMoves(generated.state)).filter(move =>
      generated.state.cols[move.fromCol][move.fromIndex].r === 1 &&
      generated.state.cols[move.toCol].at(-1).r === 2);
    assert.ok(aces.length >= 6, `seed ${seed} should offer several independent Ace moves`);
    const choice = aces[(seed * 7) % aces.length];
    const certificate = planner.advanceCertificate(generated.state, generated.certificate, { type: 'move', ...choice });
    assert.equal(certificate.valid, false, 'the regression must exercise a move outside the original proof');
    const state = planner.applyMove(generated.state, choice);
    const before = JSON.stringify(state);
    const result = planner.solve(state, { nodeLimit: 20000, timeLimitMs: 500 });
    assert.equal(result.status, 'solved', `seed ${seed} free Ace choice must retain a proved win (${result.reason})`);
    const won = planner.replayPlan(state, result.plan);
    assert.ok(won && won.completed === 8 && !won.stock.length && won.cols.every(col => !col.length),
      `seed ${seed} free-play solution must actually collect every card`);
    assert.equal(JSON.stringify(state), before, 'finding an alternative must not rewrite hidden cards');
  }
});

test('different core, King and workspace choices all retain a complete solution after stock', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const generated = planner.createSolvableDeal(seededRandom(seed));
    let state = planner.replayPlan(generated.state, generated.plan.slice(0, 3));
    assert.equal(state.completed, 2);
    const coreColumns = state.cols.map((col, index) => col.some(card => !card.up) ? index : -1).filter(index => index >= 0);
    const workspaces = state.cols.map((col, index) => col.length ? -1 : index).filter(index => index >= 0);
    assert.equal(coreColumns.length, 6);
    assert.equal(workspaces.length, 4);
    const core = coreColumns[seed % coreColumns.length];
    const kingTarget = workspaces[seed % workspaces.length];
    const buffer = workspaces[(seed + 1) % workspaces.length];
    const king = Array.from(planner.legalMoves(state)).find(move =>
      move.fromCol === core && move.toCol === kingTarget && state.cols[core][move.fromIndex].r === 13);
    assert.ok(king);
    state = planner.applyMove(state, king);
    const lifted = Array.from(planner.legalMoves(state)).find(move =>
      move.fromCol === core && move.toCol === buffer && move.fromIndex === state.cols[core].findIndex(card => card.up));
    assert.ok(lifted);
    state = planner.applyMove(state, lifted);
    const result = planner.solve(state, { nodeLimit: 20000, timeLimitMs: 500 });
    assert.equal(result.status, 'solved', `seed ${seed} alternate workspace must retain a win (${result.reason})`);
    const won = planner.replayPlan(state, result.plan);
    assert.ok(won && won.completed === 8 && won.cols.every(col => !col.length));
  }
});

test('solver distinguishes a blocked board from an incomplete budget and includes stock transitions', () => {
  const generated = planner.createSolvableDeal(seededRandom(7));
  const limited = planner.solve(generated.state, { nodeLimit: 1, timeLimitMs: 500 });
  assert.equal(limited.status, 'unknown');
  assert.equal(limited.plan.length, 0);
  const full = planner.solve(generated.state, { nodeLimit: 20000, timeLimitMs: 500 });
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
  assert.match(html, /const STORE_KEY = "game-over-spider-one-suit-v4"/);
  assert.match(html, /LEGACY_STORE_KEYS = \["game-over-spider-one-suit-v1", "game-over-spider-one-suit-v2", "game-over-spider-one-suit-v3"\]/);
  assert.match(html, /LEGACY_STORE_KEYS\.forEach\(key => localStorage\.removeItem\(key\)\)/);
});

test('page keeps fixed cards and solves the current board in a worker for hints and stock safety', () => {
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
  assert.doesNotMatch(clientScript, /SpiderPlanner\.nonRepeatingMoves\(/);
  assert.match(clientScript, /performAction\(/);
  assert.match(clientScript, /game\.solution/);
  assert.match(clientScript, /status === "solved"/);
  assert.match(clientScript, /status === "dead-end"/);
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
