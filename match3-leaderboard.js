const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const Match3Rules = require('./public/match3-rules.js');

const COOKIE_NAME = 'match3_player';
const DEFAULT_LIMITS = Object.freeze({
  runTtlMs: 12 * 60 * 60_000,
  completedTtlMs: 10 * 60_000,
  maxRuns: 2000,
  startWindowMs: 10 * 60_000,
  maxStartsPerAddress: 120,
  finishWindowMs: 60_000,
  maxFinishesPerAddress: 30,
  maxAddresses: 10_000,
  maxEntries: 10_000,
});
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;

function requestError(status, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = status;
  return error;
}

function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || [...name].length > 18 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) return null;
  return name;
}

function entryKey(entry) {
  return `${entry.playerId}:${entry.name}`;
}

function validateEntries(entries, maxEntries) {
  if (!Array.isArray(entries) || entries.length > maxEntries) throw new Error('Invalid leaderboard entries');
  const players = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.playerId !== 'string' || !/^[a-f0-9]{64}$/.test(entry.playerId)
      || players.has(entryKey(entry)) || typeof entry.name !== 'string' || normalizeName(entry.name) !== entry.name
      || !Number.isInteger(entry.score) || entry.score <= 0 || entry.score > Match3Rules.MAX_SCORE
      || typeof entry.achievedAt !== 'string' || !Number.isFinite(Date.parse(entry.achievedAt))
      || new Date(entry.achievedAt).toISOString() !== entry.achievedAt) {
      throw new Error('Invalid leaderboard entry');
    }
    players.add(entryKey(entry));
    return { playerId: entry.playerId, name: entry.name, score: entry.score, achievedAt: entry.achievedAt };
  });
}

