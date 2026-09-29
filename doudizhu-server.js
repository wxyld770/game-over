const crypto = require('node:crypto');
const net = require('node:net');

const BID_MS = Number(process.env.DOUDIZHU_BID_MS || 15_000);
const PLAY_MS = Number(process.env.DOUDIZHU_PLAY_MS || 30_000);
const AI_MS = Number(process.env.DOUDIZHU_AI_MS || 650);
const PRESENCE_MS = 10_000;
const MAX_ROOMS = 100;
const CREATE_WINDOW_MS = 10 * 60_000;
const MAX_CREATES_PER_ADDRESS = 12;
const MAX_SSE_PER_PLAYER = 2;
const INTERACTION_COOLDOWN_MS = 1_200;
const INTERACTION_TTL_MS = 2_500;
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['♠', '♥', '♣', '♦'];
const DECK = Object.freeze([
  ...RANKS.flatMap((rank, index) => SUITS.map((suit, suitIndex) =>
    Object.freeze({ id: index * 4 + suitIndex, rank, suit, value: index + 3 }))),
  Object.freeze({ id: 52, rank: '小王', suit: '', value: 16 }),
  Object.freeze({ id: 53, rank: '大王', suit: '', value: 17 }),
]);
const rooms = new Map();
const createAttempts = new Map();

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function fail(res, status, error) {
  sendJson(res, status, { error });
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) {
      const error = new Error('请求内容过长');
      error.status = 413;
      throw error;
    }
  }
  if (!body.trim()) return {};
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error('请求格式有误');
    error.status = 400;
    throw error;
  }
}

function checkName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name && name.length <= 18 ? name : null;
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
}

function newPlayer(name, isAi = false) {
  return {
    id: crypto.randomUUID(),
    token: isAi ? null : crypto.randomBytes(24).toString('base64url'),
    name,
    isAi,
    clients: new Set(),
    lastSeen: Date.now(),
    hand: [],
    score: 0,
    roundResult: null,
    lastInteractionAt: 0,
    left: false,
  };
}

function createRoom(name, mode = 'online') {
  const owner = newPlayer(name);
  const room = {
    code: roomCode(),
    mode,
    phase: 'lobby',
    round: 0,
    players: mode === 'solo' ? [owner, newPlayer('电脑甲', true), newPlayer('电脑乙', true)] : [owner],
    bottomCards: [],
    currentTurnId: null,
    landlordId: null,
    highestBid: 0,
    highestBidderId: null,
    bidHistory: [],
    bidsTaken: 0,
    lastPlay: null,
    playHistory: [],
    passCount: 0,
    baseScore: 0,
    multiplier: 1,
    winners: [],
    winningTeam: null,
    deadlineAt: null,
    turnTimer: null,
    aiTimer: null,
    interaction: null,
    interactionTimer: null,
    presenceTimer: null,
    nextReadyIds: new Set(),
    message: mode === 'solo' ? '两名电脑玩家已就位，可以开始。' : '邀请另外两名玩家加入后开始。',
    lastActivity: Date.now(),
  };
  rooms.set(room.code, room);
  schedulePresenceUpdate(room);
  return { room, player: owner };
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase());
}

function getPlayer(room, token) {
  if (typeof token !== 'string' || !token) return null;
  return room.players.find((player) => !player.isAi && !player.left && player.token === token) || null;
}

function sessionCookie(req, code, token) {
  const localProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const secure = req.socket.encrypted || (localProxy && req.headers['x-forwarded-proto'] === 'https');
  return `ddz_${code}=${token || ''}; Path=/api/doudizhu/rooms/${code}/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${token ? '' : '; Max-Age=0'}`;
}

function sessionToken(req, code) {
  const name = `ddz_${code}=`;
  const cookies = typeof req.headers.cookie === 'string' ? req.headers.cookie.split(';') : [];
  const entry = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(name));
  return entry ? entry.slice(name.length) : '';
}

function isOnline(player) {
  return player.isAi || (!player.left && (player.clients.size > 0 || Date.now() - player.lastSeen < PRESENCE_MS));
}

function schedulePresenceUpdate(room) {
  if (room.presenceTimer) clearTimeout(room.presenceTimer);
  room.presenceTimer = null;
  const expiring = room.players.filter((player) => !player.isAi && !player.left && !player.clients.size && isOnline(player));
  if (!expiring.length) return;
  const at = Math.min(...expiring.map((player) => player.lastSeen + PRESENCE_MS));
  room.presenceTimer = setTimeout(() => {
    room.presenceTimer = null;
    for (const player of room.players) {
      if (!isOnline(player)) room.nextReadyIds.delete(player.id);
    }
    broadcast(room);
    schedulePresenceUpdate(room);
  }, Math.max(1, at - Date.now() + 1));
  room.presenceTimer.unref();
}

function reclaimStaleSeats(room) {
  const before = room.players.length;
  room.players = room.players.filter((player) => player.isAi || (!player.left && isOnline(player)));
  const presentIds = new Set(room.players.map((player) => player.id));
  for (const id of room.nextReadyIds) if (!presentIds.has(id)) room.nextReadyIds.delete(id);
  if (room.players.length !== before) schedulePresenceUpdate(room);
}

