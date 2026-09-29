const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createRedisStore } = require('../jump-redis-store.js');

const AT = '2026-09-28T08:00:00.000Z';
const LATER = '2026-09-28T09:00:00.000Z';
const UNAVAILABLE = '\u6392\u884c\u699c\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5';
const id = (name) => crypto.createHash('sha256').update(name).digest('hex');
const entry = (player = 'a', score = 10, name = 'Player', achievedAt = AT) => ({
  playerId: id(player), name, score, achievedAt,
});

function fakeClient() {
  const client = new EventEmitter();
  client.isReady = false;
  client.isOpen = false;
  client.connects = 0;
  client.commands = [];
  client.destroyed = 0;
  client.connect = async () => {
    client.connects += 1;
    client.isOpen = true;
    client.isReady = true;
  };
  client.eval = async (script, options) => {
    client.commands.push({ script, options });
    return [];
  };
  client.destroy = () => {
    client.destroyed += 1;
    client.isReady = false;
    client.isOpen = false;
  };
  return client;
}

function isUnavailable(error) {
  assert.equal(error.status, 503);
  assert.equal(error.message, UNAVAILABLE);
  assert.equal(error.cause, undefined);
  return true;
}

test('Redis leaderboard connects lazily, shares a pending connection and closes once', async () => {
  const client = fakeClient();
  let connect;
  client.connect = () => {
    client.connects += 1;
    client.isOpen = true;
    return new Promise((resolve) => { connect = () => { client.isReady = true; resolve(); }; });
  };
  const store = createRedisStore({ client });
  assert.equal(client.connects, 0);
  const reads = [store.load(), store.load()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.connects, 1);
  connect();
  assert.deepEqual(await Promise.all(reads), [[], []]);
  assert.deepEqual(client.commands[0].options, {
    keys: ['game-over:jump:v1:players'], arguments: ['10000'],
  });
  await store.close();
  await store.close();
  assert.equal(client.destroyed, 1);
  await assert.rejects(store.load(), isUnavailable);

  const unconfigured = createRedisStore();
  await assert.rejects(unconfigured.load(), isUnavailable);
  await unconfigured.close();
});

test('Redis leaderboard validates stored records before writing and hides raw errors', async () => {
  const client = fakeClient();
  const store = createRedisStore({ client });
  client.eval = async () => [JSON.stringify(entry()), JSON.stringify(entry())];
  await assert.rejects(store.load(), isUnavailable);
  let commands = 0;
  client.eval = async () => { commands += 1; return ['{broken']; };
  await assert.rejects(store.saveBest(entry()), isUnavailable);
  assert.equal(commands, 1, 'invalid stored data must be rejected before the write command');
  await assert.rejects(store.saveBest({ ...entry(), score: -1 }), isUnavailable);
  assert.equal(commands, 1, 'invalid candidates must not reach Redis');

  const sensitive = 'redis://operator:private-password@database.invalid:6379';
  client.eval = async () => { throw new Error(sensitive); };
  await assert.rejects(store.load(), isUnavailable);
  await assert.rejects(store.saveBest(entry()), isUnavailable);
  client.emit('error', new Error(sensitive));
  await store.close();
});

test('Redis leaderboard passes namespaced atomic writes and validates their snapshots', async () => {
  const client = fakeClient();
  const candidate = entry('a', 20, 'Alice');
  client.eval = async (script, options) => {
    client.commands.push({ script, options });
    return options.arguments.length === 1 ? [] : [1, [JSON.stringify(candidate)]];
  };
  const store = createRedisStore({ client, prefix: 'game-over:jump:test', maxEntries: 3 });
  assert.deepEqual(await store.saveBest(candidate), { entries: [candidate], isPersonalBest: true });
  const write = client.commands[1];
  assert.deepEqual(write.options.keys, ['game-over:jump:test:players']);
  assert.equal(write.options.arguments[0], JSON.stringify(candidate));
  assert.equal(write.options.arguments[1], '3');
  client.eval = async (script, options) => options.arguments.length === 1 ? [] : [1, ['{bad']];
  await assert.rejects(store.saveBest(candidate), isUnavailable);
  await store.close();
});

test('Redis leaderboard supports an isolated game validator and score ceiling', async () => {
  const client = fakeClient();
  const candidate = entry('match-player', 500_000, 'Matcher');
  let validations = 0;
  const validateEntries = (entries, maximum) => {
    validations += 1;
    assert.equal(maximum, 5);
    if (entries.some((value) => value.score > 1_000_000)) throw new Error('invalid match score');
    return entries;
  };
  client.eval = async (script, options) => {
    client.commands.push({ script, options });
    return options.arguments.length === 1 ? [] : [1, [JSON.stringify(candidate)]];
  };
  const store = createRedisStore({
    client,
    prefix: 'game-over:match3:test',
    maxEntries: 5,
    maxScore: 1_000_000,
    validateEntries,
  });
  assert.deepEqual(await store.saveBest(candidate), { entries: [candidate], isPersonalBest: true });
  const write = client.commands[1];
  assert.deepEqual(write.options.keys, ['game-over:match3:test:players']);
  assert.deepEqual(write.options.arguments.slice(1), ['5', '1000000']);
  assert.equal(validations, 3, 'existing entries, candidate, and Redis snapshot use the game-specific validator');
  await store.close();
});

