const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/games/match3.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'match-3 page has an inline script');
const begin = script.indexOf('// PURE_GAME_LOGIC_START');
const end = script.indexOf('// PURE_GAME_LOGIC_END');
assert.ok(begin >= 0 && end > begin, 'pure game logic is available for model testing');
const pureLogic = script.slice(begin + '// PURE_GAME_LOGIC_START'.length, end);

function gameForSeed(seed) {
  let randomState = seed >>> 0;
  const seededMath = Object.create(Math);
  seededMath.random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  const context = vm.createContext({ Math: seededMath, Set, Array });
  vm.runInContext(`${pureLogic}\nglobalThis.logic = { ROWS, COLS, BLOCK_COUNT, TOTAL, makeBoard, globalMatches, analyzeSwap, winningPair, reorderBoard, blockIndices };`, context);
  return context.logic;
}

test('200 个随机棋盘都能只靠相邻交换清空整盘，重排与撤销不破坏可解性', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const game = gameForSeed(seed);
    let board = game.makeBoard().board;
    assert.equal(board.length, 72, `seed ${seed}: full board`);
    assert.ok(board.every(value => Number.isInteger(value)), `seed ${seed}: no empty starting tile`);
    assert.equal(game.globalMatches(board).size, 0, `seed ${seed}: no pre-existing match`);

    const order = Array.from({ length: game.BLOCK_COUNT }, (_, index) => index);
    if (seed % 2) order.reverse();
    for (let moveNumber = 0; moveNumber < order.length; moveNumber += 1) {
      if (moveNumber === 5) {
        const before = Array.from({ length: 6 }, (_, kind) => board.filter(value => value === kind).length);
        const occupied = board.map(value => value !== null);
        board = game.reorderBoard(board);
        assert.deepEqual(Array.from({ length: 6 }, (_, kind) => board.filter(value => value === kind).length), before, `seed ${seed}: reorder keeps existing colors`);
        assert.deepEqual(board.map(value => value !== null), occupied, `seed ${seed}: reorder adds no tiles`);
      }
      const block = order[moveNumber];
      const pair = game.winningPair(board, block);
      assert.ok(pair, `seed ${seed}: block ${block} has a clearing swap`);
      const beforeMove = board.slice();
      const outcome = game.analyzeSwap(board, pair[0], pair[1]);
      assert.equal(outcome.valid, true, `seed ${seed}: move ${moveNumber} is legal`);
      assert.equal(outcome.cleared.length, 6, `seed ${seed}: each move clears both triples`);
      board = outcome.swapped;
      for (const index of outcome.cleared) board[index] = null;
      if (moveNumber === 2) {
        board = beforeMove;
        assert.ok(game.winningPair(board, block), `seed ${seed}: undo restores a solvable board`);
        const replay = game.analyzeSwap(board, pair[0], pair[1]);
        board = replay.swapped;
        for (const index of replay.cleared) board[index] = null;
      }
    }
    assert.ok(board.every(value => value === null), `seed ${seed}: all 72 gems are gone`);
  }
});

test('无效相邻交换不修改棋盘，且只承认双线清除', () => {
  const game = gameForSeed(47);
  const board = game.makeBoard().board;
  const original = board.slice();
  let validCount = 0;
  let invalidCount = 0;
  for (let index = 0; index < game.TOTAL; index += 1) {
    for (const neighbor of [index + 1, index + game.COLS]) {
      if (neighbor >= game.TOTAL) continue;
      const result = game.analyzeSwap(board, index, neighbor);
      if (result.valid) {
        validCount += 1;
        assert.equal(result.cleared.length, 6);
      } else invalidCount += 1;
    }
  }
  assert.equal(validCount, game.BLOCK_COUNT, 'one clearing move per untouched block');
  assert.ok(invalidCount > 0);
  assert.deepEqual([...board], [...original], 'analyzing failed swaps is side effect free');
});