function maybeStartNextRound(room) {
  if (room.phase !== 'finished') return;
  const humans = room.players.filter((player) => !player.isAi && !player.left);
  const required = room.mode === 'solo' ? 1 : 3;
  if (room.players.length === 3 && humans.length === required
      && room.players.every(isOnline) && humans.every((player) => room.nextReadyIds.has(player.id))) {
    startRound(room);
    return;
  }
  const ready = humans.filter((player) => isOnline(player) && room.nextReadyIds.has(player.id)).length;
  room.message = `等待下一局：${ready}/${required} 位玩家已准备。`;
  broadcast(room);
}

function clientAddress(req) {
  const address = req.socket.remoteAddress || 'unknown';
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    const proxied = req.headers['x-real-ip'];
    if (typeof proxied === 'string' && net.isIP(proxied.trim())) return proxied.trim();
  }
  return address;
}

function reserveRoomCreation(req) {
  if (rooms.size >= MAX_ROOMS) return '房间数量已达上限，请稍后再试';
  const address = clientAddress(req);
  const now = Date.now();
  const recent = (createAttempts.get(address) || []).filter((time) => time > now - CREATE_WINDOW_MS);
  if (recent.length >= MAX_CREATES_PER_ADDRESS) {
    createAttempts.set(address, recent);
    return '创建房间过于频繁，请稍后再试';
  }
  recent.push(now);
  createAttempts.set(address, recent);
  return null;
}

function touch(room, player) {
  room.lastActivity = Date.now();
  if (player) {
    if (!isOnline(player)) room.nextReadyIds.delete(player.id);
    player.lastSeen = Date.now();
  }
  schedulePresenceUpdate(room);
}

function currentInteraction(room, now = Date.now()) {
  return room.interaction && room.interaction.expiresAt > now ? room.interaction : null;
}

function sorted(cards) {
  return [...cards].sort((a, b) => a.value - b.value || a.id - b.id);
}

function state(room, viewer) {
  const lobbyCanStart = room.phase === 'lobby' && room.players.length === 3
    && room.players.every((player) => !player.left && isOnline(player));
  const nextReadyIds = room.players
    .filter((player) => !player.isAi && !player.left && isOnline(player) && room.nextReadyIds.has(player.id))
    .map((player) => player.id);
  const canStart = lobbyCanStart || (room.phase === 'finished' && !room.nextReadyIds.has(viewer.id));
  return {
    code: room.code,
    mode: room.mode,
    phase: room.phase,
    round: room.round,
    selfId: viewer.id,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      isAi: player.isAi,
      connected: isOnline(player),
      cardCount: player.hand.length,
      ...(room.phase === 'finished' ? { hand: sorted(player.hand) } : {}),
      score: player.score,
      roundResult: player.roundResult,
      left: player.left,
    })),
    hand: sorted(viewer.hand),
    currentTurnId: room.currentTurnId,
    landlordId: room.landlordId,
    bottomCards: room.landlordId ? room.bottomCards : [],
    bidHistory: room.bidHistory,
    highestBid: room.highestBid,
    lastPlay: room.lastPlay,
    passCount: room.passCount,
    baseScore: room.baseScore,
    multiplier: room.multiplier,
    deadlineAt: room.deadlineAt,
    interaction: currentInteraction(room),
    canStart,
    nextReadyIds,
    readyCount: nextReadyIds.length,
    neededCount: room.mode === 'solo' ? 1 : 3,
    canBid: room.phase === 'bidding' && room.currentTurnId === viewer.id,
    canPlay: room.phase === 'playing' && room.currentTurnId === viewer.id,
    canPass: room.phase === 'playing' && room.currentTurnId === viewer.id
      && !!room.lastPlay && room.lastPlay.playerId !== viewer.id,
    winners: room.winners,
    winningTeam: room.winningTeam,
    message: room.message,
  };
}

function broadcast(room, skipClient = null) {
  for (const player of room.players) {
    if (player.isAi) continue;
    const data = `data: ${JSON.stringify(state(room, player))}\n\n`;
    for (const client of player.clients) {
      if (client === skipClient) continue;
      try { client.write(data); } catch { player.clients.delete(client); }
    }
  }
}

function applyInteraction(room, player, interaction, targetId) {
  if (interaction !== 'tomato') return { status: 409, error: '不支持的互动类型' };
  const target = room.players.find((seat) => !seat.left && seat.id === targetId);
  if (!target) return { status: 409, error: '互动目标不存在' };
  if (target.id === player.id) return { status: 409, error: '不能对自己发送互动' };
  const now = Date.now();
  if (now - player.lastInteractionAt < INTERACTION_COOLDOWN_MS) {
    return { status: 429, error: '互动太频繁，请稍后再试' };
  }

  player.lastInteractionAt = now;
  const event = {
    id: crypto.randomUUID(),
    type: interaction,
    fromPlayerId: player.id,
    targetPlayerId: target.id,
    createdAt: now,
    expiresAt: now + INTERACTION_TTL_MS,
  };
  room.interaction = event;
  if (room.interactionTimer) clearTimeout(room.interactionTimer);
  room.interactionTimer = setTimeout(() => {
    room.interactionTimer = null;
    if (room.interaction?.id !== event.id) return;
    room.interaction = null;
    broadcast(room);
  }, INTERACTION_TTL_MS);
  room.interactionTimer.unref();
  broadcast(room);
  return null;
}

function clearTurn(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (room.aiTimer) clearTimeout(room.aiTimer);
  room.turnTimer = null;
  room.aiTimer = null;
  room.deadlineAt = null;
}