test('Redis leaderboard recovers after a failed connect and bounds stuck commands', async () => {
  const client = fakeClient();
  let attempts = 0;
  client.connect = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('redis://user:secret@server.invalid');
    client.isReady = true;
    client.isOpen = true;
  };
  const store = createRedisStore({ client });
  await assert.rejects(store.load(), isUnavailable);
  assert.deepEqual(await store.load(), []);
  assert.equal(attempts, 2);
  client.eval = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(store.load(), isUnavailable);
  assert.ok(Date.now() - started < 4000);
  assert.equal(client.destroyed, 1);
  await store.close();
});

const redisServer = process.env.JUMP_TEST_REDIS_SERVER || 'redis-server';
const hasRedisServer = spawnSync(redisServer, ['--version'], { stdio: 'ignore' }).status === 0;

async function redisFixture(t, maxEntries = 3) {
  const directory = await fs.mkdtemp('/tmp/game-over-jump-redis-');
  const socket = path.join(directory, 'redis.sock');
  const process = spawn(redisServer, [
    '--port', '0', '--unixsocket', socket, '--unixsocketperm', '700',
    '--save', '', '--appendonly', 'no', '--dir', directory,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const clients = [];
  t.after(async () => {
    for (const store of clients) await store.close();
    if (process.exitCode === null && process.signalCode === null) {
      const exited = new Promise((resolve) => process.once('exit', resolve));
      process.kill('SIGTERM');
      await exited;
    }
    await fs.rm(directory, { force: true, recursive: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => complete(new Error('Local Redis startup timed out')), 5000);
    const complete = (error) => {
      clearTimeout(timer);
      process.stdout.off('data', onData);
      process.off('error', onError);
      process.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onData = (data) => { if (/ready to accept connections/i.test(data.toString())) complete(); };
    const onError = (error) => complete(error);
    const onExit = () => complete(new Error('Local Redis exited before startup'));
    process.stdout.on('data', onData);
    process.once('error', onError);
    process.once('exit', onExit);
  });
  function store(prefix = 'game-over:jump:v1', options = {}) {
    const client = require('redis').createClient({
      socket: { path: socket, reconnectStrategy: false }, disableOfflineQueue: true,
    });
    const instance = createRedisStore({ client, prefix, maxEntries, ...options });
    clients.push(instance);
    return { instance, client };
  }
  return { store };
}

test('Redis Lua saves concurrent personal bests, tie order, capacity and isolated namespaces', { skip: !hasRedisServer }, async (t) => {
  const local = await redisFixture(t);
  const first = local.store();
  const second = local.store();
  await Promise.all([
    first.instance.saveBest(entry('a', 20, 'Alice')),
    second.instance.saveBest(entry('b', 10, 'Bob')),
    second.instance.saveBest(entry('a', 3, 'Alice')),
  ]);
  const entries = await first.instance.load();
  assert.equal(entries.length, 2);
  assert.equal(entries.find((row) => row.playerId === id('a')).score, 20);
  const tie = await second.instance.saveBest(entry('a', 20, 'New name', LATER));
  assert.equal(tie.isPersonalBest, false);
  assert.deepEqual(tie.entries.find((row) => row.playerId === id('a')), entry('a', 20, 'New name', AT));
  const lower = await first.instance.saveBest(entry('a', 1, 'Latest name', LATER));
  assert.equal(lower.isPersonalBest, false);
  assert.deepEqual(lower.entries.find((row) => row.playerId === id('a')), entry('a', 20, 'Latest name', AT));
  const competing = await Promise.allSettled([
    first.instance.saveBest(entry('c', 15, 'Carol')),
    second.instance.saveBest(entry('d', 25, 'Dave')),
  ]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(competing.find((result) => result.status === 'rejected').reason.status, 503);
  assert.equal((await first.instance.load()).length, 3);
  const improved = await first.instance.saveBest(entry('a', 25, 'Alice', LATER));
  assert.equal(improved.isPersonalBest, true);
  assert.deepEqual(improved.entries.find((row) => row.playerId === id('a')), entry('a', 25, 'Alice', LATER));
  const isolated = local.store('game-over:jump:separate');
  assert.deepEqual(await isolated.instance.load(), []);
  await isolated.instance.saveBest(entry('d', 30, 'Dave'));
  assert.equal((await first.instance.load()).length, 3);
  const match = local.store('game-over:match3:v1', {
    maxScore: 1_000_000,
    validateEntries: (values, maximum) => {
      assert.ok(values.length <= maximum);
      if (values.some((value) => !Number.isInteger(value.score) || value.score > 1_000_000)) throw new Error('invalid match score');
      return values;
    },
  });
  const matchEntry = entry('match', 500_000, 'Matcher');
  await match.instance.saveBest(matchEntry);
  assert.deepEqual(await match.instance.load(), [matchEntry]);
  assert.equal((await first.instance.load()).length, 3, 'match-3 key space is isolated from jump scores');
  await first.instance.close();
  const restarted = local.store();
  assert.deepEqual(await restarted.instance.load(), await second.instance.load());
});

test('Redis Lua rejects malformed data without overwriting it', { skip: !hasRedisServer }, async (t) => {
  const local = await redisFixture(t);
  const { instance, client } = local.store();
  await instance.load();
  const key = 'game-over:jump:v1:players';
  await client.hSet(key, id('a'), '{broken');
  await assert.rejects(instance.load(), isUnavailable);
  await assert.rejects(instance.saveBest(entry()), isUnavailable);
  assert.equal(await client.hGet(key, id('a')), '{broken');
});
