const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createJumpLeaderboard, createFileStore } = require('../jump-leaderboard.js');
const Rules = require('../public/jump-rules.js');

const LOW = [410, 0];
const MID = [410, 465, 0];
const HIGH = [410, 465, 510, 650, 0];

function longRun(seed, successfulJumps) {
  const game = Rules.createGame(seed);
  const jumps = [];
  function play(state, hold) {
    Rules.jump(state, hold);
    let event;
    while (state.state === 'jumping') event = Rules.step(state) || event;
    return event;
  }
  for (let index = 0; index < successfulJumps; index += 1) {
    const target = game.platforms[1];
    let selected = null;
    for (let hold = 0; hold <= Rules.MAX_HOLD_MS; hold += 10) {
      const trial = {
        ...game,
        random: () => 0.5,
        platforms: game.platforms.map((platform) => ({ ...platform })),
        player: { ...game.player },
      };
      const event = play(trial, hold);
      if (event?.advanced && event.perfect && event.platform.x === target.x) {
        selected = hold;
        break;
      }
    }
    assert.notEqual(selected, null, `No landing charge for jump ${index}`);
    jumps.push(selected);
    assert.equal(play(game, selected).platform, target);
  }
  jumps.push(0);
  assert.equal(play(game, 0).over, true);
  return { jumps, score: game.score };
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'game-over-jump-'));
  const filePath = path.join(directory, 'scores.json');
  let timestamp = Date.parse('2026-09-28T08:00:00Z');
  let api = createJumpLeaderboard({ filePath, now: () => timestamp, seed: () => 0, logError: () => {}, ...options });
  const server = http.createServer((req, res) => api.handleRequest(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/jump`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function request(endpoint, body, cookie = '', headers = {}) {
    const response = await fetch(base + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie'), headers: response.headers };
  }
  async function start(cookie = '', headers = {}) {
    const response = await request('/runs', {}, cookie, headers);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { ...response.body, cookie: response.cookie.split(';')[0], setCookie: response.cookie };
  }
  async function finish(run, name, jumps = LOW, extra = {}) {
    timestamp += Math.ceil(Rules.replay(run.seed, jumps).durationMs) + 1000;
    return request(`/runs/${run.runId}/finish`, { name, jumps, ...extra }, run.cookie);
  }
  return {
    start, finish, request, filePath, directory,
    now: () => timestamp,
    advance: (milliseconds) => { timestamp += milliseconds; },
    api: () => api,
    restart: () => { api = createJumpLeaderboard({ filePath, now: () => timestamp, seed: () => 0, logError: () => {}, ...options }); },
  };
}

test('跳一跳榜单：服务端计算得分，独立身份排名、同分先达成与最高分更新', async (t) => {
  const app = await fixture(t);
  const empty = await app.request('/leaderboard');
  assert.deepEqual(empty.body, { entries: [], me: null });
  const first = await app.start();
  assert.match(first.setCookie, /^jump_player=[A-Za-z0-9_-]{43}; Path=\/api\/jump\/; HttpOnly; SameSite=Strict; Max-Age=31536000$/);
  assert.ok(!Object.hasOwn(first, 'token'));
  const score = await app.finish(first, '  张三   同学  ', MID);
  assert.equal(score.status, 200);
  assert.equal(score.body.score, 10);
  assert.equal(score.body.personalBest, 10);
  assert.equal(score.body.rank, 1);
  assert.equal(score.body.me.name, '张三 同学');
  assert.equal(score.body.isPersonalBest, true);

  const second = await app.start();
  assert.notEqual(first.cookie, second.cookie);
  const equal = await app.finish(second, '张三 同学', MID);
  assert.equal(equal.body.rank, 2, '昵称相同也必须按浏览器身份分别排名');
  assert.equal(equal.body.entries.length, 2);
  assert.ok(equal.body.entries[0].achievedAt < equal.body.entries[1].achievedAt);
  const previousTime = score.body.me.achievedAt;
  const lower = await app.finish(await app.start(first.cookie), '新昵称', LOW);
  assert.equal(lower.body.personalBest, 10);
  assert.equal(lower.body.isPersonalBest, false);
  assert.equal(lower.body.me.name, '新昵称');
  assert.equal(lower.body.me.achievedAt, previousTime);
  const higher = await app.finish(await app.start(first.cookie), '新昵称', HIGH);
  assert.equal(higher.body.personalBest, 20);
  assert.equal(higher.body.isPersonalBest, true);
  assert.ok(higher.body.me.achievedAt > previousTime);
  const own = await app.request('/leaderboard', undefined, second.cookie);
  assert.equal(own.body.me.rank, 2);
  assert.equal(own.body.me.score, 10);
  assert.equal((await app.request('/leaderboard')).body.me, null);
  assert.ok(own.body.entries.every((entry) => Object.keys(entry).sort().join(',') === 'achievedAt,name,rank,score'));
  const persisted = JSON.parse(await fs.readFile(app.filePath, 'utf8'));
  assert.equal(persisted.entries.length, 2);
  assert.match(persisted.entries[0].playerId, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(persisted).includes(first.cookie.slice('jump_player='.length)));
});

test('跳一跳榜单：拒绝伪造分数、未完局、快速伪造提交、无效昵称与跨身份提交', async (t) => {
  const app = await fixture(t);
  const first = await app.start('', { 'X-Forwarded-Proto': 'https' });
  assert.match(first.setCookie, /; Secure$/);
  const endpoint = `/runs/${first.runId}/finish`;
  assert.equal((await app.request(endpoint, { name: '甲', jumps: LOW }, first.cookie)).status, 409);
  app.advance(10_000);
  assert.equal((await app.request(endpoint, { name: '甲', score: 9999, jumps: LOW }, first.cookie)).status, 400);
  assert.equal((await app.request(endpoint, { name: '甲', score: 9999 }, first.cookie)).status, 400);
  assert.equal((await app.request(endpoint, { name: '甲', jumps: [410] }, first.cookie)).status, 400);
  assert.equal((await app.request(endpoint, { name: '甲', jumps: [0, 410] }, first.cookie)).status, 400);
  assert.equal((await app.request(endpoint, { name: '甲', jumps: [1101] }, first.cookie)).status, 400);
  assert.equal((await app.request(endpoint, { name: '甲', jumps: Array(Rules.MAX_JUMPS + 1).fill(410) }, first.cookie)).status, 400);
  for (const name of ['', ' '.repeat(10), '字'.repeat(19), '昵称\u0000', '\u202e恶意昵称', null]) {
    assert.equal((await app.request(endpoint, { name, jumps: LOW }, first.cookie)).status, 400);
  }
  assert.equal((await app.request(endpoint, { name: '甲', jumps: LOW })).status, 403);
  const other = await app.start();
  assert.equal((await app.request(endpoint, { name: '甲', jumps: LOW }, other.cookie)).status, 403);
  const encodedName = '<img src=x>';
  const valid = await app.request(endpoint, { name: encodedName, jumps: LOW }, first.cookie);
  assert.equal(valid.status, 200);
  assert.equal(valid.body.me.name, encodedName);
  assert.match(valid.headers.get('content-type'), /^application\/json/);
  assert.equal(valid.headers.get('x-content-type-options'), 'nosniff');
  const maxRequestBytes = 128 * 1024;
  const bodyOverhead = Buffer.byteLength(JSON.stringify({ extra: '' }));
  assert.equal((await app.request('/runs', { extra: 'x'.repeat(maxRequestBytes - bodyOverhead) })).status, 201);
  assert.equal((await app.request('/runs', { extra: 'x'.repeat(maxRequestBytes - bodyOverhead + 1) })).status, 413);
});

test('跳一跳榜单：超过1000次成功的长局在30分钟后仍可完整上榜，六小时后到期', async (t) => {
  const app = await fixture(t);
  const run = await app.start();
  assert.equal(run.expiresAt - app.now(), 6 * 60 * 60_000);
  const history = longRun(run.seed, Rules.MAX_JUMPS - 1);
  assert.equal(history.jumps.length, Rules.MAX_JUMPS);
  assert.ok(history.jumps.length > 1001);
  assert.ok(history.score > 8000);
  assert.ok(Buffer.byteLength(JSON.stringify({ name: '长局玩家', jumps: history.jumps })) > 32_768);
  app.advance(30 * 60_000 + 1);
  const result = await app.finish(run, '长局玩家', history.jumps);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.score, history.score);
  assert.equal(result.body.personalBest, history.score);
  assert.equal(result.body.saved, true);
  assert.equal(result.body.rank, 1);
  assert.equal((await app.request('/leaderboard', undefined, run.cookie)).body.me.score, history.score);
  app.advance(run.expiresAt - app.now() - 1);
  assert.equal((await app.request(`/runs/${run.runId}/finish`, { name: '长局玩家', jumps: history.jumps }, run.cookie)).status, 200);
  app.advance(1);
  assert.equal((await app.request(`/runs/${run.runId}/finish`, { name: '长局玩家', jumps: history.jumps }, run.cookie)).status, 410);
  assert.equal((await app.request('/leaderboard', undefined, run.cookie)).body.me.score, history.score);
});

test('跳一跳榜单：完局提交可重试，并发重复提交只保存一次', async (t) => {
  const app = await fixture(t);
  const run = await app.start();
  app.advance(10_000);
  const endpoint = `/runs/${run.runId}/finish`;
  const responses = await Promise.all([
    app.request(endpoint, { name: '玩家', jumps: MID }, run.cookie),
    app.request(endpoint, { name: '玩家', jumps: MID }, run.cookie),
  ]);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[1].status, 200);
  assert.deepEqual(responses[0].body, responses[1].body);
  const retry = await app.request(endpoint, { name: '玩家', jumps: MID }, run.cookie);
  assert.deepEqual(retry.body, responses[0].body);
  assert.equal((await app.request(endpoint, { name: '另一个昵称', jumps: MID }, run.cookie)).status, 409);
  const entries = JSON.parse(await fs.readFile(app.filePath, 'utf8')).entries;
  assert.equal(entries.length, 1);
});

test('跳一跳榜单：零分不上榜，重启后保留排名与浏览器最高分', async (t) => {
  const app = await fixture(t);
  const zeroRun = await app.start();
  const zero = await app.finish(zeroRun, '空白玩家', [0]);
  assert.equal(zero.status, 200);
  assert.equal(zero.body.saved, false);
  assert.equal(zero.body.rank, null);
  assert.equal(zero.body.personalBest, 0);
  assert.equal(zero.body.entries.length, 0);
  const run = await app.start();
  const saved = await app.finish(run, '永久玩家', MID);
  app.restart();
  const own = await app.request('/leaderboard', undefined, run.cookie);
  assert.deepEqual(own.body.me, saved.body.me);
  assert.equal((await app.request(`/runs/${run.runId}/finish`, { name: '永久玩家', jumps: MID }, run.cookie)).status, 404);
});

test('跳一跳榜单：只公开前20名，个人排名可以超过20', async (t) => {
  const app = await fixture(t);
  let finalRun;
  for (let index = 0; index < 22; index += 1) {
    finalRun = await app.start();
    assert.equal((await app.finish(finalRun, `玩家${index}`, LOW)).status, 200);
  }
  const board = await app.request('/leaderboard', undefined, finalRun.cookie);
  assert.equal(board.body.entries.length, 20);
  assert.equal(board.body.me.rank, 22);
  assert.equal(board.body.entries[0].name, '玩家0');
  assert.equal(board.body.entries.at(-1).rank, 20);
});

test('跳一跳榜单：限制请求频率、运行数量、记录容量并清理过期游戏', async (t) => {
  const app = await fixture(t, { limits: { maxStartsPerAddress: 2, maxRuns: 2, runTtlMs: 20_000 } });
  const first = await app.start();
  await app.start();
  assert.equal((await app.request('/runs', {})).status, 429);
  assert.equal((await app.request('/runs', {}, '', { 'X-Real-IP': '203.0.113.3' })).status, 429);
  app.advance(20_001);
  assert.equal((await app.request(`/runs/${first.runId}/finish`, { name: '甲', jumps: LOW }, first.cookie)).status, 410);
  const fresh = await app.start('', { 'X-Real-IP': '203.0.113.3' });
  assert.ok(fresh.runId);
  assert.ok(app.api().testing.runs.size <= 2);

  const capacity = await fixture(t, { limits: { maxEntries: 1 } });
  const owner = await capacity.start();
  assert.equal((await capacity.finish(owner, '甲', LOW)).status, 200);
  assert.equal((await capacity.finish(await capacity.start(), '乙', LOW)).status, 503);
  assert.equal((await capacity.finish(await capacity.start(owner.cookie), '甲', MID)).status, 200);
  assert.equal((await capacity.request('/leaderboard')).body.entries.length, 1);

  const finishing = await fixture(t, { limits: { maxFinishesPerAddress: 1 } });
  const finishingRun = await finishing.start();
  assert.equal((await finishing.finish(finishingRun, '甲', LOW)).status, 200);
  assert.equal((await finishing.request(`/runs/${finishingRun.runId}/finish`, { name: '甲', jumps: LOW }, finishingRun.cookie)).status, 429);
  finishing.advance(60_001);
  assert.equal((await finishing.request(`/runs/${finishingRun.runId}/finish`, { name: '甲', jumps: LOW }, finishingRun.cookie)).status, 200);
});

test('跳一跳榜单：损坏文件阻止覆盖，写入失败不改变旧榜单且允许重试', async (t) => {
  const corrupt = await fixture(t);
  await fs.writeFile(corrupt.filePath, '{broken json');
  assert.equal((await corrupt.request('/leaderboard')).status, 503);
  assert.equal((await corrupt.request('/runs', {})).status, 503);
  assert.equal(await fs.readFile(corrupt.filePath, 'utf8'), '{broken json');

  let failWrites = false;
  const app = await fixture(t, { storage: {
    writeFile: async (...args) => {
      if (failWrites) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.writeFile(...args);
    },
  } });
  const first = await app.start();
  const initial = await app.finish(first, '甲', LOW);
  const content = await fs.readFile(app.filePath, 'utf8');
  const next = await app.start(first.cookie);
  failWrites = true;
  const failed = await app.finish(next, '甲', MID);
  assert.equal(failed.status, 503);
  assert.equal((await app.request('/leaderboard', undefined, first.cookie)).body.me.score, initial.body.score);
  assert.equal(await fs.readFile(app.filePath, 'utf8'), content);
  assert.equal((await fs.readdir(app.directory)).filter((name) => name.endsWith('.tmp')).length, 0);
  failWrites = false;
  const retry = await app.request(`/runs/${next.runId}/finish`, { name: '甲', jumps: MID }, next.cookie);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.personalBest, 10);
});

test('跳一跳文件存储：并发写入保留所有身份及最高分', async (t) => {
  const app = await fixture(t);
  const store = createFileStore(app.filePath);
  const idA = crypto.createHash('sha256').update('a').digest('hex');
  const idB = crypto.createHash('sha256').update('b').digest('hex');
  const at = '2026-09-28T08:00:00.000Z';
  await Promise.all([
    store.saveBest({ playerId: idA, name: '甲', score: 20, achievedAt: at }),
    store.saveBest({ playerId: idB, name: '乙', score: 10, achievedAt: at }),
    store.saveBest({ playerId: idA, name: '甲', score: 3, achievedAt: at }),
  ]);
  const entries = await store.load();
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.playerId === idA).score, 20);
  assert.equal((await createFileStore(app.filePath).load()).length, 2);
  await assert.rejects(store.saveBest({ playerId: idA, name: null, score: 20, achievedAt: at }));
  assert.equal((await store.load()).find((entry) => entry.playerId === idA).name, '甲');
});