function shuffleDeck() {
  const cards = [...DECK];
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function nextPlayer(room, playerId) {
  const index = room.players.findIndex((player) => player.id === playerId);
  return room.players[(index + 1) % 3];
}

function consecutive(values) {
  return values.every((value, index) => index === 0 || value === values[index - 1] + 1);
}

function classifyCards(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) return null;
  const ids = input.map((item) => typeof item === 'number' ? item : item?.id);
  if (ids.some((id) => !Number.isInteger(id) || id < 0 || id > 53) || new Set(ids).size !== ids.length) return null;
  const cards = ids.map((id) => DECK[id]);
  const count = cards.length;
  const groups = new Map();
  for (const card of cards) groups.set(card.value, (groups.get(card.value) || 0) + 1);
  const values = [...groups.keys()].sort((a, b) => a - b);
  const byAmount = (amount) => values.filter((value) => groups.get(value) === amount);
  const result = (type, mainValue, chainLength = 1) => ({ type, mainValue, count, chainLength });

  if (count === 1) return result('single', values[0]);
  if (count === 2) {
    if (groups.has(16) && groups.has(17)) return result('rocket', 17);
    if (values.length === 1) return result('pair', values[0]);
    return null;
  }
  if (count === 3 && values.length === 1) return result('triple', values[0]);
  if (count === 4) {
    if (values.length === 1) return result('bomb', values[0]);
    if (byAmount(3).length === 1) return result('triple-single', byAmount(3)[0]);
  }
  if (count >= 5 && values.length === count && values.at(-1) <= 14 && consecutive(values)) {
    return result('straight', values.at(-1), count);
  }
  if (count >= 6 && count % 2 === 0 && values.length === count / 2
      && values.every((value) => groups.get(value) === 2) && values.at(-1) <= 14 && consecutive(values)) {
    return result('pair-straight', values.at(-1), values.length);
  }

  // Triples may form a pure plane, or carry one single / one pair per triple.
  for (const [unit, type] of [[3, 'plane'], [4, 'plane-single'], [5, 'plane-pair']]) {
    if (count % unit !== 0 || count / unit < 2) continue;
    const length = count / unit;
    for (let start = 3; start + length - 1 <= 14; start += 1) {
      const core = Array.from({ length }, (_, index) => start + index);
      if (!core.every((value) => groups.get(value) === 3)) continue;
      const remainder = values.filter((value) => !core.includes(value));
      if (unit === 3 && remainder.length === 0) return result(type, core.at(-1), length);
      if (unit === 4 && remainder.length === length
          && remainder.every((value) => groups.get(value) === 1)) {
        return result(type, core.at(-1), length);
      }
      if (unit === 5 && remainder.length === length && remainder.every((value) => groups.get(value) === 2)) {
        return result(type, core.at(-1), length);
      }
    }
  }

  if (count === 6 && byAmount(4).length === 1) return result('four-two-single', byAmount(4)[0]);
  if (count === 8 && byAmount(4).length === 1 && byAmount(2).length === 2) {
    return result('four-two-pair', byAmount(4)[0]);
  }
  return null;
}

function beats(candidate, previous) {
  if (!candidate) return false;
  if (!previous) return true;
  if (previous.type === 'rocket') return false;
  if (candidate.type === 'rocket') return true;
  if (candidate.type === 'bomb' && previous.type !== 'bomb') return true;
  if (previous.type === 'bomb' && candidate.type !== 'bomb') return false;
  return candidate.type === previous.type
    && candidate.count === previous.count
    && candidate.chainLength === previous.chainLength
    && candidate.mainValue > previous.mainValue;
}

function scheduleTurn(room) {
  clearTurn(room);
  if (!['bidding', 'playing'].includes(room.phase)) return;
  const player = room.players.find((seat) => seat.id === room.currentTurnId);
  if (!player) return;
  const duration = room.phase === 'bidding' ? BID_MS : PLAY_MS;
  room.deadlineAt = Date.now() + duration;
  room.turnTimer = setTimeout(() => {
    if (room.currentTurnId !== player.id) return;
    if (room.phase === 'bidding') applyBid(room, player, 0);
    else if (room.phase === 'playing') {
      if (room.lastPlay) applyPass(room, player);
      else applyPlay(room, player, [sorted(player.hand)[0].id]);
    }
  }, duration);
  room.turnTimer.unref();
  if (player.isAi) {
    room.aiTimer = setTimeout(() => {
      if (room.currentTurnId !== player.id) return;
      if (room.phase === 'bidding') applyBid(room, player, chooseAiBid(room, player));
      else if (room.phase === 'playing') aiTakeTurn(room, player);
    }, AI_MS);
    room.aiTimer.unref();
  }
  broadcast(room);
}

function startRound(room) {
  clearTurn(room);
  room.nextReadyIds.clear();
  room.round += 1;
  const cards = shuffleDeck();
  for (const player of room.players) {
    player.hand = [];
    player.roundResult = null;
  }
  for (let i = 0; i < 17; i += 1) {
    for (const player of room.players) player.hand.push(cards.pop());
  }
  for (const player of room.players) player.hand = sorted(player.hand);
  room.bottomCards = cards;
  room.phase = 'bidding';
  room.currentTurnId = room.players[(room.round - 1) % 3].id;
  room.landlordId = null;
  room.highestBid = 0;
  room.highestBidderId = null;
  room.bidHistory = [];
  room.bidsTaken = 0;
  room.lastPlay = null;
  room.playHistory = [];
  room.passCount = 0;
  room.baseScore = 0;
  room.multiplier = 1;
  room.winners = [];
  room.winningTeam = null;
  room.message = `第 ${room.round} 局开始，请依次叫分。`;
  scheduleTurn(room);
}

