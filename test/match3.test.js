const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../public/match3-rules.js');

test('交换轨迹让两颗宝石同时移动且在中点保持可见', () => {
  const vector = { x: 100, y: 0 };
  const halfway = Rules.swapPath(vector, 0.5, 1);
  const peerPosition = {
    x: vector.x + halfway.peer.x,
    y: vector.y + halfway.peer.y,
  };
  assert.deepEqual(halfway.source, { x: 50, y: 0 });
  assert.equal(peerPosition.x, 50);
  assert.ok(Math.abs(peerPosition.y - halfway.source.y) > 40, 'peer takes a separate curved lane');

  const finished = Rules.swapPath(vector, 1, 1);
  assert.deepEqual(finished.source, vector);
  assert.ok(Math.abs(finished.peer.x + vector.x) < 1e-9);
  assert.ok(Math.abs(finished.peer.y) < 1e-9);
});

test('随机棋盘没有预消除、颜色不分栏，并且始终至少有一步可走', () => {
  const colorsByColumn = Array.from({ length: Rules.COLS }, () => new Set());
  for (let seed = 0; seed < 300; seed += 1) {
    const game = Rules.createGame(seed);
    assert.equal(game.board.length, Rules.TOTAL);
    assert.equal(Rules.matchRuns(game.board).length, 0, `seed ${seed}: no initial match`);
    assert.ok(Rules.findMoves(game.board, 1).length, `seed ${seed}: playable`);
    game.board.forEach((kind, index) => colorsByColumn[index % Rules.COLS].add(kind));
  }
  assert.ok(colorsByColumn.every((colors) => colors.size === Rules.KINDS), 'all colours can appear in every column');
});

test('三连、四连、五连和七颗 T 形采用不同分值', () => {
  function groupFor(cells) {
    const board = Array(Rules.TOTAL).fill(null);
    for (const index of cells) board[index] = 2;
    return Rules.matchGroups(board)[0];
  }

  const line = 3 * Rules.COLS;
  const three = groupFor([line + 1, line + 2, line + 3]);
  const four = groupFor([line + 1, line + 2, line + 3, line + 4]);
  const five = groupFor([line + 1, line + 2, line + 3, line + 4, line + 5]);
  const tSeven = groupFor([line + 1, line + 2, line + 3, line + 4, line + 5,
    4 * Rules.COLS + 3, 5 * Rules.COLS + 3]);
  const crossSeven = groupFor([line + 1, line + 2, line + 3, line + 4, line + 5,
    2 * Rules.COLS + 3, 4 * Rules.COLS + 3]);
  const cornerSeven = groupFor([line + 1, line + 2, line + 3, line + 4, line + 5,
    4 * Rules.COLS + 1, 5 * Rules.COLS + 1]);
  assert.deepEqual([three.shape, three.points], ['three', 30]);
  assert.deepEqual([four.shape, four.points], ['four', 90]);
  assert.deepEqual([five.shape, five.points], ['five', 180]);
  assert.deepEqual([tSeven.shape, tSeven.points], ['t7', 500]);
  assert.equal(crossSeven.shape, 'cross', '十字形不能冒充 T 形');
  assert.equal(cornerSeven.shape, 'cross', 'L 形不能冒充 T 形');
});

test('下落会补满新宝石，连锁结束后仍有解，可以无限继续', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const game = Rules.createGame(seed);
    const history = [];
    for (let moveNumber = 0; moveNumber < 80; moveNumber += 1) {
      const choices = Rules.findMoves(game.board, 24);
      const [a, b] = choices[(seed * 11 + moveNumber * 7) % choices.length];
      const result = Rules.swap(game, a, b);
      history.push(a, b);
      assert.equal(result.valid, true);
      assert.ok(result.stages.length >= 1);
      assert.ok(result.stages.every((stage) => stage.after.every(Number.isInteger)), 'refill keeps board full');
      assert.equal(Rules.matchRuns(game.board).length, 0, 'all cascades settle before next move');
      assert.ok(Rules.findMoves(game.board, 1).length, 'dead boards are reshuffled automatically');
    }
    const replay = Rules.replay(seed, history);
    assert.equal(replay.score, game.score, `seed ${seed}: server replay score`);
    assert.equal(replay.moveCount, game.moves);
    assert.ok(game.score > 0);
  }
});

test('无效交换不改变棋盘，重放拒绝伪造或残缺步骤', () => {
  const initial = Rules.createGame(47);
  let invalid;
  for (let index = 0; index < Rules.TOTAL && !invalid; index += 1) {
    for (const neighbor of [index + 1, index + Rules.COLS]) {
      if (!Rules.adjacent(index, neighbor)) continue;
      const probe = Rules.createGame(47);
      const result = Rules.swap(probe, index, neighbor);
      if (!result.valid) invalid = [index, neighbor];
    }
  }
  assert.ok(invalid);
  const game = Rules.createGame(47);
  const before = game.board.slice();
  assert.equal(Rules.swap(game, ...invalid).valid, false);
  assert.deepEqual(game.board, before);
  assert.throws(() => Rules.replay(47, invalid), /Invalid move history/);
  assert.throws(() => Rules.replay(47, [0]), /Invalid move history/);
  assert.throws(() => Rules.replay(47, [0, Rules.TOTAL]), /Invalid move history/);
  assert.deepEqual(initial.board, before);
});

test('排行榜记录达到上限后，本地无尽模式仍可继续交换', () => {
  const game = Rules.createGame(91);
  game.moves = Rules.MAX_MOVES;
  const move = Rules.findMoves(game.board, 1)[0];
  assert.equal(Rules.swap(game, ...move).valid, true);
  assert.equal(game.moves, Rules.MAX_MOVES + 1);
  assert.throws(() => Rules.replay(91, Array((Rules.MAX_MOVES + 1) * 2).fill(0)), /Invalid move history/);
});

test('服务端接受恰好上榜上限的合法记录，并拒绝再多一步', () => {
  const seed = 903;
  const game = Rules.createGame(seed);
  const history = [];
  for (let index = 0; index < Rules.MAX_MOVES + 1; index += 1) {
    const move = Rules.findMoves(game.board, 1)[0];
    assert.equal(Rules.swap(game, ...move, { captureStages: false }).valid, true);
    history.push(...move);
  }
  const accepted = Rules.replay(seed, history.slice(0, Rules.MAX_MOVES * 2));
  assert.equal(accepted.moveCount, Rules.MAX_MOVES);
  assert.ok(accepted.durationMs >= Rules.MAX_MOVES * Rules.MIN_MOVE_MS);
  assert.throws(() => Rules.replay(seed, history), /Invalid move history/);
});
