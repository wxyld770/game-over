const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.DOUDIZHU_AI_MS = '25';
const repoRoot = process.env.GAME_OVER_ROOT || path.resolve(__dirname, '..');
const { server } = require(path.join(repoRoot, 'server.js'));
const { testing } = require(path.join(repoRoot, 'doudizhu-server.js'));
const { DECK, classifyCards, beats, rooms, createAttempts, limits } = testing;

function cards(groups) {
  return groups.flatMap(([value, count]) => DECK.filter((card) => card.value === value).slice(0, count).map((card) => card.id));
}

test('斗地主常见牌型、非法牌型与大小比较', () => {
  const cases = [
    ['single', [[3, 1]]],
    ['pair', [[3, 2]]],
    ['triple', [[3, 3]]],
    ['triple-single', [[3, 3], [4, 1]]],
    ['triple-pair', [[3, 3], [4, 2]]],
    ['straight', [[3, 1], [4, 1], [5, 1], [6, 1], [7, 1]]],
    ['pair-straight', [[3, 2], [4, 2], [5, 2]]],
    ['plane', [[3, 3], [4, 3]]],
    ['plane-single', [[3, 3], [4, 3], [5, 1], [6, 1]]],
    ['plane-pair', [[3, 3], [4, 3], [5, 2], [6, 2]]],
    ['four-two-single', [[3, 4], [4, 1], [5, 1]]],
    ['four-two-pair', [[3, 4], [4, 2], [5, 2]]],
    ['bomb', [[3, 4]]],
    ['rocket', [[16, 1], [17, 1]]],
  ];
  for (const [type, groups] of cases) assert.equal(classifyCards(cards(groups))?.type, type, type);
  assert.equal(classifyCards(cards([[3, 1], [4, 1], [5, 1], [6, 1], [15, 1]])), null, '顺子不能含 2');
  assert.equal(classifyCards(cards([[3, 1], [4, 1], [5, 1], [6, 1], [16, 1]])), null, '顺子不能含王');
  assert.equal(classifyCards([0, 0]), null, '同一张牌不能重复');
  assert.equal(classifyCards([54]), null, '牌 id 越界');
  assert.equal(beats(classifyCards(cards([[4, 2]])), classifyCards(cards([[3, 2]]))), true);
  assert.equal(beats(classifyCards(cards([[4, 1]])), classifyCards(cards([[3, 2]]))), false);
  assert.equal(beats(classifyCards(cards([[3, 4]])), classifyCards(cards([[14, 1]]))), true);
  assert.equal(beats(classifyCards(cards([[16, 1], [17, 1]])), classifyCards(cards([[15, 4]]))), true);
  assert.equal(beats(classifyCards(cards([[3, 4]])), classifyCards(cards([[16, 1], [17, 1]]))), false);
});