function beginPlay(room) {
  const landlord = room.players.find((player) => player.id === room.highestBidderId);
  if (!landlord) return startRound(room);
  room.phase = 'playing';
  room.landlordId = landlord.id;
  room.baseScore = room.highestBid;
  landlord.hand = sorted([...landlord.hand, ...room.bottomCards]);
  room.currentTurnId = landlord.id;
  room.lastPlay = null;
  room.passCount = 0;
  room.message = `${landlord.name} 是地主，底牌已公开。`;
  scheduleTurn(room);
}

function applyBid(room, player, score) {
  if (room.phase !== 'bidding' || room.currentTurnId !== player.id) return '现在不能叫分';
  if (!Number.isInteger(score) || score < 0 || score > 3 || (score !== 0 && score <= room.highestBid)) {
    return `请叫高于当前 ${room.highestBid} 分的分数，或选择不叫`;
  }
  room.bidHistory.push({ playerId: player.id, score });
  room.bidsTaken += 1;
  if (score > room.highestBid) {
    room.highestBid = score;
    room.highestBidderId = player.id;
  }
  if (score === 3 || room.bidsTaken === 3) {
    if (room.highestBid === 0) startRound(room);
    else beginPlay(room);
  } else {
    room.currentTurnId = nextPlayer(room, player.id).id;
    room.message = score ? `${player.name} 叫 ${score} 分。` : `${player.name} 不叫。`;
    scheduleTurn(room);
  }
  return null;
}

function finishRound(room, winnerTeam) {
  clearTurn(room);
  room.nextReadyIds.clear();
  room.phase = 'finished';
  room.winningTeam = winnerTeam;
  room.currentTurnId = null;
  const stake = room.baseScore * room.multiplier;
  const landlord = room.players.find((player) => player.id === room.landlordId);
  room.winners = winnerTeam === 'landlord'
    ? [landlord.id]
    : room.players.filter((player) => player.id !== room.landlordId).map((player) => player.id);
  for (const player of room.players) {
    const onWinningTeam = room.winners.includes(player.id);
    const delta = (player.id === room.landlordId ? 2 : 1) * stake * (onWinningTeam ? 1 : -1);
    player.score += delta;
    player.roundResult = { delta, label: `${delta > 0 ? '赢得' : '失去'} ${Math.abs(delta)} 分` };
  }
  room.message = winnerTeam === 'landlord'
    ? `${landlord.name} 地主获胜，底分 ${room.baseScore}，倍率 ×${room.multiplier}。`
    : `农民获胜，底分 ${room.baseScore}，倍率 ×${room.multiplier}。`;
  broadcast(room);
}

function applyPlay(room, player, ids) {
  if (room.phase !== 'playing' || room.currentTurnId !== player.id) return '现在不能出牌';
  if (!Array.isArray(ids) || !ids.length || ids.length > 20
      || ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length) return '请选择有效的牌';
  const owned = new Set(player.hand.map((card) => card.id));
  if (ids.some((id) => !owned.has(id))) return '不能打出不在自己手中的牌';
  const pattern = classifyCards(ids);
  if (!pattern) return '牌型不符合斗地主规则';
  if (!beats(pattern, room.lastPlay?.pattern)) return '这手牌压不过上一手';
  const selected = sorted(ids.map((id) => DECK[id]));
  const played = new Set(ids);
  player.hand = player.hand.filter((card) => !played.has(card.id));
  room.lastPlay = { playerId: player.id, cards: selected, ...pattern, pattern };
  if (!Array.isArray(room.playHistory)) room.playHistory = [];
  room.playHistory.push({ playerId: player.id, cards: selected, pattern });
  room.passCount = 0;
  if (pattern.type === 'bomb' || pattern.type === 'rocket') room.multiplier *= 2;
  if (player.hand.length === 0) {
    finishRound(room, player.id === room.landlordId ? 'landlord' : 'farmers');
  } else {
    room.currentTurnId = nextPlayer(room, player.id).id;
    room.message = `${player.name} 出了 ${selected.length} 张牌。`;
    scheduleTurn(room);
  }
  return null;
}

function applyPass(room, player) {
  if (room.phase !== 'playing' || room.currentTurnId !== player.id) return '现在不能过牌';
  if (!room.lastPlay || room.lastPlay.playerId === player.id) return '你当前领出，不能过牌';
  room.passCount += 1;
  if (room.passCount >= 2) {
    room.currentTurnId = room.lastPlay.playerId;
    room.lastPlay = null;
    room.passCount = 0;
    room.message = '两人过牌，上一手玩家重新领出。';
  } else {
    room.currentTurnId = nextPlayer(room, player.id).id;
    room.message = `${player.name} 过牌。`;
  }
  scheduleTurn(room);
  return null;
}

function chooseAiBid(room, player) {
  const values = player.hand.map((card) => card.value);
  const high = values.filter((value) => value >= 15).length;
  const aces = values.filter((value) => value === 14).length;
  const bombs = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    .filter((value) => values.filter((item) => item === value).length === 4).length;
  const strength = high * 2 + aces + bombs * 3 + (values.includes(16) && values.includes(17) ? 4 : 0);
  const proposed = strength >= 11 ? 3 : strength >= 7 ? 2 : strength >= 4 ? 1 : 0;
  if (proposed > room.highestBid) return proposed;
  // In solo play, prevent an endless all-pass/redeal loop.
  if (room.mode === 'solo' && room.bidsTaken === 2 && room.highestBid === 0) return 1;
  return 0;
}

