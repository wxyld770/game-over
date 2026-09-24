const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const repoRoot = process.env.GAME_OVER_ROOT || path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'server.js');
const token = 'test-metrics-token-0123456789abcdef';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitFor(check) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* Server may still be starting. */ }
    await sleep(25);
  }
  assert.fail('Timed out waiting for the expected server state');
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

async function post(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, pathname === '/api/rooms' || pathname === '/api/rooms/join' ? 201 : 200);
  return response.json();
}

test('private, persistent aggregate metrics and live counts', { timeout: 20_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-over-metrics-'));
  const metricsFile = path.join(directory, 'metrics.json');
  let child;
  t.after(async () => {
    await stop(child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function start() {
    const port = await unusedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [serverPath], {
      cwd: repoRoot,
      env: {
        HOST: '127.0.0.1', PORT: String(port), OPEN_BROWSER: '0',
        METRICS_FILE: metricsFile, METRICS_TOKEN: token,
        BET_MS: '80', DEAL_MS: '80', TURN_MS: '80', DEALER_PAUSE_MS: '50',
      },
      stdio: 'ignore',
    });
    await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok);
    return baseUrl;
  }

  async function readMetrics(baseUrl) {
    const response = await fetch(`${baseUrl}/api/admin/metrics`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  let baseUrl = await start();
  const hidden = await fetch(`${baseUrl}/api/admin/metrics`);
  assert.equal(hidden.status, 404);
  const queryToken = await fetch(`${baseUrl}/api/admin/metrics?token=${token}`);
  assert.equal(queryToken.status, 404);

  const hostName = 'PrivacyHost_4935';
  const guestName = 'PrivacyGuest_4935';
  const { code, token: hostToken } = await post(baseUrl, '/api/rooms', { name: hostName });
  const { token: guestToken } = await post(baseUrl, '/api/rooms/join', { code, name: guestName });

  const streamController = new AbortController();
  const stream = await fetch(`${baseUrl}/api/rooms/${code}/events?token=${hostToken}`, {
    signal: streamController.signal,
  });
  assert.equal(stream.status, 200);
  const publicHealth = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.deepEqual(Object.keys(publicHealth).sort(), ['ok', 'rooms']);
  await waitFor(async () => {
    const { live } = await readMetrics(baseUrl);
    return live.activeRooms === 1 && live.activeConnections === 1 && live.onlinePlayers === 1;
  });
  streamController.abort();
  await waitFor(async () => (await readMetrics(baseUrl)).live.activeConnections === 0);

  await post(baseUrl, `/api/rooms/${code}/action`, { token: hostToken, action: 'start' });
  await waitFor(async () => {
    const state = await (await fetch(`${baseUrl}/api/rooms/${code}/state?token=${hostToken}`)).json();
    return state.phase === 'results';
  });
  const settled = await readMetrics(baseUrl);
  assert.equal(settled.dayTimezone, 'UTC');
  assert.equal(settled.persistence, 'ready');
  assert.equal(settled.totals.roomsCreated, 1);
  assert.equal(settled.totals.guestsJoined, 1);
  assert.equal(settled.totals.roomsWithFriends, 1);
  assert.equal(settled.totals.matchesStarted, 1);
  assert.equal(settled.totals.multiplayerMatchesStarted, 1);
  assert.equal(settled.totals.roundsDealt, 1);
  assert.equal(settled.totals.roundsSettled, 1);
  assert.equal(settled.totals.friendTablesCompletedFirstRound, 1);
  assert.equal(Object.values(settled.weeklyFriendTables).reduce((sum, count) => sum + count, 0), 1);

  await post(baseUrl, `/api/rooms/${code}/action`, { token: hostToken, action: 'next' });
  await post(baseUrl, `/api/rooms/${code}/action`, { token: hostToken, action: 'next' });
  assert.equal((await readMetrics(baseUrl)).totals.nextReadyClicks, 1);
  await post(baseUrl, `/api/rooms/${code}/action`, { token: guestToken, action: 'next' });
  assert.equal((await readMetrics(baseUrl)).totals.nextReadyClicks, 2);
  await waitFor(async () => {
    const state = await (await fetch(`${baseUrl}/api/rooms/${code}/state?token=${hostToken}`)).json();
    return state.phase === 'results' && state.round === 2;
  });
  assert.equal((await readMetrics(baseUrl)).totals.friendTablesCompletedFirstRound, 1,
    'one room contributes only once after more rounds');

  const saved = fs.readFileSync(metricsFile, 'utf8');
  assert.equal(fs.statSync(metricsFile).mode & 0o777, 0o600);
  for (const secret of [code, hostToken, guestToken, hostName, guestName]) {
    assert.equal(saved.includes(secret), false, 'stored metrics must not include room or player identifiers');
  }

  await stop(child);
  baseUrl = await start();
  const restored = await readMetrics(baseUrl);
  assert.equal(restored.totals.friendTablesCompletedFirstRound, 1);
  assert.equal(restored.totals.nextReadyClicks, 2);
  assert.equal(restored.live.rooms, 0, 'live rooms are intentionally not persisted');

  await stop(child);
  fs.writeFileSync(metricsFile, '{broken', { mode: 0o600 });
  baseUrl = await start();
  assert.equal((await readMetrics(baseUrl)).persistence, 'error');
  await post(baseUrl, '/api/rooms', { name: 'After corruption' });
  assert.equal(fs.readFileSync(metricsFile, 'utf8'), '{broken', 'corrupt data is kept for repair');
});
