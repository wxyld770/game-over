const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Keep production's 15-second betting/turn defaults. Only shorten the visual
// dealing interval so these HTTP tests do not spend most of their time waiting.
process.env.DEAL_MS = '300';
process.env.DEALER_PAUSE_MS = '300';
const repoRoot = process.env.GAME_OVER_ROOT || path.resolve(__dirname, '..');
const { server, testing } = require(path.join(repoRoot, 'server.js'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Blackjack match rules through HTTP', { timeout: 30_000 }, async (t) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const rooms = [];
  t.after(async () => {
    for (const room of rooms) {
      for (const key of ['roundTimer', 'dealTimer', 'dealerTimer', 'matchTimer', 'resultsTimer', 'hostTransferTimer']) {
        clearTimeout(room[key]);
      }
    }
    await new Promise((resolve) => server.close(resolve));
  });

  function newRoom(...names) {
    const { room, player } = testing.createRoom(names[0]);
    const players = [player];
    for (const name of names.slice(1)) {
      const seat = testing.makePlayer(name);
      room.players.push(seat);
      players.push(seat);
    }
    rooms.push(room);
    return { room, players };
  }

  function setDraws(room, draws) {
    const filler = Array.from({ length: 100 }, () => ({ rank: '2', suit: '♣' }));
    room.shoe = filler.concat(draws.map((rank) => ({ rank, suit: '♠' })).reverse());
  }

  async function request(room, player, action, extra = {}) {
    const response = await fetch(`${baseUrl}/api/rooms/${room.code}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: player.token, action, ...extra }),
    });
    return { status: response.status, body: await response.json() };
  }

  async function action(room, player, name, extra = {}) {
    const response = await request(room, player, name, extra);
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(response.body)}`);
    return response.body;
  }

  async function state(room, player) {
    const response = await fetch(`${baseUrl}/api/rooms/${room.code}/state?token=${encodeURIComponent(player.token)}`);
    assert.equal(response.status, 200);
    return response.json();
  }

  async function waitForPhase(room, player, phase) {
    const until = Date.now() + 4_000;
    while (Date.now() < until) {
      const current = await state(room, player);
      if (current.phase === phase) return current;
      await sleep(15);
    }
    assert.fail(`room ${room.code} did not reach ${phase}; current phase: ${(await state(room, player)).phase}`);
  }

  await t.test('host chooses a target and both countdowns are 15 seconds', async () => {
    const { room, players: [host] } = newRoom('Target host');
    const invalid = await request(room, host, 'start', { mode: 'target', targetBankroll: 1_000 });
    assert.equal(invalid.status, 409);
    assert.equal((await state(room, host)).phase, 'lobby');

    const betting = await action(room, host, 'start', { mode: 'target', targetBankroll: 2_500 });
    assert.equal(betting.matchMode, 'target');
    assert.equal(betting.targetBankroll, 2_500);
    assert.equal(betting.phase, 'betting');
    assert.ok(betting.deadlineAt - Date.now() > 14_000);
    assert.ok(betting.deadlineAt - Date.now() <= 15_100);

    setDraws(room, ['10', '9', '8', '7']);
    const dealing = await action(room, host, 'bet', { amount: 100 });
    assert.equal(dealing.phase, 'dealing');
    assert.equal(dealing.deadlineAt, null, 'turn timer starts after the dealing animation');
    assert.equal(dealing.canHit, false);
    assert.ok(Number.isSafeInteger(dealing.dealEndsAt));
    assert.ok(Math.abs(dealing.dealEndsAt - Date.now()) < 5_000);
    assert.equal((await request(room, host, 'hit')).status, 409);

    const playing = await waitForPhase(room, host, 'playing');
    assert.equal(playing.canHit, true);
    assert.ok(playing.deadlineAt - Date.now() > 14_000);
    assert.ok(playing.deadlineAt - Date.now() <= 15_100);
  });

  await t.test('dealer waits after stand, reveals later, then draws until 17', async () => {
    const { room, players: [player] } = newRoom('Stand pause');
    await action(room, player, 'start');
    // Player 10+8=18; dealer 6+8=14 then draws 2 and 3 to reach 19.
    setDraws(room, ['10', '6', '8', '8', '2', '3']);
    await action(room, player, 'bet', { amount: 100 });
    await waitForPhase(room, player, 'playing');
    const paused = await action(room, player, 'stand');
    assert.equal(paused.phase, 'dealer-turn');
    assert.equal(paused.deadlineAt, null);
    assert.equal(paused.dealer.cards.length, 1, 'hole card stays concealed during the pause');
    assert.equal(paused.dealer.cardCount, 2);
    assert.equal(paused.dealer.total, null);
    assert.equal(paused.players[0].roundResult, null);
    assert.equal(paused.canHit, false);
    assert.equal((await request(room, player, 'hit')).status, 409);
    const settled = await waitForPhase(room, player, 'results');
    assert.deepEqual(settled.dealer.cards.map((card) => card.rank), ['6', '8', '2', '3']);
    assert.equal(settled.dealer.total, 19);
    assert.equal(settled.players[0].roundResult.outcome, 'lose');
  });

  await t.test('a bust also pauses before the dealer reveals the hole card', async () => {
    const { room, players: [player] } = newRoom('Bust pause');
    await action(room, player, 'start');
    setDraws(room, ['10', '10', '8', '7', '10']);
    await action(room, player, 'bet', { amount: 100 });
    await waitForPhase(room, player, 'playing');
    const paused = await action(room, player, 'hit');
    assert.equal(paused.phase, 'dealer-turn');
    assert.equal(paused.players[0].status, 'bust');
    assert.equal(paused.players[0].cardCount, 3);
    assert.equal(paused.players[0].roundResult, null);
    assert.equal(paused.dealer.cards.length, 1);
    const settled = await waitForPhase(room, player, 'results');
    assert.equal(settled.players[0].roundResult.outcome, 'lose');
  });

  await t.test('all online players must ready next, including a broke creator', async () => {
    const { room, players: [host, firstGuest, secondGuest] } = newRoom('Broke creator', 'First guest', 'Second guest');
    await action(room, host, 'start');
    // Creator 8+8=16 loses all; guests keep chips against dealer 10+8=18.
    setDraws(room, ['8', '10', '9', '10', '8', '10', '9', '8']);
    await action(room, host, 'bet', { amount: 1_000 });
    await action(room, firstGuest, 'bet', { amount: 100 });
    await action(room, secondGuest, 'bet', { amount: 100 });
    await waitForPhase(room, host, 'playing');
    await action(room, host, 'stand');
    await action(room, firstGuest, 'stand');
    const paused = await action(room, secondGuest, 'stand');
    assert.equal(paused.phase, 'dealer-turn', 'dealer waits until everyone has acted');
    const settled = await waitForPhase(room, host, 'results');
    assert.equal(settled.players.find((p) => p.id === host.id).roundResult.outcome, 'lose');
    assert.equal(settled.players.find((p) => p.id === host.id).bankroll, 0);
    assert.equal((await state(room, host)).canNext, true);

    const firstReady = await action(room, host, 'next');
    assert.equal(firstReady.phase, 'results');
    assert.equal(firstReady.players.find((p) => p.id === host.id).readyNext, true);
    assert.equal(firstReady.canNext, false);
    assert.equal((await action(room, firstGuest, 'next')).phase, 'results');

    const nextRound = await action(room, secondGuest, 'next');
    assert.equal(nextRound.phase, 'betting');
    assert.equal(nextRound.round, 2);
  });

  await t.test('an offline player does not hold the table at results', async () => {
    const { room, players: [host, guest] } = newRoom('Online', 'Offline');
    await action(room, host, 'start');
    setDraws(room, ['10', '9', '10', '8', '9', '8']);
    await action(room, host, 'bet', { amount: 100 });
    await action(room, guest, 'bet', { amount: 100 });
    await waitForPhase(room, host, 'playing');
    await action(room, host, 'stand');
    assert.equal((await action(room, guest, 'stand')).phase, 'dealer-turn');
    await waitForPhase(room, host, 'results');

    guest.lastSeen = Date.now() - 1_000;
    assert.equal((await action(room, host, 'next')).phase, 'results', 'reconnect grace keeps a recent disconnect in the ready count');
    guest.lastSeen = Date.now() - 11_000;
    assert.equal((await state(room, host)).players.find((p) => p.id === guest.id).connected, false);
    const nextRound = await action(room, host, 'next');
    assert.equal(nextRound.phase, 'betting');
    assert.equal(nextRound.round, 2);
  });

  await t.test('double immediately raises the wager and deals exactly one card', async () => {
    const { room, players: [player] } = newRoom('Double');
    await action(room, player, 'start');
    setDraws(room, ['5', '8', '5', '8', '9']);
    await action(room, player, 'bet', { amount: 200 });
    const playing = await waitForPhase(room, player, 'playing');
    assert.equal(playing.canDouble, true);
    assert.equal(playing.players[0].cardCount, 2);

    const doubled = await action(room, player, 'double');
    assert.equal(doubled.phase, 'dealer-turn');
    assert.equal(doubled.players[0].wager, 400);
    assert.equal(doubled.players[0].cardCount, 3);
    assert.equal(doubled.players[0].status, 'stood');
    assert.equal(doubled.canDouble, false);
    assert.equal(doubled.canHit, false);
    assert.equal(doubled.dealer.cards.length, 1);
    assert.equal(doubled.players[0].roundResult, null);
    assert.equal((await request(room, player, 'double')).status, 409);
    assert.equal((await request(room, player, 'hit')).status, 409);
    assert.equal((await request(room, player, 'deal')).status, 409);
    const settled = await waitForPhase(room, player, 'results');
    assert.equal(settled.players[0].cardCount, 3);
    assert.equal(settled.players[0].wager, 400);
  });

  await t.test('equal hands lose half the wager, including natural Blackjack ties', async () => {
    for (const { draws, wager, loss } of [
      { draws: ['10', '10', '8', '8'], wager: 100, loss: 50 },
      { draws: ['A', 'A', 'K', 'K'], wager: 100, loss: 50 },
      { draws: ['10', '10', '8', '8'], wager: 101, loss: 51 },
    ]) {
      const { room, players: [player] } = newRoom(`Tie ${draws[0]}`);
      await action(room, player, 'start');
      setDraws(room, draws);
      await action(room, player, 'bet', { amount: wager });
      if (draws[0] !== 'A') {
        await waitForPhase(room, player, 'playing');
        assert.equal((await action(room, player, 'stand')).phase, 'dealer-turn');
      } else {
        await waitForPhase(room, player, 'dealer-turn');
      }
      const result = await waitForPhase(room, player, 'results');
      assert.equal(result.players[0].bankroll, 1_000 - loss);
      assert.equal(result.players[0].roundResult.delta, -loss);
    }
  });

  await t.test('a chosen target ends the match when first reached', async () => {
    const { room, players: [player] } = newRoom('First to goal');
    await action(room, player, 'start', { mode: 'target', targetBankroll: 1_050 });
    setDraws(room, ['10', '10', '10', '8']);
    await action(room, player, 'bet', { amount: 100 });
    await waitForPhase(room, player, 'playing');
    assert.equal((await action(room, player, 'stand')).phase, 'dealer-turn');
    const finished = await waitForPhase(room, player, 'finished');
    assert.equal(finished.players[0].bankroll, 1_100);
    assert.deepEqual(finished.winners, [player.id]);
  });

  await t.test('endless mode has a 10-minute deadline and settles by bankroll', async () => {
    const { room, players: [first, second] } = newRoom('Leader', 'Runner-up');
    const started = await action(room, first, 'start', { mode: 'endless' });
    assert.equal(started.matchMode, 'endless');
    assert.equal(started.matchDeadlineAt - started.matchStartedAt, 600_000);
    setDraws(room, ['10', '8', '10', '10', '8', '8']);
    await action(room, first, 'bet', { amount: 100 });
    await action(room, second, 'bet', { amount: 100 });
    await waitForPhase(room, first, 'playing');
    await action(room, first, 'stand');
    assert.equal((await action(room, second, 'stand')).phase, 'dealer-turn');
    const result = await waitForPhase(room, first, 'results');
    assert.ok(result.players.find((p) => p.id === first.id).bankroll > result.players.find((p) => p.id === second.id).bankroll);

    testing.expireMatch(room);
    const finished = await state(room, first);
    assert.equal(finished.phase, 'finished');
    assert.deepEqual(finished.winners, [first.id]);
  });

  await t.test('the match deadline settles active hands after a double', async () => {
    const { room, players: [doubled, other] } = newRoom('Doubled', 'Other');
    await action(room, doubled, 'start', { mode: 'endless' });
    // Doubled 5+5+9=19 beats dealer 8+8+2=18; other 6+6=12 loses.
    setDraws(room, ['5', '6', '8', '5', '6', '8', '9']);
    await action(room, doubled, 'bet', { amount: 200 });
    await action(room, other, 'bet', { amount: 100 });
    await waitForPhase(room, doubled, 'playing');
    const raised = await action(room, doubled, 'double');
    assert.equal(raised.players.find((p) => p.id === doubled.id).cardCount, 3);
    assert.equal(raised.players.find((p) => p.id === doubled.id).wager, 400);

    testing.expireMatch(room);
    const paused = await state(room, doubled);
    assert.equal(paused.phase, 'dealer-turn');
    assert.equal(paused.players.find((p) => p.id === doubled.id).roundResult, null);
    const finished = await waitForPhase(room, doubled, 'finished');
    assert.equal(finished.players.find((p) => p.id === doubled.id).cardCount, 3);
    assert.equal(finished.players.find((p) => p.id === doubled.id).bankroll, 1_400);
    assert.deepEqual(finished.winners, [doubled.id]);
  });

  await t.test('endless mode ends early when the only other player loses all chips', async () => {
    const { room, players: [survivor, allIn] } = newRoom('Survivor', 'All-in');
    await action(room, survivor, 'start', { mode: 'endless' });
    setDraws(room, ['10', '8', '10', '10', '8', '8']);
    await action(room, survivor, 'bet', { amount: 100 });
    await action(room, allIn, 'bet', { amount: 1_000 });
    await waitForPhase(room, survivor, 'playing');
    await action(room, survivor, 'stand');
    assert.equal((await action(room, allIn, 'stand')).phase, 'dealer-turn');
    const finished = await waitForPhase(room, survivor, 'finished');
    assert.equal(finished.players.find((p) => p.id === allIn.id).bankroll, 0);
    assert.deepEqual(finished.winners, [survivor.id]);
  });

  await t.test('a solo endless match ends when its player runs out of chips', async () => {
    const { room, players: [player] } = newRoom('Solo');
    await action(room, player, 'start', { mode: 'endless' });
    setDraws(room, ['8', '10', '8', '8']);
    await action(room, player, 'bet', { amount: 1_000 });
    await waitForPhase(room, player, 'playing');
    assert.equal((await action(room, player, 'stand')).phase, 'dealer-turn');
    const finished = await waitForPhase(room, player, 'finished');
    assert.equal(finished.players[0].bankroll, 0);
    assert.deepEqual(finished.winners, []);
  });

});