function rankGroups(hand) {
  const groups = new Map();
  for (const card of sorted(hand)) {
    if (!groups.has(card.value)) groups.set(card.value, []);
    groups.get(card.value).push(card.id);
  }
  return groups;
}

function legalAiMoves(hand, previous = null) {
  if (previous?.type === 'rocket') return [];
  const groups = rankGroups(hand);
  const moves = [];
  const seen = new Set();
  function add(ids) {
    const signature = [...ids].sort((a, b) => a - b).join(',');
    if (seen.has(signature)) return;
    seen.add(signature);
    const pattern = classifyCards(ids);
    if (pattern && beats(pattern, previous)) moves.push({ ids: [...ids], pattern });
  }
  function attachments(entries, total, callback, index = 0, selected = []) {
    if (total === 0) {
      callback(selected);
      return;
    }
    if (index >= entries.length) return;
    const available = entries.slice(index).reduce((sum, [, ids]) => sum + ids.length, 0);
    if (available < total) return;
    const [, ids] = entries[index];
    const amounts = Array.from({ length: Math.min(ids.length, total) + 1 }, (_, amount) => amount);
    for (const amount of amounts) {
      if (amount > total || amount > ids.length) continue;
      selected.push(...ids.slice(0, amount));
      attachments(entries, total - amount, callback, index + 1, selected);
      selected.length -= amount;
    }
  }
  function groupedAttachments(entries, groupsNeeded, cardsPerGroup, callback, index = 0, selected = []) {
    if (groupsNeeded === 0) {
      callback(selected);
      return;
    }
    if (entries.length - index < groupsNeeded) return;
    const [, ids] = entries[index];
    groupedAttachments(entries, groupsNeeded, cardsPerGroup, callback, index + 1, selected);
    if (ids.length < cardsPerGroup) return;
    selected.push(...ids.slice(0, cardsPerGroup));
    groupedAttachments(entries, groupsNeeded - 1, cardsPerGroup, callback, index + 1, selected);
    selected.length -= cardsPerGroup;
  }

  const entries = [...groups.entries()];
  for (const [, ids] of entries) {
    add(ids.slice(0, 1));
    if (ids.length >= 2) add(ids.slice(0, 2));
    if (ids.length >= 3) add(ids.slice(0, 3));
    if (ids.length === 4) add(ids);
  }
  if (groups.has(16) && groups.has(17)) add([groups.get(16)[0], groups.get(17)[0]]);

  for (const [value, ids] of entries) {
    if (ids.length < 3) continue;
    for (const [otherValue, otherIds] of entries) {
      if (otherValue === value) continue;
      add([...ids.slice(0, 3), otherIds[0]]);
    }
  }

  for (const [unit, minimum] of [[1, 5], [2, 3]]) {
    for (let start = 3; start <= 14; start += 1) {
      const run = [];
      for (let value = start; value <= 14 && (groups.get(value)?.length || 0) >= unit; value += 1) {
        run.push(...groups.get(value).slice(0, unit));
        if (value - start + 1 >= minimum) add(run);
      }
    }
  }

  for (let start = 3; start <= 14; start += 1) {
    const core = [];
    const coreValues = new Set();
    for (let value = start; value <= 14 && (groups.get(value)?.length || 0) >= 3; value += 1) {
      core.push(...groups.get(value).slice(0, 3));
      coreValues.add(value);
      const length = value - start + 1;
      if (length < 2) continue;
      add(core);
      const outside = entries.filter(([rank]) => !coreValues.has(rank));
      groupedAttachments(outside, length, 1, (wings) => add([...core, ...wings]));
      groupedAttachments(outside, length, 2, (wings) => add([...core, ...wings]));
    }
  }

  for (const [value, ids] of entries) {
    if (ids.length !== 4) continue;
    const outside = entries.filter(([rank]) => rank !== value);
    attachments(outside, 2, (wings) => add([...ids, ...wings]));
    groupedAttachments(outside, 2, 2, (wings) => add([...ids, ...wings]));
  }
  return moves;
}

function takeLongestRun(counts, amount, minimum) {
  let best = [];
  let current = [];
  for (let value = 3; value <= 14; value += 1) {
    if ((counts.get(value) || 0) >= amount) current.push(value);
    else {
      if (current.length > best.length) best = current;
      current = [];
    }
  }
  if (current.length > best.length) best = current;
  if (best.length < minimum) return false;
  for (const value of best) counts.set(value, counts.get(value) - amount);
  return true;
}

function estimateHandTurns(hand) {
  if (!hand.length) return 0;
  if (classifyCards(hand)) return 1;
  const counts = new Map();
  for (const card of hand) counts.set(card.value, (counts.get(card.value) || 0) + 1);
  let turns = 0;
  for (const [amount, minimum] of [[3, 2], [2, 3], [1, 5]]) {
    while (takeLongestRun(counts, amount, minimum)) turns += 1;
  }
  const remaining = [...counts.entries()].filter(([, count]) => count > 0);
  const triples = remaining.filter(([, count]) => count === 3).length;
  const attachments = Math.min(triples, remaining.filter(([, count]) => count === 1).length);
  turns += remaining.length - attachments;
  if ((counts.get(16) || 0) && (counts.get(17) || 0)) turns -= 1;
  return Math.max(1, turns);
}

