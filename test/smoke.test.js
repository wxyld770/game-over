const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const repoRoot = process.env.GAME_OVER_ROOT || path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'server.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitUntilReady(baseUrl, child, logs) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited before becoming ready.\n${logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await sleep(100);
  }
  throw new Error(`Server did not become ready.\n${logs()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timeout;
  await Promise.race([
    exited,
    new Promise((resolve) => { timeout = setTimeout(resolve, 2_000); }),
  ]);
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('HTTP smoke: health, homepage, room creation, joining, capacity', { timeout: 20_000 }, async (t) => {
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { HOST: '127.0.0.1', PORT: String(port), OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk) => { output = (output + chunk.toString()).slice(-4_096); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  t.after(() => stopChild(child));

  await waitUntilReady(baseUrl, child, () => output);

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const homepage = await fetch(`${baseUrl}/`);
  assert.equal(homepage.status, 200);
  const homeHtml = await homepage.text();
  assert.match(homeHtml, /<title>GAME OVER · 小游戏大厅<\/title>/);
  assert.match(homeHtml, /<meta property="og:url" content="https:\/\/game\.5iyeji\.xyz\/" \/>/);
  for (const slug of ['blackjack', 'sudoku', 'minesweeper', 'spider', 'jump', 'match3', 'doudizhu']) {
    const response = await fetch(`${baseUrl}/${slug}`);
    assert.equal(response.status, 200, `${slug} should open from the game hub`);
    assert.match(await response.text(), /<html lang="zh-CN">/);
  }

  const create = await postJson(`${baseUrl}/api/rooms`, { name: 'Host' });
  assert.equal(create.status, 201);
  const { code, token } = await create.json();
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);

  const inviteHtml = await (await fetch(`${baseUrl}/?room=${code}`)).text();
  assert.match(inviteHtml, /<title>21 点 · 朋友牌桌<\/title>/);
  assert.ok(inviteHtml.includes(`<meta property="og:url" content="https://game.5iyeji.xyz/?room=${code}" />`));
  const newInviteHtml = await (await fetch(`${baseUrl}/blackjack?room=${code}`)).text();
  assert.ok(newInviteHtml.includes(`<meta property="og:url" content="https://game.5iyeji.xyz/blackjack?room=${code}" />`));
  const invalidInviteHtml = await (await fetch(`${baseUrl}/?room=%3Cscript%3E`)).text();
  assert.match(invalidInviteHtml, /<meta property="og:url" content="https:\/\/game\.5iyeji\.xyz\/" \/>/);

  for (let seat = 2; seat <= 6; seat += 1) {
    const join = await postJson(`${baseUrl}/api/rooms/join`, {
      code,
      name: `Player ${seat}`,
    });
    assert.equal(join.status, 201, `seat ${seat} should be available`);
    const joined = await join.json();
    assert.equal(joined.code, code);
    assert.ok(joined.token);
  }

  const state = await fetch(`${baseUrl}/api/rooms/${code}/state?token=${encodeURIComponent(token)}`);
  assert.equal(state.status, 200);
  const room = await state.json();
  assert.equal(room.players.length, 6);
  assert.equal(room.isHost, true);

  const full = await postJson(`${baseUrl}/api/rooms/join`, { code, name: 'Player 7' });
  assert.equal(full.status, 409);
});