function createFileStore(filePath, options = {}) {
  const storage = { ...fs, ...options.storage };
  const maxEntries = options.maxEntries || DEFAULT_LIMITS.maxEntries;
  let entries = new Map();
  let loading;
  let queue = Promise.resolve();

  async function load() {
    if (!loading) {
      loading = (async () => {
        try {
          const stat = await storage.stat(filePath);
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid leaderboard file');
          const value = JSON.parse(await storage.readFile(filePath, 'utf8'));
          if (!value || value.version !== 1) throw new Error('Invalid leaderboard file version');
          const saved = validateEntries(value.entries, maxEntries);
          entries = new Map(saved.map((entry) => [entryKey(entry), entry]));
        } catch (error) {
          if (error.code !== 'ENOENT') throw requestError(503, '排行榜暂时不可用，请稍后再试', error);
        }
      })();
    }
    await loading;
    return [...entries.values()];
  }

  async function persist(nextEntries) {
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await storage.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await storage.writeFile(temporary, `${JSON.stringify({ version: 1, entries: [...nextEntries.values()] })}\n`, { flag: 'wx', mode: 0o600 });
      await storage.rename(temporary, filePath);
    } catch (error) {
      try { await storage.unlink(temporary); } catch {}
      throw requestError(503, '成绩暂未保存，请稍后重试', error);
    }
  }

  function saveBest(candidate) {
    const operation = queue.then(async () => {
      await load();
      [candidate] = validateEntries([candidate], maxEntries);
      const key = entryKey(candidate);
      const previous = entries.get(key);
      if (!previous && entries.size >= maxEntries) throw requestError(503, '排行榜人数已达上限，请稍后再试');
      const isPersonalBest = !previous || candidate.score > previous.score;
      if (isPersonalBest) {
        const nextEntries = new Map(entries);
        nextEntries.set(key, candidate);
        await persist(nextEntries);
        entries = nextEntries;
      }
      return { entries: [...entries.values()], isPersonalBest };
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { load, saveBest };
}

function cookieToken(req) {
  if (typeof req.headers.cookie !== 'string') return '';
  const entry = req.headers.cookie.split(';').map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
  const token = entry ? entry.slice(COOKIE_NAME.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}

function playerId(token) {
  return token ? crypto.createHash('sha256').update(token).digest('hex') : '';
}

function cookieHeader(req, token) {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const secure = req.socket.encrypted || (loopback && req.headers['x-forwarded-proto'] === 'https');
  return `${COOKIE_NAME}=${token}; Path=/api/match3/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`;
}

function clientAddress(req) {
  const address = req.socket.remoteAddress || 'unknown';
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    const proxied = req.headers['x-real-ip'];
    if (typeof proxied === 'string' && net.isIP(proxied.trim())) return proxied.trim();
  }
  return address;
}

async function readJson(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_REQUEST_BYTES) throw requestError(413, '请求内容过长');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw requestError(400, '请求格式有误');
  }
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function leaderboard(entries, identity, name = null) {
  const sorted = [...entries].sort((a, b) => b.score - a.score
    || a.achievedAt.localeCompare(b.achievedAt) || a.playerId.localeCompare(b.playerId) || a.name.localeCompare(b.name));
  let me = null;
  const publicEntries = [];
  sorted.forEach((entry, index) => {
    const row = { rank: index + 1, name: entry.name, score: entry.score, achievedAt: entry.achievedAt };
    if (index < 20) publicEntries.push(row);
    if (!me && entry.playerId === identity && (name === null || entry.name === name)) me = row;
  });
  return { entries: publicEntries, me };
}

function createMatch3Leaderboard(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const filePath = options.filePath || process.env.MATCH3_LEADERBOARD_FILE
    || path.join(process.env.STATE_DIRECTORY || path.join(__dirname, '.data'), 'match3-leaderboard.json');
  const store = options.store || createFileStore(filePath, { maxEntries: limits.maxEntries, storage: options.storage });
  const now = options.now || Date.now;
  const seed = options.seed || (() => crypto.randomInt(0, 4294967296));
  const logError = options.logError || ((error) => console.error('Match-3 leaderboard:', error));
  const runs = new Map();
  const startAttempts = new Map();
  const finishAttempts = new Map();

  function sweep(timestamp) {
    for (const [id, run] of runs) if (run.expiresAt <= timestamp) runs.delete(id);
    for (const [attempts, windowMs] of [[startAttempts, limits.startWindowMs], [finishAttempts, limits.finishWindowMs]]) {
      for (const [address, times] of attempts) {
        const recent = times.filter((time) => time > timestamp - windowMs);
        if (recent.length) attempts.set(address, recent);
        else attempts.delete(address);
      }
    }
  }

  function reserveAttempt(req, attempts, windowMs, maximum) {
    const timestamp = now();
    const address = clientAddress(req);
    const recent = (attempts.get(address) || []).filter((time) => time > timestamp - windowMs);
    if (recent.length >= maximum || (!attempts.has(address) && attempts.size >= limits.maxAddresses)) {
      throw requestError(429, '操作过于频繁，请稍后再试');
    }
    recent.push(timestamp);
    attempts.set(address, recent);
  }

  async function handleRequest(req, res, pathname) {
    try {
      if (pathname === '/api/match3/leaderboard') {
        if (req.method !== 'GET') throw requestError(405, '请求方式不支持');
        sweep(now());
        const entries = await store.load();
        const name = normalizeName(new URL(req.url, 'http://localhost').searchParams.get('name'));
        return sendJson(res, 200, leaderboard(entries, playerId(cookieToken(req)), name));
      }
      if (pathname === '/api/match3/runs') {
        if (req.method !== 'POST') throw requestError(405, '请求方式不支持');
        sweep(now());
        reserveAttempt(req, startAttempts, limits.startWindowMs, limits.maxStartsPerAddress);
        await readJson(req);
        await store.load();
        const token = cookieToken(req) || crypto.randomBytes(32).toString('base64url');
        const identity = playerId(token);
        for (const [id, run] of runs) {
          if (!run.result && run.playerId === identity) runs.delete(id);
        }
        const activeRuns = [...runs.values()].filter((run) => !run.result);
        if (activeRuns.length >= limits.maxRuns) {
          throw requestError(429, '当前游戏人数较多，请稍后再试');
        }
        const timestamp = now();
        const run = {
          id: crypto.randomUUID(),
          playerId: identity,
          seed: seed(),
          createdAt: timestamp,
          expiresAt: timestamp + limits.runTtlMs,
          result: null,
          finishHash: null,
        };
        runs.set(run.id, run);
        return sendJson(res, 201, { runId: run.id, seed: run.seed, expiresAt: run.expiresAt }, {
          'Set-Cookie': cookieHeader(req, token),
        });
      }
      const match = /^\/api\/match3\/runs\/([a-f0-9-]{36})\/finish$/.exec(pathname);
      if (!match) throw requestError(404, '接口不存在');
      if (req.method !== 'POST') throw requestError(405, '请求方式不支持');
      reserveAttempt(req, finishAttempts, limits.finishWindowMs, limits.maxFinishesPerAddress);
      const run = runs.get(match[1]);
      if (!run) throw requestError(404, '本局不存在，请重新开始');
      if (!run.playerId || playerId(cookieToken(req)) !== run.playerId) throw requestError(403, '本局身份无效，请重新开始');
      if (run.expiresAt <= now()) {
        runs.delete(run.id);
        throw requestError(410, '本局已过期，请重新开始');
      }
      const body = await readJson(req);
      const name = normalizeName(body.name);
      if (!name) throw requestError(400, '昵称需要 1 到 18 个字符');
      if (Object.hasOwn(body, 'score')) throw requestError(400, '成绩须由交换记录计算');
      const finishHash = crypto.createHash('sha256').update(JSON.stringify([name, body.moves])).digest('hex');
      if (run.result) {
        if (finishHash !== run.finishHash) throw requestError(409, '本局已提交，请重新开始');
        return sendJson(res, 200, run.result);
      }
      if (run.pending) {
        if (finishHash !== run.pending.hash) throw requestError(409, '本局正在提交，请稍后重试');
        return sendJson(res, 200, await run.pending.promise);
      }
      let replay;
      try {
        replay = Match3Rules.replay(run.seed, body.moves);
      } catch {
        throw requestError(400, '交换记录无效或还没有有效消除');
      }
      if (now() - run.createdAt < Math.max(0, replay.durationMs * 0.9 - 250)) {
        throw requestError(409, '本局进行时间过短，请稍后重试');
      }
      const submission = (async () => {
        const saved = await store.saveBest({
          playerId: run.playerId,
          name,
          score: replay.score,
          achievedAt: new Date(now()).toISOString(),
        });
        const board = leaderboard(saved.entries, run.playerId, name);
        const result = {
          score: replay.score,
          saved: true,
          personalBest: board.me ? board.me.score : replay.score,
          isPersonalBest: saved.isPersonalBest,
          rank: board.me ? board.me.rank : null,
          ...board,
        };
        run.result = result;
        run.finishHash = finishHash;
        run.expiresAt = Math.min(run.expiresAt, now() + limits.completedTtlMs);
        return result;
      })();
      run.pending = { hash: finishHash, promise: submission };
      try {
        return sendJson(res, 200, await submission);
      } finally {
        run.pending = null;
      }
    } catch (error) {
      if (error.status >= 500 || !error.status) logError(error.cause || error);
      if (!res.headersSent) return sendJson(res, error.status || 503, {
        error: error.status ? error.message : '排行榜暂时不可用，请稍后再试',
      });
      res.end();
    }
  }

  return { handleRequest, store, testing: { runs, startAttempts, finishAttempts, limits } };
}

module.exports = {
  createMatch3Leaderboard,
  createFileStore,
  normalizeName,
  validateEntries,
  limits: DEFAULT_LIMITS,
};