function moveBreakPenalty(hand, move) {
  const held = new Map();
  const used = new Map();
  for (const card of hand) held.set(card.value, (held.get(card.value) || 0) + 1);
  for (const id of move.ids) {
    const value = DECK[id].value;
    used.set(value, (used.get(value) || 0) + 1);
  }
  let penalty = 0;
  for (const [value, amount] of used) {
    const total = held.get(value);
    if (amount >= total) continue;
    if (total === 4) penalty += 12;
    else if (total === 3) penalty += 5;
    else if (total === 2) penalty += 2;
  }
  if (held.has(16) && held.has(17) && (used.has(16) !== used.has(17))) penalty += 10;
  return penalty;
}

function publicPotentialCounts(room, player) {
  const counts = new Map();
  for (const card of DECK) counts.set(card.value, (counts.get(card.value) || 0) + 1);
  const knownIds = new Set();
  for (const card of player.hand) knownIds.add(card.id);
  for (const play of room.playHistory || []) {
    for (const card of play.cards || []) knownIds.add(card.id);
  }
  for (const card of room.lastPlay?.cards || []) knownIds.add(card.id);
  for (const id of knownIds) {
    const card = DECK[id];
    if (card) counts.set(card.value, Math.max(0, (counts.get(card.value) || 0) - 1));
  }
  return counts;
}

function higherPublicThreats(pattern, potential) {
  if (pattern.type === 'rocket') return 0;
  const rocket = (potential.get(16) || 0) > 0 && (potential.get(17) || 0) > 0 ? 1 : 0;
  const bombs = () => {
    let count = rocket;
    for (let value = pattern.type === 'bomb' ? pattern.mainValue + 1 : 3; value <= 15; value += 1) {
      if ((potential.get(value) || 0) >= 4) count += 1;
    }
    return count;
  };
  if (pattern.type === 'bomb') return bombs();

  const unit = pattern.type === 'pair' || pattern.type === 'pair-straight' ? 2
    : pattern.type === 'triple' || pattern.type === 'triple-single' || pattern.type.startsWith('plane') ? 3
      : pattern.type.startsWith('four-') ? 4 : 1;
  let sameType = 0;
  if (pattern.chainLength > 1) {
    for (let end = pattern.mainValue + 1; end <= 14; end += 1) {
      const start = end - pattern.chainLength + 1;
      if (start >= 3 && Array.from({ length: pattern.chainLength }, (_, index) => start + index)
        .every((value) => (potential.get(value) || 0) >= unit)) sameType += 1;
    }
  } else {
    const maximum = unit === 1 ? 17 : 15;
    for (let value = pattern.mainValue + 1; value <= maximum; value += 1) {
      if ((potential.get(value) || 0) >= unit) sameType += 1;
    }
  }
  return sameType + bombs();
}

function sameTeam(room, firstId, secondId) {
  return firstId === secondId || (firstId !== room.landlordId && secondId !== room.landlordId);
}

function aiPublicContext(room, player) {
  const seats = room.players.map((seat) => ({
    id: seat.id,
    cardCount: seat.hand.length,
    isLandlord: seat.id === room.landlordId,
  }));
  const opponents = seats.filter((seat) => !sameTeam(room, player.id, seat.id));
  const teammate = seats.find((seat) => seat.id !== player.id && sameTeam(room, player.id, seat.id)) || null;
  const previous = seats.find((seat) => seat.id === room.lastPlay?.playerId) || null;
  return {
    opponentMin: opponents.length ? Math.min(...opponents.map((seat) => seat.cardCount)) : 20,
    teammate,
    previous,
    previousIsTeammate: !!previous && previous.id !== player.id && sameTeam(room, player.id, previous.id),
    teammateActsNext: !!teammate && nextPlayer(room, player.id).id === teammate.id,
    potential: publicPotentialCounts(room, player),
  };
}

function scoreAiMove(room, player, move, context) {
  const played = new Set(move.ids);
  const remaining = player.hand.filter((card) => !played.has(card.id));
  if (!remaining.length) return -1_000_000;
  const urgent = context.opponentMin <= 2;
  const explosive = move.pattern.type === 'bomb' || move.pattern.type === 'rocket';
  let score = estimateHandTurns(remaining) * 110;
  score += moveBreakPenalty(player.hand, move) * 11;
  score -= move.ids.length * 4;
  score += move.pattern.mainValue * (room.lastPlay ? (urgent ? -2 : 1.5) : 0.35);
  if (explosive && !urgent) score += 145;

  const publicThreats = higherPublicThreats(move.pattern, context.potential);
  score += publicThreats * (urgent ? 170 : 3);
  if (urgent && move.pattern.count > context.opponentMin) score -= 135;

  if (!room.lastPlay && context.teammateActsNext && context.teammate?.cardCount <= 2) {
    const helpsTeammate = context.teammate.cardCount === 1
      ? move.pattern.type === 'single'
      : ['single', 'pair'].includes(move.pattern.type);
    if (helpsTeammate) score -= 85;
  }
  return score;
}

