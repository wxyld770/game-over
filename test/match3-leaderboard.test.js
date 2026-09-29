const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createMatch3Leaderboard } = require('../match3-leaderboard.js');
const Rules = require('../public/match3-rules.js');

function playableMoves(seed, count) {
  const game = Rules.createGame(seed);
  const moves = [];
  for (let index = 0; index < count; index += 1) {
    const options = Rules.findMoves(game.board, 8);
    const move = options[index % options.length];
    assert.equal(Rules.swap(game, ...move).valid, true);
    moves.push(...move);
  }
  return { moves, score: game.score };
}

async function createApp(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'game-over-match3-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let timestamp = Date.parse('2026-01-01T00:00:00.000Z');
  let nextSeed = 12345;
  const board = createMatch3Leaderboard({
    filePath: path.join(directory, 'scores.json'),
    now: () => timestamp,
    seed: () => nextSeed++,
    logError: () => {},
    ...options,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    board.handleRequest(req, res, url.pathname, url);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/match3`;

  async function request(endpoint, body, cookie) {
    const response = await fetch(`${base}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie,
      setCookie: response.headers.get('set-cookie'),
    };
  }

  return {
    request,
    advance: (milliseconds) => { timestamp += milliseconds; },
  };
}

test('消消乐成绩由服务端重放，并保存个人最高分与公开排名', async (t) => {
  const app = await createApp(t);
  const started = await app.request('/runs', {});
  assert.equal(started.status, 201);
  assert.match(started.setCookie, /^match3_player=[A-Za-z0-9_-]{43}; Path=\/api\/match3\/; HttpOnly; SameSite=Strict;/);
  const played = playableMoves(started.body.seed, 5);
  app.advance(Rules.replay(started.body.seed, played.moves).durationMs + 500);

  const finished = await app.request(`/runs/${started.body.runId}/finish`, { name: '随机玩家', moves: played.moves }, started.cookie);
  assert.equal(finished.status, 200);
  assert.equal(finished.body.score, played.score);
  assert.equal(finished.body.personalBest, played.score);
  assert.equal(finished.body.rank, 1);
  assert.equal(finished.body.isPersonalBest, true);
  assert.deepEqual(finished.body.entries.map((entry) => entry.name), ['随机玩家']);

  const list = await app.request('/leaderboard', undefined, started.cookie);
  assert.equal(list.status, 200);
  assert.equal(list.body.me.score, played.score);
  assert.equal(list.body.entries[0].score, played.score);
  const retry = await app.request(`/runs/${started.body.runId}/finish`, { name: '随机玩家', moves: played.moves }, started.cookie);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, finished.body);
});

test('排行榜拒绝浏览器自报分数、伪造步骤、错身份和过快提交', async (t) => {
  const app = await createApp(t);

  const scored = await app.request('/runs', {});
  const valid = playableMoves(scored.body.seed, 2).moves;
  assert.equal((await app.request(`/runs/${scored.body.runId}/finish`, { name: '甲', score: 999999, moves: valid }, scored.cookie)).status, 400);

  const invalid = await app.request('/runs', {});
  app.advance(1000);
  assert.equal((await app.request(`/runs/${invalid.body.runId}/finish`, { name: '乙', moves: [0, Rules.TOTAL] }, invalid.cookie)).status, 400);

  const fast = await app.request('/runs', {});
  const longPlay = playableMoves(fast.body.seed, 20).moves;
  assert.equal((await app.request(`/runs/${fast.body.runId}/finish`, { name: '丙', moves: longPlay }, fast.cookie)).status, 409);
  app.advance(Rules.replay(fast.body.seed, longPlay).durationMs + 500);
  assert.equal((await app.request(`/runs/${fast.body.runId}/finish`, { name: '丙', moves: longPlay }, 'match3_player=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 403);
  assert.equal((await app.request(`/runs/${fast.body.runId}/finish`, { name: '丙', moves: longPlay }, fast.cookie)).status, 200);
});

test('重开会废弃旧局，已结算游戏不占用活跃容量并保留短时幂等结果', async (t) => {
  const app = await createApp(t, { limits: { maxRuns: 2, completedTtlMs: 60_000 } });
  const first = await app.request('/runs', {});
  let replacement = first;
  for (let index = 0; index < 6; index += 1) {
    replacement = await app.request('/runs', {}, first.cookie);
    assert.equal(replacement.status, 201, '连续刷新或重开不应锁死排行榜');
  }
  const second = await app.request('/runs', {});
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal((await app.request(`/runs/${first.body.runId}/finish`, { name: '旧局', moves: [] }, first.cookie)).status, 404);
  assert.equal((await app.request('/runs', {})).status, 429, '其他玩家仍受全局活跃容量限制');

  const played = playableMoves(replacement.body.seed, 1).moves;
  app.advance(Rules.MIN_MOVE_MS + 500);
  const endpoint = `/runs/${replacement.body.runId}/finish`;
  const submitted = await app.request(endpoint, { name: '容量玩家', moves: played }, first.cookie);
  assert.equal(submitted.status, 200);
  assert.equal((await app.request(endpoint, { name: '容量玩家', moves: played }, first.cookie)).status, 200);
  assert.equal((await app.request('/runs', {}, first.cookie)).status, 201, 'completed run no longer consumes active capacity');
  app.advance(60_001);
  assert.equal((await app.request(endpoint, { name: '容量玩家', moves: played }, first.cookie)).status, 410, 'idempotent result expires on its short TTL');
});
