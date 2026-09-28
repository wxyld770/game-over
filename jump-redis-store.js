const MAX_SCORE = require('./public/jump-rules.js').MAX_JUMPS * 8;

const UNAVAILABLE = '\u6392\u884c\u699c\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5';
const CAPACITY_REACHED = '\u6392\u884c\u699c\u4eba\u6570\u5df2\u8fbe\u4e0a\u9650\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5';
const CONNECT_TIMEOUT_MS = 3200;
const COMMAND_TIMEOUT_MS = 2000;

const READ_ENTRIES = `
local count = redis.call('HLEN', KEYS[1])
if count > tonumber(ARGV[1]) then
  return redis.error_reply('INVALID_LEADERBOARD')
end
return redis.call('HVALS', KEYS[1])
`;

// Updating the best score and returning its snapshot happen in one Redis command.
const SAVE_BEST = `
local candidate = cjson.decode(ARGV[1])
local maximum = tonumber(ARGV[2])
local count = redis.call('HLEN', KEYS[1])
if count > maximum then
  return redis.error_reply('INVALID_LEADERBOARD')
end
local value = redis.call('HGET', KEYS[1], candidate.playerId)
if not value and count >= maximum then
  return {-1}
end
local isPersonalBest = 1
if value then
  local valid, previous = pcall(cjson.decode, value)
  if not valid or type(previous) ~= 'table'
    or previous.playerId ~= candidate.playerId or type(previous.name) ~= 'string'
    or type(previous.achievedAt) ~= 'string' or type(previous.score) ~= 'number'
    or previous.score <= 0 or previous.score > tonumber(ARGV[3])
    or previous.score ~= math.floor(previous.score) then
    return redis.error_reply('INVALID_LEADERBOARD')
  end
  if candidate.score <= previous.score then
    isPersonalBest = 0
    candidate.score = previous.score
    candidate.achievedAt = previous.achievedAt
  end
end
redis.call('HSET', KEYS[1], candidate.playerId, cjson.encode(candidate))
return {isPersonalBest, redis.call('HVALS', KEYS[1])}
`;

function unavailable(message = UNAVAILABLE) {
  return Object.assign(new Error(message), { status: 503 });
}

function validateEntries(entries, maxEntries) {
  // A lazy import also allows the leaderboard module to select this store.
  return require('./jump-leaderboard.js').validateEntries(entries, maxEntries);
}

function decodeEntries(values, maxEntries) {
  if (!Array.isArray(values) || values.length > maxEntries) throw unavailable();
  return validateEntries(values.map((value) => JSON.parse(value)), maxEntries);
}

function createRedisStore({ url, client: providedClient, prefix = 'game-over:jump:v1', maxEntries = 10_000 } = {}) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(prefix)
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw unavailable();
  }
  const key = `${prefix}:players`;
  let client = providedClient;
  let listening = false;
  let connecting;
  let closed = false;

  function stopConnection(activeClient) {
    try {
      const stopped = typeof activeClient.destroy === 'function'
        ? activeClient.destroy() : activeClient.disconnect();
      if (stopped && typeof stopped.catch === 'function') stopped.catch(() => {});
    } catch {}
  }

  async function bounded(operation, milliseconds, activeClient) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            stopConnection(activeClient);
            reject(unavailable());
          }, milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function getClient() {
    if (closed) throw unavailable();
    if (!client) {
      let parsed;
      try { parsed = new URL(url); } catch { throw unavailable(); }
      if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw unavailable();
      client = require('redis').createClient({
        url,
        socket: { connectTimeout: 1500, reconnectStrategy: (retries) => retries < 1 ? 100 : false },
        disableOfflineQueue: true,
        commandsQueueMaxLength: 100,
      });
    }
    if (!listening) {
      // Redis errors can include connection credentials; never forward them to logs.
      client.on('error', () => {});
      listening = true;
    }
    return client;
  }

  async function ready() {
    const activeClient = getClient();
    if (activeClient.isReady) return activeClient;
    if (!connecting) {
      if (activeClient.isOpen) throw unavailable();
      connecting = bounded(() => activeClient.connect(), CONNECT_TIMEOUT_MS, activeClient);
    }
    const connection = connecting;
    try {
      await connection;
      if (closed || !activeClient.isReady) throw unavailable();
      return activeClient;
    } finally {
      if (connecting === connection) connecting = undefined;
    }
  }

  async function command(operation) {
    try {
      const activeClient = await ready();
      if (closed) throw unavailable();
      return await bounded(() => operation(activeClient), COMMAND_TIMEOUT_MS, activeClient);
    } catch {
      // Deliberately omit the original error/cause so server logging stays safe.
      throw unavailable();
    }
  }

  async function load() {
    try {
      const values = await command((activeClient) => activeClient.eval(READ_ENTRIES, {
        keys: [key], arguments: [String(maxEntries)],
      }));
      return decodeEntries(values, maxEntries);
    } catch {
      throw unavailable();
    }
  }

  async function saveBest(candidate) {
    try {
      const [validated] = validateEntries([candidate], maxEntries);
      // Refuse to overwrite an existing board containing malformed data.
      await load();
      const result = await command((activeClient) => activeClient.eval(SAVE_BEST, {
        keys: [key], arguments: [JSON.stringify(validated), String(maxEntries), String(MAX_SCORE)],
      }));
      if (!Array.isArray(result) || ![-1, 0, 1].includes(result[0])) throw unavailable();
      if (result[0] === -1) throw unavailable(CAPACITY_REACHED);
      if (result.length !== 2) throw unavailable();
      return { entries: decodeEntries(result[1], maxEntries), isPersonalBest: result[0] === 1 };
    } catch (error) {
      throw unavailable(error.message === CAPACITY_REACHED ? CAPACITY_REACHED : UNAVAILABLE);
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (client) stopConnection(client);
  }

  return { load, saveBest, close };
}

module.exports = { createRedisStore };