function rankedLegalPlays(room, player) {
  const previous = room.lastPlay?.pattern || null;
  const moves = legalAiMoves(player.hand, previous);
  if (!moves.length) return [];
  const context = aiPublicContext(room, player);
  const seen = new Set();
  const ranked = moves
    .filter((move) => {
      const signature = [...move.ids].sort((a, b) => a - b).join(',');
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    })
    .map((move) => ({ move, score: scoreAiMove(room, player, move, context) }));
  const explosiveOrder = (move) => move.pattern.type === 'rocket' ? 2 : move.pattern.type === 'bomb' ? 1 : 0;
  ranked.sort((first, second) => (
    explosiveOrder(first.move) - explosiveOrder(second.move)
    || first.score - second.score
    || first.move.pattern.mainValue - second.move.pattern.mainValue
    || second.move.ids.length - first.move.ids.length
    || first.move.ids.join(',').localeCompare(second.move.ids.join(','))
  ));
  return ranked.map(({ move }) => move);
}

function chooseAiPlay(room, player) {
  const context = aiPublicContext(room, player);
  if (room.lastPlay && context.previousIsTeammate && context.opponentMin > 2) {
    // Keep a farmer teammate's initiative unless the landlord is about to go out.
    return null;
  }
  return rankedLegalPlays(room, player)[0]?.ids || null;
}

function playHint(room, player) {
  const candidates = rankedLegalPlays(room, player).map((move) => move.ids);
  const context = aiPublicContext(room, player);
  const teammateHasInitiative = !!room.lastPlay && context.previousIsTeammate && context.opponentMin > 2;
  if (!candidates.length) {
    return {
      hintAction: 'pass',
      hintCards: [],
      hintCandidates: [],
      hintMessage: room.lastPlay ? '没有大过上家的牌，建议不出。' : '当前没有可出的合法牌。',
    };
  }
  if (teammateHasInitiative) {
    return {
      hintAction: 'pass',
      hintCards: [],
      hintCandidates: candidates,
      hintMessage: '队友掌握牌权，建议不出并保留大牌；再次点击提示可查看能压住的牌。',
    };
  }

  const cards = candidates[0];
  const pattern = classifyCards(cards);
  const explosive = pattern?.type === 'bomb' || pattern?.type === 'rocket';
  let hintMessage = room.lastPlay
    ? '已选中一组代价较小的压制牌。'
    : '已选中一组有利于减少剩余手数的牌。';
  if (context.opponentMin <= 2) hintMessage = '对手即将出完，已选中更有控制力的拦截牌。';
  else if (explosive) hintMessage = '普通牌无法完成合适的压制，建议使用炸弹牌型。';
  return { hintAction: 'play', hintCards: cards, hintCandidates: candidates, hintMessage };
}

function aiTakeTurn(room, player) {
  const move = chooseAiPlay(room, player);
  if (move) applyPlay(room, player, move);
  else if (room.lastPlay) applyPass(room, player);
  else applyPlay(room, player, [sorted(player.hand)[0].id]);
}

function leaveRoom(room, player) {
  for (const client of player.clients) client.end();
  player.clients.clear();
  room.nextReadyIds.delete(player.id);
  touch(room);
  if (['bidding', 'playing'].includes(room.phase)) {
    player.left = true;
    if (room.phase === 'playing' && room.landlordId) {
      finishRound(room, player.id === room.landlordId ? 'farmers' : 'landlord');
      room.message = `${player.name} 离开，按认输结算。`;
      broadcast(room);
    } else {
      clearTurn(room);
      room.phase = 'finished';
      room.currentTurnId = null;
      room.winners = [];
      room.nextReadyIds.clear();
      room.message = `${player.name} 离开，叫分中断。`;
      broadcast(room);
    }
  } else {
    room.players = room.players.filter((seat) => seat.id !== player.id);
    if (room.phase === 'finished') maybeStartNextRound(room);
    else broadcast(room);
  }
  if (!room.players.some((seat) => !seat.isAi && !seat.left)) {
    clearTurn(room);
    if (room.interactionTimer) clearTimeout(room.interactionTimer);
    if (room.presenceTimer) clearTimeout(room.presenceTimer);
    rooms.delete(room.code);
  }
}

function serveEvents(req, res, room, player) {
  if (player.clients.size >= MAX_SSE_PER_PLAYER) return fail(res, 429, '该玩家的实时连接过多');
  const wasOnline = isOnline(player);
  if (!wasOnline) room.nextReadyIds.delete(player.id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  player.clients.add(res);
  touch(room, player);
  res.write(`data: ${JSON.stringify(state(room, player))}\n\n`);
  if (!wasOnline) broadcast(room, res);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { res.end(); }
  }, 20_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    player.clients.delete(res);
    schedulePresenceUpdate(room);
    if (!isOnline(player)) {
      room.nextReadyIds.delete(player.id);
      broadcast(room);
    }
  });
}

