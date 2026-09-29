const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.DOUDIZHU_AI_MS = '25';
process.env.DOUDIZHU_PLAY_MS = '30000';
const repoRoot = process.env.GAME_OVER_ROOT || path.resolve(__dirname, '..');
const { server } = require(path.join(repoRoot, 'server.js'));
const { testing } = require(path.join(repoRoot, 'doudizhu-server.js'));
const { DECK, classifyCards, beats, chooseAiPlay, playHint, rooms, createAttempts, limits } = testing;
const doudizhuHtml = fs.readFileSync(path.join(repoRoot, 'public', 'games', 'doudizhu.html'), 'utf8');
const hintScript = [...doudizhuHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]).find((source) => source.includes('root.DoudizhuHints'));
const hintSandbox = { module: { exports: {} } };
vm.runInNewContext(hintScript, hintSandbox, { filename: 'doudizhu-hints.js' });
const DoudizhuHints = hintSandbox.module.exports;

function cards(groups) {
  return groups.flatMap(([value, count]) => DECK.filter((card) => card.value === value).slice(0, count).map((card) => card.id));
}

function held(groups) {
  return cards(groups).map((id) => DECK[id]);
}

function publicPlay(playerId, groups) {
  const ids = cards(groups);
  const pattern = classifyCards(ids);
  return { playerId, cards: ids.map((id) => DECK[id]), ...pattern, pattern };
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

test('斗地主 AI 会压制对手，并在地主即将出完时接管农民队友的牌权', () => {
  const farmer = { id: 'farmer-ai', hand: held([[4, 1], [8, 2], [15, 1], [17, 1]]) };
  const teammate = { id: 'farmer-human', hand: Array(7) };
  const landlord = { id: 'landlord-ai', hand: Array(5) };
  const landlordPlay = publicPlay(landlord.id, [[3, 1]]);
  const room = {
    landlordId: landlord.id,
    players: [landlord, farmer, teammate],
    lastPlay: landlordPlay,
    playHistory: [landlordPlay],
  };

  const response = chooseAiPlay(room, farmer);
  assert.ok(response, '农民电脑有合法牌时不能放任地主取得牌权');
  assert.equal(beats(classifyCards(response), landlordPlay.pattern), true);

  const teammatePlay = publicPlay(teammate.id, [[3, 1]]);
  room.players = [teammate, farmer, landlord];
  room.lastPlay = teammatePlay;
  room.playHistory = [teammatePlay];
  assert.equal(chooseAiPlay(room, farmer), null, '地主没有临近出完时应让农民队友继续掌握牌权');

  landlord.hand = Array(1);
  const urgentResponse = chooseAiPlay(room, farmer);
  assert.ok(urgentResponse, '地主只剩一张时应主动压住队友的低牌，避免地主直接走完');
  assert.equal(beats(classifyCards(urgentResponse), teammatePlay.pattern), true);
  assert.equal(classifyCards(urgentResponse).mainValue, 17, '紧急防守应使用公开牌面下控制力最强的单张');
});

test('斗地主 AI 决策不读取对手暗牌', () => {
  const farmer = { id: 'farmer-ai', hand: held([[4, 1], [7, 2], [10, 1], [15, 1]]) };
  const teammate = { id: 'farmer-human', hand: Array(6) };
  const previous = publicPlay('landlord', [[3, 1]]);
  const room = (hiddenHand) => ({
    landlordId: 'landlord',
    players: [{ id: 'landlord', hand: hiddenHand }, farmer, teammate],
    lastPlay: previous,
    playHistory: [previous],
  });

  const lowHiddenCards = held([[5, 3], [6, 2]]);
  const highHiddenCards = held([[13, 1], [14, 1], [16, 1], [17, 1], [9, 1]]);
  assert.deepEqual(
    chooseAiPlay(room(lowHiddenCards), farmer),
    chooseAiPlay(room(highHiddenCards), farmer),
    '对手暗牌内容变化但公开余牌数相同时，电脑决策必须一致',
  );
  assert.deepEqual(
    playHint(room(lowHiddenCards), farmer).hintCandidates,
    playHint(room(highHiddenCards), farmer).hintCandidates,
    '对手暗牌内容变化但公开余牌数相同时，提示候选及顺序必须一致',
  );
});

test('斗地主出牌提示返回排序、去重且合法的候选，并优先保留炸弹', () => {
  const player = { id: 'farmer', hand: held([[5, 2], [6, 2], [7, 4], [16, 1], [17, 1]]) };
  const landlord = { id: 'landlord', hand: Array(5) };
  const teammate = { id: 'teammate', hand: Array(6) };
  const previous = publicPlay(landlord.id, [[4, 2]]);
  const room = {
    landlordId: landlord.id,
    players: [landlord, player, teammate],
    lastPlay: previous,
    playHistory: [previous],
  };

  const hint = playHint(room, player);
  assert.equal(hint.hintAction, 'play');
  assert.deepEqual(hint.hintCards, hint.hintCandidates[0]);
  const signatures = hint.hintCandidates.map((candidate) => [...candidate].sort((a, b) => a - b).join(','));
  assert.equal(new Set(signatures).size, signatures.length, '提示候选不得重复');
  const patterns = hint.hintCandidates.map((candidate) => classifyCards(candidate));
  assert.ok(patterns.every((pattern) => beats(pattern, previous.pattern)), '每个提示候选都必须合法压过上家');
  assert.equal(patterns[0].type, 'pair');
  assert.notEqual(patterns[0].mainValue, 7, '有完整对子可用时不应先拆炸弹跟牌');
  const firstExplosive = patterns.findIndex((pattern) => ['bomb', 'rocket'].includes(pattern.type));
  assert.ok(firstExplosive > 0, '普通同型牌应排在炸弹之前');
  assert.ok(patterns.slice(firstExplosive).every((pattern) => ['bomb', 'rocket'].includes(pattern.type)));
  assert.equal(patterns.at(-1).type, 'rocket', '王炸应放在候选最后');

  room.lastPlay = publicPlay(teammate.id, [[4, 1]]);
  room.playHistory.push(room.lastPlay);
  const teammateHint = playHint(room, player);
  assert.equal(teammateHint.hintAction, 'pass', '队友掌握牌权且地主未临近出完时应先建议不出');
  assert.ok(teammateHint.hintCandidates.length > 0, '建议不出时仍应返回可轮换的合法候选');

  room.lastPlay = publicPlay(landlord.id, [[16, 1], [17, 1]]);
  room.playHistory.push(room.lastPlay);
  const noBeat = playHint(room, player);
  assert.equal(noBeat.hintCandidates.length, 0);
  assert.match(noBeat.hintMessage, /没有大过上家的牌/);
});

test('斗地主客户端提示候选去重、轮换，并支持队友控权时首次不出', () => {
  const cycle = DoudizhuHints.createCycle('turn-1', [[8, 4], [4, 8], [12]], true, '建议不出');
  const first = DoudizhuHints.next(cycle);
  const second = DoudizhuHints.next(cycle);
  const third = DoudizhuHints.next(cycle);
  const fourth = DoudizhuHints.next(cycle);
  assert.equal(first.action, 'pass');
  assert.deepEqual(Array.from(second.cards), [4, 8]);
  assert.deepEqual(Array.from(third.cards), [12]);
  assert.deepEqual(Array.from(fourth.cards), [4, 8], '到达末尾后应从第一个候选继续轮换');
  assert.equal(second.total, 2, '相同牌组不同顺序只能保留一个候选');
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

  const cookie = (code, token) => `ddz_${code}=${token}`;
  async function post(endpoint, body, headers = {}) {
    const response = await fetch(`${base}/api/doudizhu${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), setCookie: response.headers.get('set-cookie') };
  }
  async function action(code, token, name, extra = {}) {
    return post(`/rooms/${code}/action`, { token, action: name, ...extra });
  }
  async function state(code, token) {
    const response = await fetch(`${base}/api/doudizhu/rooms/${code}/state`, {
      headers: { Cookie: cookie(code, token) },
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function onlineRoom(names) {
    const first = await post('/rooms', { name: names[0], mode: 'online' });
    assert.equal(first.status, 201);
    assert.match(first.setCookie, new RegExp(`^ddz_${first.body.code}=`));
    assert.match(first.setCookie, /HttpOnly; SameSite=Strict/);
    const guests = [];
    for (const name of names.slice(1)) {
      const guest = await post('/rooms/join', { code: first.body.code, name });
      assert.equal(guest.status, 201);
      assert.match(guest.setCookie, new RegExp(`^ddz_${first.body.code}=`));
      guests.push(guest.body);
    }
    return { code: first.body.code, users: [first.body, ...guests] };
  }

  const { code, users } = await onlineRoom(['甲', '乙', '丙']);
  const stateUrl = `${base}/api/doudizhu/rooms/${code}/state`;
  assert.equal((await fetch(stateUrl)).status, 403, '读取房间需要会话 Cookie');
  assert.equal((await fetch(`${stateUrl}?token=${users[0].token}`)).status, 403, 'URL token 不能用于读取房间');
  assert.equal((await fetch(stateUrl, { headers: { Cookie: cookie(code, 'wrong') } })).status, 403);
  const restore = await post(`/rooms/${code}/session`, { token: users[0].token }, { 'X-Forwarded-Proto': 'https' });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.selfId, rooms.get(code).players[0].id);
  assert.match(restore.setCookie, /; Secure(?:;|$)/, 'HTTPS 代理下 Cookie 应标记 Secure');
  assert.equal((await post(`/rooms/${code}/session`, { token: 'wrong' })).status, 403);
  assert.equal((await fetch(`${base}/api/doudizhu/rooms/${code}/events?token=${users[0].token}`)).status, 403, 'SSE 不接受 URL token');
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

  const room = rooms.get(code);
  const landlord = room.players[turnIndex];
  const deadlineBeforeHint = room.deadlineAt;
  const handBeforeHint = landlord.hand.map((card) => card.id);
  assert.ok(deadlineBeforeHint - Date.now() > 28_000 && deadlineBeforeHint - Date.now() <= 30_000,
    '每个出牌回合应从 30 秒开始倒计时');
  const hint = await action(code, users[turnIndex].token, 'hint');
  assert.equal(hint.status, 200, JSON.stringify(hint.body));
  assert.equal(hint.body.hintAction, 'play');
  assert.ok(hint.body.hintCards.length > 0, '领出时提示应选择一组牌');
  assert.ok(hint.body.hintCards.every((id) => handBeforeHint.includes(id)), '提示只能包含自己的手牌');
  assert.ok(classifyCards(hint.body.hintCards), '提示结果必须是合法牌型');
  assert.deepEqual(landlord.hand.map((card) => card.id), handBeforeHint, '查看提示不能替玩家出牌');
  assert.equal(room.deadlineAt, deadlineBeforeHint, '查看提示不能重置回合倒计时');

  const otherIndex = (turnIndex + 1) % 3;
  assert.equal((await action(code, users[otherIndex].token, 'play', { cards: [0] })).status, 409, '非本人回合不能出牌');
  assert.equal((await action(code, users[otherIndex].token, 'hint')).status, 409, '非本人回合不能查看出牌提示');
  assert.equal((await action(code, users[turnIndex].token, 'pass')).status, 409, '领出不能过牌');
  const notOwned = DECK.find((card) => !landlord.hand.some((held) => held.id === card.id));
  assert.equal((await action(code, users[turnIndex].token, 'play', { cards: [notOwned.id] })).status, 409);

  room.deadlineAt = Date.now() + 1_000;
  const lead = await action(code, users[turnIndex].token, 'play', { cards: [landlord.hand[0].id] });
  assert.equal(lead.status, 200);
  assert.equal(lead.body.lastPlay.cards.length, 1);
  const afterLeadDeadline = room.deadlineAt;
  assert.ok(afterLeadDeadline - Date.now() > 28_000, '出牌后应给下一位玩家重新计满 30 秒');
  assert.equal(room.playHistory.length, 1, '服务端应记录公开出牌，供电脑按已知牌面推算');
  const forcedPassDeadline = Date.now() + 1_000;
  room.deadlineAt = forcedPassDeadline;
  assert.equal((await action(code, users[(turnIndex + 1) % 3].token, 'pass')).status, 200);
  assert.ok(room.deadlineAt - Date.now() > 28_000, '不出后应给下一位玩家重新计满 30 秒');
  assert.ok(room.deadlineAt > forcedPassDeadline + 27_000, '新回合应替换原有截止时间');
  room.deadlineAt = Date.now() + 1_000;
  const renewed = await action(code, users[(turnIndex + 2) % 3].token, 'pass');
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.currentTurnId, landlord.id);
  assert.equal(renewed.body.lastPlay, null, '两人过牌后由上手重新领出');
  assert.equal(renewed.body.canPass, false);
  assert.ok(room.deadlineAt - Date.now() > 28_000, '重新获得牌权时也应重新计满 30 秒');

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
  const staleIdentity = await fetch(stateUrl, {
    headers: { Cookie: cookie(code, users[staleIndex].token) },
  });
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
    const stream = await fetch(`${base}/api/doudizhu/rooms/${waiting.code}/events`, {
      headers: { Cookie: cookie(waiting.code, waiting.users[0].token) }, signal: controller.signal,
    });
    assert.equal(stream.status, 200);
  }
  const tooManyStreams = await fetch(`${base}/api/doudizhu/rooms/${waiting.code}/events`, {
    headers: { Cookie: cookie(waiting.code, waiting.users[0].token) },
  });
  assert.equal(tooManyStreams.status, 429);
  for (const controller of controllers) controller.abort();

  const departing = await post('/rooms', { name: '离开测试', mode: 'solo' });
  const left = await action(departing.body.code, departing.body.token, 'leave');
  assert.equal(left.status, 200);
  assert.match(left.setCookie, /Max-Age=0/, '离开时清除该房间会话 Cookie');

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
