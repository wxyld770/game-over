const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Accelerate the normal 15-second decision window and 1-second dealer pause.
process.env.DEAL_MS = '40';
process.env.TURN_MS = '500';
process.env.DEALER_PAUSE_MS = '500';
const repoRoot = process.env.GAME_OVER_ROOT || path.resolve(__dirname, '..');
const { server, testing } = require(path.join(repoRoot, 'server.js'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a timed-out hand auto-stands, then waits before the dealer reveals and draws', { timeout: 8_000 }, async (t) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { room, player } = testing.createRoom('Timer');
  t.after(async () => {
    for (const key of ['roundTimer', 'dealTimer', 'dealerTimer', 'matchTimer', 'resultsTimer']) {
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

  async function waitFor(phase) {
    const until = Date.now() + 3_000;
    while (Date.now() < until) {
      const current = await state();
      if (current.phase === phase) return current;
      await sleep(10);
    }
    assert.fail(`room did not reach ${phase}; current phase: ${(await state()).phase}`);
  }

  await action('start');
  // Player 10+8=18; dealer 6+8+3=17.
  room.shoe = Array.from({ length: 100 }, () => ({ rank: '2', suit: '♣' }))
    .concat(['10', '6', '8', '8', '3'].map((rank) => ({ rank, suit: '♠' })).reverse());
  await action('bet', { amount: 200 });
  const playing = await waitFor('playing');
  assert.equal(playing.players[0].status, 'playing');
  assert.ok(playing.deadlineAt > Date.now());

  const paused = await waitFor('dealer-turn');
  assert.equal(paused.players[0].status, 'stood');
  assert.equal(paused.players[0].roundResult, null);
  assert.equal(paused.dealer.cards.length, 1);
  assert.equal(paused.dealer.cardCount, 2);
  assert.equal(paused.deadlineAt, null);

  const settled = await waitFor('results');
  assert.equal(settled.dealer.cards.length, 3);
  assert.equal(settled.dealer.total, 17);
  assert.equal(settled.players[0].roundResult.delta, 200);
});