async function handleRequest(req, res, pathname, url) {
  try {
    if (pathname === '/api/doudizhu/rooms' && req.method === 'POST') {
      const body = await readJson(req);
      const name = checkName(body.name);
      if (!name) return fail(res, 400, '昵称需要 1–18 个字符');
      const mode = body.mode === undefined ? 'online' : body.mode;
      if (!['solo', 'online'].includes(mode)) return fail(res, 400, '模式须为 solo 或 online');
      const limitError = reserveRoomCreation(req);
      if (limitError) return fail(res, 429, limitError);
      const { room, player } = createRoom(name, mode);
      return sendJson(res, 201, { code: room.code, token: player.token }, {
        'Set-Cookie': sessionCookie(req, room.code, player.token),
      });
    }
    if (pathname === '/api/doudizhu/rooms/join' && req.method === 'POST') {
      const body = await readJson(req);
      const name = checkName(body.name);
      if (!name) return fail(res, 400, '昵称需要 1–18 个字符');
      const room = getRoom(typeof body.code === 'string' ? body.code.trim() : '');
      if (!room) return fail(res, 404, '房间不存在或已过期');
      if (room.mode !== 'online') return fail(res, 409, '单机房间不能加入');
      if (!['lobby', 'finished'].includes(room.phase)) return fail(res, 409, '牌局进行中，暂不能加入');
      reclaimStaleSeats(room);
      if (room.players.length >= 3) return fail(res, 409, '房间已满（最多 3 人）');
      const player = newPlayer(name);
      room.players.push(player);
      touch(room, player);
      if (room.phase === 'finished') maybeStartNextRound(room);
      else broadcast(room);
      return sendJson(res, 201, { code: room.code, token: player.token }, {
        'Set-Cookie': sessionCookie(req, room.code, player.token),
      });
    }
    const match = /^\/api\/doudizhu\/rooms\/([A-Z2-9]{6})\/(state|events|action|session)$/i.exec(pathname);
    if (match) {
      const room = getRoom(match[1]);
      if (!room) return fail(res, 404, '房间不存在或已过期');
      if (match[2] === 'session' && req.method === 'POST') {
        const body = await readJson(req);
        const player = getPlayer(room, body.token);
        if (!player) return fail(res, 403, '房间身份无效');
        touch(room, player);
        return sendJson(res, 200, state(room, player), {
          'Set-Cookie': sessionCookie(req, room.code, player.token),
        });
      }
      if (match[2] === 'state' && req.method === 'GET') {
        const player = getPlayer(room, sessionToken(req, room.code));
        if (!player) return fail(res, 403, '房间身份无效');
        touch(room, player);
        return sendJson(res, 200, state(room, player));
      }
      if (match[2] === 'events' && req.method === 'GET') {
        const player = getPlayer(room, sessionToken(req, room.code));
        if (!player) return fail(res, 403, '房间身份无效');
        return serveEvents(req, res, room, player);
      }
      if (match[2] === 'action' && req.method === 'POST') {
        const body = await readJson(req);
        const player = getPlayer(room, body.token);
        if (!player) return fail(res, 403, '房间身份无效');
        if (body.action === 'leave') {
          leaveRoom(room, player);
          return sendJson(res, 200, { left: true }, {
            'Set-Cookie': sessionCookie(req, room.code, ''),
          });
        }
        touch(room, player);
        let error;
        if (body.action === 'start') {
          if (room.phase === 'lobby') {
            if (!state(room, player).canStart) error = '还不能开始，请等待三名在线玩家就位';
            else startRound(room);
          } else if (room.phase === 'finished') {
            room.nextReadyIds.add(player.id);
            maybeStartNextRound(room);
          } else error = '当前牌局进行中，不能开始新局';
        } else if (body.action === 'bid') error = applyBid(room, player, body.score);
        else if (body.action === 'play') error = applyPlay(room, player, body.cards);
        else if (body.action === 'pass') error = applyPass(room, player);
        else if (body.action === 'interact') {
          const interactionError = applyInteraction(room, player, body.interaction, body.targetId);
          if (interactionError) return fail(res, interactionError.status, interactionError.error);
        }
        else if (body.action === 'hint') {
          if (room.phase !== 'playing' || room.currentTurnId !== player.id) error = '只有轮到你出牌时才能提示';
          else return sendJson(res, 200, { ...state(room, player), ...playHint(room, player) });
        }
        else error = '未知操作';
        if (error) return fail(res, 409, error);
        return sendJson(res, 200, state(room, player));
      }
      return fail(res, 405, '请求方式不支持');
    }
    return fail(res, 404, '接口不存在');
  } catch (error) {
    if (!res.headersSent) fail(res, error.status || 500, error.status ? error.message : '服务器出了点问题');
    else res.end();
    if (!error.status) console.error(error);
  }
}

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60_000;
  for (const [code, room] of rooms) {
    if (room.lastActivity >= cutoff || room.players.some((player) => player.clients.size)) continue;
    clearTurn(room);
    if (room.interactionTimer) clearTimeout(room.interactionTimer);
    if (room.presenceTimer) clearTimeout(room.presenceTimer);
    rooms.delete(code);
  }
  const windowStart = Date.now() - CREATE_WINDOW_MS;
  for (const [address, attempts] of createAttempts) {
    const recent = attempts.filter((time) => time > windowStart);
    if (recent.length) createAttempts.set(address, recent);
    else createAttempts.delete(address);
  }
}, 15 * 60_000).unref();

module.exports = {
  handleRequest,
  liveRoomCount: () => rooms.size,
  testing: { DECK, rooms, createAttempts, limits: { MAX_ROOMS, MAX_CREATES_PER_ADDRESS, MAX_SSE_PER_PLAYER, INTERACTION_COOLDOWN_MS, INTERACTION_TTL_MS }, createRoom, state, classifyCards, beats, startRound, applyBid, applyPlay, applyPass, applyInteraction, legalAiMoves, chooseAiPlay, playHint, rankedLegalPlays, finishRound, scheduleTurn, schedulePresenceUpdate },
};