test('斗地主 HTTP：手牌隐藏、叫分、合法出牌与地主胜负结算', { timeout: 10_000 }, async (t) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const room of rooms.values()) {
      clearTimeout(room.turnTimer);
      clearTimeout(room.aiTimer);
      clearTimeout(room.presenceTimer);
      for (const player of room.players) for (const client of player.clients) client.end();
    }
    rooms.clear();
    createAttempts.clear();
    await new Promise((resolve) => server.close(resolve));
  });

  async function post(endpoint, body) {
    const response = await fetch(`${base}/api/doudizhu${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function action(code, token, name, extra = {}) {
    return post(`/rooms/${code}/action`, { token, action: name, ...extra });
  }
  async function state(code, token) {
    const response = await fetch(`${base}/api/doudizhu/rooms/${code}/state?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 200);
    return response.json();
  }
  async function onlineRoom(names) {
    const first = await post('/rooms', { name: names[0], mode: 'online' });
    assert.equal(first.status, 201);
    const guests = [];
    for (const name of names.slice(1)) {
      const guest = await post('/rooms/join', { code: first.body.code, name });
      assert.equal(guest.status, 201);
      guests.push(guest.body);
    }
    return { code: first.body.code, users: [first.body, ...guests] };
  }

  const { code, users } = await onlineRoom(['甲', '乙', '丙']);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(typeof health.doudizhuRooms, 'number');
  assert.ok(health.doudizhuRooms >= 1);
  const before = await state(code, users[0].token);
  assert.equal(before.canStart, true);
  assert.equal(before.players.length, 3);
  const start = await action(code, users[1].token, 'start');
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.phase, 'bidding');
  assert.equal(start.body.hand.length, 17);
  assert.equal(start.body.bottomCards.length, 0, '底牌叫分前保密');
  for (const user of users) {
    const own = await state(code, user.token);
    assert.equal(own.hand.length, 17);
    assert.deepEqual(own.players.map((player) => player.cardCount), [17, 17, 17]);
    assert.ok(own.players.every((player) => !Object.hasOwn(player, 'hand')), '不可泄露其他玩家手牌');
  }
  const turnIndex = start.body.players.findIndex((player) => player.id === start.body.currentTurnId);
  const bid = await action(code, users[turnIndex].token, 'bid', { score: 3 });
  assert.equal(bid.status, 200, JSON.stringify(bid.body));
  assert.equal(bid.body.phase, 'playing');
  assert.equal(bid.body.landlordId, start.body.currentTurnId);
  assert.equal(bid.body.bottomCards.length, 3);
  assert.equal((await state(code, users[turnIndex].token)).hand.length, 20);
  assert.deepEqual((await state(code, users[turnIndex].token)).players.map((player) => player.cardCount).sort((a, b) => a - b), [17, 17, 20]);

  const otherIndex = (turnIndex + 1) % 3;
  assert.equal((await action(code, users[otherIndex].token, 'play', { cards: [0] })).status, 409, '非本人回合不能出牌');
  assert.equal((await action(code, users[turnIndex].token, 'pass')).status, 409, '领出不能过牌');
  const room = rooms.get(code);
  const landlord = room.players[turnIndex];
  const notOwned = DECK.find((card) => !landlord.hand.some((held) => held.id === card.id));
  assert.equal((await action(code, users[turnIndex].token, 'play', { cards: [notOwned.id] })).status, 409);

  const lead = await action(code, users[turnIndex].token, 'play', { cards: [landlord.hand[0].id] });
  assert.equal(lead.status, 200);
  assert.equal(lead.body.lastPlay.cards.length, 1);
  assert.equal((await action(code, users[(turnIndex + 1) % 3].token, 'pass')).status, 200);
  const renewed = await action(code, users[(turnIndex + 2) % 3].token, 'pass');
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.currentTurnId, landlord.id);
  assert.equal(renewed.body.lastPlay, null, '两人过牌后由上手重新领出');
  assert.equal(renewed.body.canPass, false);

  landlord.hand = [DECK[0]];
  const win = await action(code, users[turnIndex].token, 'play', { cards: [0] });
  assert.equal(win.status, 200, JSON.stringify(win.body));
  assert.equal(win.body.phase, 'finished');
  assert.deepEqual(win.body.winners, [landlord.id]);
  assert.equal(win.body.winningTeam, 'landlord');
  assert.equal(win.body.players.find((player) => player.id === landlord.id).roundResult.delta, 6);
  assert.equal(win.body.players.filter((player) => player.id !== landlord.id).every((player) => player.roundResult.delta === -3), true);

  const firstReady = await action(code, users[turnIndex].token, 'start');
  assert.equal(firstReady.status, 200);
  assert.equal(firstReady.body.phase, 'finished', '一人准备不可单方面开始联机下一局');
  assert.equal(firstReady.body.readyCount, 1);
  assert.equal(firstReady.body.neededCount, 3);
  assert.equal(firstReady.body.canStart, false, '已准备者不能重复点击');
  const secondIndex = (turnIndex + 1) % 3;
  const secondReady = await action(code, users[secondIndex].token, 'start');
  assert.equal(secondReady.body.phase, 'finished');
  assert.equal(secondReady.body.readyCount, 2);
  const staleIndex = (turnIndex + 2) % 3;
  room.players[staleIndex].lastSeen = Date.now() - 10_001;
  const replacement = await post('/rooms/join', { code, name: '替补' });
  assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
  assert.equal(room.players.length, 3);
  assert.ok(!room.players.some((player) => player.id === win.body.players[staleIndex].id));
  assert.equal((await state(code, users[turnIndex].token)).readyCount, 2, '其余在线者的准备状态保留');
  const staleIdentity = await fetch(`${base}/api/doudizhu/rooms/${code}/state?token=${encodeURIComponent(users[staleIndex].token)}`);
  assert.equal(staleIdentity.status, 403, '被替换的离线身份不能再进入');
  const replacementReady = await action(code, replacement.body.token, 'start');
  assert.equal(replacementReady.status, 200);
  assert.equal(replacementReady.body.phase, 'bidding');
  assert.equal(replacementReady.body.round, 2);
  assert.deepEqual(replacementReady.body.nextReadyIds, []);

  const { code: farmerCode, users: farmers } = await onlineRoom(['地', '农一', '农二']);
  await action(farmerCode, farmers[0].token, 'start');
  const landlordBid = await action(farmerCode, farmers[0].token, 'bid', { score: 3 });
  assert.equal(landlordBid.status, 200);
  const farmerRoom = rooms.get(farmerCode);
  farmerRoom.players[1].hand = [DECK[0]];
  farmerRoom.currentTurnId = farmerRoom.players[1].id;
  farmerRoom.lastPlay = null;
  testing.scheduleTurn(farmerRoom);
  const farmerWin = await action(farmerCode, farmers[1].token, 'play', { cards: [0] });
  assert.equal(farmerWin.status, 200);
  assert.equal(farmerWin.body.phase, 'finished');
  assert.equal(farmerWin.body.winningTeam, 'farmers');
  assert.deepEqual(new Set(farmerWin.body.winners), new Set([farmerRoom.players[1].id, farmerRoom.players[2].id]));
  assert.equal(farmerWin.body.players[0].roundResult.delta, -6);
  assert.equal(farmerWin.body.players[1].roundResult.delta, 3);
  assert.equal(farmerWin.body.players[2].roundResult.delta, 3);
  for (let index = 0; index < 2; index += 1) {
    const ready = await action(farmerCode, farmers[index].token, 'start');
    assert.equal(ready.body.phase, 'finished');
    assert.equal(ready.body.readyCount, index + 1);
  }
  const everybodyReady = await action(farmerCode, farmers[2].token, 'start');
  assert.equal(everybodyReady.body.phase, 'bidding');
  assert.equal(everybodyReady.body.round, 2);

  const waiting = await onlineRoom(['留守', '会断线', '仍在线']);
  const waitingRoom = rooms.get(waiting.code);
  waitingRoom.players[1].lastSeen = Date.now() - 10_001;
  assert.equal((await state(waiting.code, waiting.users[0].token)).canStart, false, '离线席位不能假装三人在线');
  const lobbyReplacement = await post('/rooms/join', { code: waiting.code, name: '新玩家' });
  assert.equal(lobbyReplacement.status, 201);
  assert.equal(waitingRoom.players.length, 3);
  assert.equal((await state(waiting.code, waiting.users[0].token)).canStart, true);

  waitingRoom.phase = 'finished';
  waitingRoom.nextReadyIds.add(waitingRoom.players[0].id);
  waitingRoom.players[0].lastSeen = Date.now() - 9_995;
  testing.schedulePresenceUpdate(waitingRoom);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(waitingRoom.nextReadyIds.has(waitingRoom.players[0].id), false, '断线宽限届满后准备票自动失效');

  const controllers = [];
  for (let index = 0; index < limits.MAX_SSE_PER_PLAYER; index += 1) {
    const controller = new AbortController();
    controllers.push(controller);
    const stream = await fetch(`${base}/api/doudizhu/rooms/${waiting.code}/events?token=${encodeURIComponent(waiting.users[0].token)}`, { signal: controller.signal });
    assert.equal(stream.status, 200);
  }
  const tooManyStreams = await fetch(`${base}/api/doudizhu/rooms/${waiting.code}/events?token=${encodeURIComponent(waiting.users[0].token)}`);
  assert.equal(tooManyStreams.status, 429);
  for (const controller of controllers) controller.abort();

  const solo = await post('/rooms', { name: '单机', mode: 'solo' });
  assert.equal(solo.status, 201);
  const soloStart = await action(solo.body.code, solo.body.token, 'start');
  assert.equal(soloStart.status, 200);
  const soloRoom = rooms.get(solo.body.code);
  assert.equal(soloRoom.players.filter((player) => player.isAi).length, 2);
  await action(solo.body.code, solo.body.token, 'bid', { score: 0 });
  const until = Date.now() + 2_000;
  while (soloRoom.phase === 'bidding' && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(['playing', 'finished'].includes(soloRoom.phase), 'AI 应完成叫分');
  assert.ok(soloRoom.landlordId);
  const ai = soloRoom.players.find((player) => player.isAi);
  const beforeCards = ai.hand.length;
  soloRoom.currentTurnId = ai.id;
  soloRoom.lastPlay = null;
  testing.scheduleTurn(soloRoom);
  const playUntil = Date.now() + 2_000;
  while (ai.hand.length === beforeCards && Date.now() < playUntil) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ai.hand.length < beforeCards || soloRoom.phase === 'finished', 'AI 应自动出牌');
  if (soloRoom.phase !== 'finished') testing.finishRound(soloRoom, 'landlord');
  assert.equal((await state(solo.body.code, solo.body.token)).neededCount, 1);
  const soloAgain = await action(solo.body.code, solo.body.token, 'start');
  assert.equal(soloAgain.status, 200);
  assert.equal(soloAgain.body.phase, 'bidding', '单机唯一真人准备后立即开始下一局');

  createAttempts.clear();
  for (let index = 0; index < limits.MAX_CREATES_PER_ADDRESS; index += 1) {
    const created = await post('/rooms', { name: `限流${index}`, mode: 'solo' });
    assert.equal(created.status, 201);
  }
  const rateLimited = await post('/rooms', { name: '超额', mode: 'solo' });
  assert.equal(rateLimited.status, 429);
  assert.match(rateLimited.body.error, /频繁/);

  const placeholders = [];
  while (rooms.size < limits.MAX_ROOMS) {
    const key = `CAP-${placeholders.length}`;
    rooms.set(key, {});
    placeholders.push(key);
  }
  const full = await post('/rooms', { name: '满房', mode: 'solo' });
  assert.equal(full.status, 429);
  assert.match(full.body.error, /上限/);
  for (const key of placeholders) rooms.delete(key);
});
