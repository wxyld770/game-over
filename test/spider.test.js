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

test('four-run deals conserve every card and replay to a complete win', () => {
  assert.equal(planner.config.TARGET_RUNS, 4);
  assert.equal(planner.config.TOTAL_CARDS, 52);
  assert.equal(planner.config.INITIAL_CARDS, 32);
  assert.equal(planner.config.DEAL_ROUNDS, 2);

  for (let seed = 1; seed <= 40; seed++) {
    const generated = planner.createSolvableDeal(seededRandom(seed));
    let state = generated.state;
    assert.equal(state.cols.reduce((sum, col) => sum + col.length, 0), 32, `seed ${seed} should start with 32 cards`);
    assert.equal(state.stock.length, 20, `seed ${seed} should reserve two deal rounds`);
    assert.deepEqual(rankCounts(state), Array(13).fill(4), `seed ${seed} should contain four of every rank`);
    assert.equal(state.cols.flat().filter(card => !card.up).length, 4, `seed ${seed} should retain fixed hidden cards`);
    assert.equal(planner.isValidState(state), true);

    for (const action of generated.plan) {
      if (action.type === 'deal') {
        const planned = Array.from(planner.planDeal(state));
        assert.deepEqual(planned, Array.from(state.stock.slice(-10)).reverse(), `seed ${seed} must keep stock order fixed`);
        state = planner.dealNextRound(state);
        assert.ok(state, `seed ${seed} should allow its planned deal`);
      } else {
        const legal = Array.from(planner.legalMoves(state));
        const move = legal.find(candidate => candidate.fromCol === action.fromCol &&
          candidate.fromIndex === action.fromIndex && candidate.toCol === action.toCol);
        assert.ok(move, `seed ${seed} solution move must remain legal`);
        state = planner.applyMove(state, move);
      }
      assert.equal(planner.isValidState(state), true, `seed ${seed} must conserve cards after every action`);
      assert.deepEqual(rankCounts(state), Array(13).fill(4));
    }

    assert.equal(state.completed, 4, `seed ${seed} should collect all four runs`);
    assert.equal(state.stock.length, 0);
    assert.ok(state.cols.every(col => col.length === 0));
    const replayed = planner.replayPlan(generated.state, generated.plan);
    assert.ok(replayed && replayed.completed === 4, `seed ${seed} replay proof should reach the win`);
  }
});

test('certified hints keep several valid routes and always finish all four runs', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const generated = planner.createSolvableDeal(seededRandom(seed));
    let state = generated.state;
    let certificate = generated.certificate;
    let step = 0;

    assert.equal(planner.isValidCertificate(certificate), true);
    assert.equal(Array.from(planner.readyCertificateActions(state, certificate)).length, 4,
      `seed ${seed} should begin with four independent recovery choices`);

    while (state.completed < 4 && step < certificate.nodes.length) {
      const ready = Array.from(planner.readyCertificateActions(state, certificate));
      assert.ok(ready.length, `seed ${seed} must always expose a certified next action`);
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
      step++;
    }

    assert.equal(state.completed, 4, `seed ${seed} should win by following certified hints`);
    assert.equal(certificate.done.length, certificate.nodes.length);
    assert.equal(state.stock.length, 0);
    assert.ok(state.cols.every(col => col.length === 0));
  }
});

test('certificate marks an early free-form deal as outside the guaranteed routes', () => {
  const generated = planner.createSolvableDeal(seededRandom(7));
  const certificate = planner.advanceCertificate(generated.state, generated.certificate, { type: 'deal' });
  assert.equal(certificate.valid, false);
  assert.deepEqual(Array.from(planner.readyCertificateActions(generated.state, certificate)), []);
});

test('legacy eight-run state is rejected by the four-run invariant', () => {
  const oldState = { cols: Array.from({ length: 10 }, () => []), stock: [], completed: 0 };
  let col = 0;
  for (let copy = 0; copy < 8; copy++) {
    for (let rank = 1; rank <= 13; rank++) {
      oldState.cols[col++ % 10].push(up(rank));
    }
  }
  assert.equal(planner.isValidState(oldState), false);
  assert.match(html, /game-over-spider-one-suit-v2/);
  assert.match(html, /localStorage\.removeItem\(LEGACY_STORE_KEY\)/);
});

test('page keeps fixed cards and wires hints through the completion certificate', () => {
  assert.match(html, /SpiderPlanner\.createSolvableDeal\(randomIndex\)/);
  assert.match(html, /SpiderPlanner\.replayPlan\(generated\.state, generated\.plan\)/);
  assert.match(html, /SpiderPlanner\.planDeal\(game\)/);
  assert.match(html, /SpiderPlanner\.readyCertificateActions\(game, game\.certificate\)/);
  assert.match(html, /SpiderPlanner\.advanceCertificate\(game, game\.certificate,/);
  assert.doesNotMatch(html, /target\.r =/);
  assert.doesNotMatch(html, /lastIndexOf\(plannedRank\)/);
  assert.match(html, /偏离初始解法后，提示仍会按当前牌面给出不重复的下一步/);
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
  assert.match(html, /SpiderPlanner\.nonRepeatingMoves\(game, history\.slice\(-8\)/);
  assert.doesNotMatch(html, /建议撤销最近的自由移动，回到可以完整收完的路线/);
});
