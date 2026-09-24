const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// This separate test process accelerates the normal 15-second turn deadline.
process.env.DEAL_MS = '40';
process.env.TURN_MS = '1500';
const repoRoot = process.env.GAME_OVER_ROOT || path.resolve(__dirname, '..');
const { server, testing } = require(path.join(repoRoot, 'server.js'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('an unclaimed doubled hand receives its one card at the turn deadline', { timeout: 8_000 }, async (t) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { room, player } = testing.createRoom('Timer');
  t.after(async () => {
    for (const key of ['roundTimer', 'dealTimer', 'matchTimer', 'resultsTimer', 'hostTransferTimer']) {
      clearTimeout(room[key]);
    }
    await new Promise((resolve) => server.close(resolve));
  });

  async function action(name, extra = {}) {
    const response = await fetch(`${baseUrl}/api/rooms/${room.code}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: player.token, action: name, ...extra }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(body)}`);
    return body;
  }

  async function state() {
    const response = await fetch(`${baseUrl}/api/rooms/${room.code}/state?token=${encodeURIComponent(player.token)}`);
    assert.equal(response.status, 200);
    return response.json();
  }

  await action('start');
  // Player 5+5=10, dealer 8+8=16, automatic double card 9 -> 19.
  room.shoe = Array.from({ length: 100 }, () => ({ rank: '2', suit: '♣' }))
    .concat(['5', '8', '5', '8', '9'].map((rank) => ({ rank, suit: '♠' })).reverse());
  await action('bet', { amount: 200 });
  const dealDeadline = Date.now() + 4_000;
  while ((await state()).phase === 'dealing' && Date.now() < dealDeadline) await sleep(10);
  assert.equal((await state()).phase, 'playing');

  const doubled = await action('double');
  assert.equal(doubled.players[0].wager, 400);
  assert.equal(doubled.players[0].cardCount, 2);
  assert.equal(doubled.canDeal, true);

  const turnDeadline = Date.now() + 3_000;
  let settled;
  do {
    settled = await state();
    if (settled.phase === 'results') break;
    await sleep(20);
  } while (Date.now() < turnDeadline);
  assert.equal(settled.phase, 'results');
  assert.equal(settled.players[0].cardCount, 3);
  assert.equal(settled.players[0].wager, 400);
  assert.equal(settled.players[0].roundResult.delta, 400);
});
