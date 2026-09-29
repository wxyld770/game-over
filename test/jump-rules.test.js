const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const Rules = require('../public/jump-rules.js');

function play(game, hold) {
  Rules.jump(game, hold);
  let event;
  while (game.state === 'jumping') {
    const next = Rules.step(game);
    if (next) event = next;
  }
  return event;
}

function nextPerfectHold(game) {
  const target = game.platforms[1];
  for (let hold = 0; hold <= Rules.MAX_HOLD_MS; hold += 10) {
    const trial = {
      ...game,
      random: () => 0.5,
      platforms: game.platforms.map((platform) => ({ ...platform })),
      player: { ...game.player },
    };
    const event = play(trial, hold);
    if (event?.advanced && event.perfect && event.platform.x === target.x) return hold;
  }
  return null;
}

test('跳一跳规则：同一种子、固定步长与浏览器导出产生相同地图和结算', () => {
  const first = Rules.createGame(0);
  const second = Rules.createGame(0);
  assert.deepEqual(first.platforms, second.platforms);
  assert.notDeepEqual(first.platforms, Rules.createGame(1).platforms);
  const history = [410, 465, 510, 650, 0];
  assert.deepEqual(Rules.replay(0, history), Rules.replay(0, history));
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/jump-rules.js'), 'utf8'), context);
  const browserResult = context.JumpRules.replay(0, history);
  assert.equal(browserResult.score, 20);
  assert.equal(browserResult.durationMs, Rules.replay(0, history).durationMs);
  assert.equal(browserResult.jumpCount, 5);
});

test('跳一跳规则：中心连击、星光平台与平台补充遵循现有计分', () => {
  const game = Rules.createGame(0);
  const events = [410, 465, 510, 650].map((hold) => play(game, hold));
  assert.deepEqual(events.map((event) => event.earned), [3, 7, 5, 5]);
  assert.deepEqual(events.map((event) => event.perfectStreak), [1, 2, 3, 4]);
  assert.equal(events[1].platform.special, 'star');
  assert.ok(events.every((event) => event.advanced && event.perfect));
  assert.equal(game.score, 20);
  assert.equal(game.platforms.length, Rules.PLATFORM_WINDOW_SIZE);
  assert.equal(game.platforms[0], game.player.standing);
  assert.equal(game.state, 'ready');
  const miss = play(game, 0);
  assert.equal(miss.over, true);
  assert.equal(game.state, 'over');
});

test('跳一跳规则：地面坐标平移不改变落点与分数', () => {
  const first = Rules.createGame(0);
  const translated = Rules.createGame(0, 275);
  for (const hold of [410, 465, 510, 650, 0]) {
    const a = play(first, hold);
    const b = play(translated, hold);
    assert.equal(a.score, b.score);
    assert.equal(a.perfect, b.perfect);
    assert.ok(Math.abs(translated.player.y - first.player.y - 275) < 1e-9);
    assert.equal(translated.player.x, first.player.x);
  }
});

test('跳一跳规则：只在成功落地后展示并生成一个新平台', () => {
  const game = Rules.createGame(0);
  const current = game.platforms[0];
  const target = game.platforms[1];
  assert.equal(Rules.PLATFORM_WINDOW_SIZE, 2);
  assert.deepEqual(game.platforms, [current, target]);
  assert.equal(game.spawned, 1);

  const hold = nextPerfectHold(game);
  const event = play(game, hold);
  assert.equal(event.platform, target);
  assert.equal(game.platforms.length, Rules.PLATFORM_WINDOW_SIZE);
  assert.equal(game.platforms[0], target);
  assert.notEqual(game.platforms[1], target);
  assert.equal(game.spawned, 2);
});

test('跳一跳规则：长跳不能越过目标平台落到尚未展示的平台', () => {
  const game = Rules.createGame(0);
  const current = game.platforms[0];
  const target = game.platforms[1];
  const event = play(game, 980);
  assert.equal(event.over, true);
  assert.equal(game.score, 0);
  assert.equal(game.spawned, 1);
  assert.deepEqual(game.platforms, [current, target]);
});

test('跳一跳规则：长局始终只保留两个平台，平台高度有限且下一平台可达', () => {
  for (const [seed, groundY] of [[0, 0], [42, 275], [0xFFFFFFFF, 0]]) {
    const game = Rules.createGame(seed, groundY);
    const history = [];
    let reachedTop = false;
    let reachedBottom = false;
    for (let index = 0; index < 1100; index += 1) {
      assert.equal(game.platforms.length, Rules.PLATFORM_WINDOW_SIZE);
      for (const platform of game.platforms) {
        assert.ok(platform.y >= groundY - 55 && platform.y <= groundY + 55, `seed ${seed}, jump ${index}: platform height escaped visible range`);
        reachedTop ||= platform.y === groundY - 55;
        reachedBottom ||= platform.y === groundY + 55;
      }
      const target = game.platforms[1];
      assert.ok(Math.abs(target.y - game.platforms[0].y) <= 17 + 1e-9);
      const hold = nextPerfectHold(game);
      assert.notEqual(hold, null, `seed ${seed}, jump ${index}: next platform became unreachable`);
      history.push(hold);
      const event = play(game, hold);
      assert.equal(event.platform, target);
      assert.equal(event.perfect, true);
      assert.equal(game.state, 'ready');
      assert.equal(game.platforms.length, Rules.PLATFORM_WINDOW_SIZE);
    }
    assert.equal(game.spawned, 1101);
    assert.ok(reachedTop && reachedBottom, `seed ${seed}: long run must exercise both height limits`);
    assert.throws(() => Rules.replay(seed, history), /not finished/);
    history.push(0);
    assert.equal(play(game, 0).over, true);
    const replay = Rules.replay(seed, history);
    assert.equal(replay.score, game.score);
    assert.equal(replay.perfectStreak, game.perfectStreak);
    assert.equal(replay.jumpCount, 1101);
  }
});

test('跳一跳规则：停留原平台不加分，普通落点重置连击', () => {
  const current = Rules.createGame(0);
  current.player.x = current.platforms[0].x - 5;
  current.perfectStreak = 2;
  const same = play(current, 0);
  assert.equal(same.advanced, false);
  assert.equal(same.earned, 0);
  assert.equal(same.perfectStreak, 0);
  assert.equal(current.score, 0);

  const ordinary = Rules.createGame(0);
  const edge = play(ordinary, 350);
  assert.equal(edge.advanced, true);
  assert.equal(edge.perfect, false);
  assert.equal(edge.earned, 1);
});

test('跳一跳规则：拒绝未完局、结束后的额外输入与异常蓄力记录', () => {
  assert.throws(() => Rules.replay(0, []));
  assert.throws(() => Rules.replay(0, [410]), /not finished/);
  assert.throws(() => Rules.replay(0, [0, 410]), /cannot jump/);
  for (const hold of [-1, 1101, NaN, Infinity, '410', null]) assert.throws(() => Rules.replay(0, [hold]));
  assert.throws(() => Rules.replay(0, Array(Rules.MAX_JUMPS + 1).fill(0)), /Invalid jump history/);
  assert.throws(() => Rules.createGame(-1));
  assert.throws(() => Rules.createGame(2 ** 32));
  assert.throws(() => Rules.step(Rules.createGame(0), 0));
});
