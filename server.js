const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const SITE_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const STARTING_BANKROLL = 1_000;
const TARGET_BANKROLL = 10_000;
const MINIMUM_BET = 50;
const BET_MS = Number(process.env.BET_MS || 30_000);
const TURN_MS = Number(process.env.TURN_MS || 75_000);
const MAX_PLAYERS = 6;
const rooms = new Map();

const suits = ['♠', '♥', '♣', '♦'];
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
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
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    const error = new Error('请求格式有误');
    error.status = 400;
    throw error;
  }
}

function checkName(input) {
  if (typeof input !== 'string') return null;
  const name = input.trim().replace(/\s+/g, ' ');
  return name && name.length <= 18 ? name : null;
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
}

function makePlayer(name) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString('base64url'),
    name,
    clients: new Set(),
    lastSeen: Date.now(),
    bankroll: STARTING_BANKROLL,
    wager: 0,
    playedRounds: 0,
    cards: [],
    status: 'waiting',
    roundResult: null,
  };
}

function touch(room, player) {
  room.lastActivity = Date.now();
  if (player) player.lastSeen = Date.now();
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase());
}

function getPlayer(room, token) {
  return room && room.players.find((player) => player.token === token);
}

function localNetworkUrl() {
  const interfaces = os.networkInterfaces();
  const ordered = Object.entries(interfaces).sort(([a], [b]) => {
    const priority = (name) => /^(en0|en1|eth0|wlan0)$/i.test(name) ? 0 : 1;
    return priority(a) - priority(b);
  });
  for (const [, addresses] of ordered) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) {
        return `http://${address.address}:${PORT}`;
      }
    }
  }
  return null;
}

function makeShoe() {
  const shoe = [];
  for (let deck = 0; deck < 6; deck += 1) {
    for (const suit of suits) {
      for (const rank of ranks) shoe.push({ rank, suit });
    }
  }
  for (let i = shoe.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function draw(room) {
  if (room.shoe.length === 0) room.shoe = makeShoe();
  return room.shoe.pop();
}

function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === 'A') {
      aces += 1;
      total += 1;
    } else if (['J', 'Q', 'K'].includes(card.rank)) {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }
  const soft = aces > 0 && total + 10 <= 21;
  if (soft) total += 10;
  return { total, soft };
}

function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards).total === 21;
}

function participants(room) {
  return room.players.filter((player) => player.wager > 0 && player.cards.length >= 2);
}

function bettors(room) {
  return room.players.filter((player) => player.status === 'betting' || player.status === 'ready');
}

function makeState(room, viewer) {
  const reveal = room.phase === 'results' || room.phase === 'finished';
  const isHost = room.hostId === viewer.id;
  const players = room.players.map((player) => {
    const visible = reveal || player.id === viewer.id;
    return {
      id: player.id,
      name: player.name,
      connected: player.clients.size > 0 || Date.now() - player.lastSeen < 10_000,
      cards: visible ? player.cards : [],
      cardCount: player.cards.length,
      total: visible && player.cards.length ? handValue(player.cards).total : null,
      status: player.status,
      bankroll: player.bankroll,
      wager: player.wager,
      score: player.bankroll - STARTING_BANKROLL,
      playedRounds: player.playedRounds,
      roundResult: reveal ? player.roundResult : null,
    };
  });
  const dealerCards = reveal ? room.dealer.cards : room.phase === 'playing' ? room.dealer.cards.slice(0, 1) : [];
  const ownStatus = viewer.status;
  return {
    code: room.code,
    networkUrl: localNetworkUrl(),
    phase: room.phase,
    round: room.round,
    totalRounds: null,
    startingBankroll: STARTING_BANKROLL,
    targetBankroll: TARGET_BANKROLL,
    minimumBet: MINIMUM_BET,
    winners: room.winners,
    isHost,
    selfId: viewer.id,
    players,
    dealer: {
      cards: dealerCards,
      cardCount: room.dealer.cards.length,
      total: reveal && room.dealer.cards.length ? handValue(room.dealer.cards).total : null,
      status: room.dealer.status,
    },
    deadlineAt: room.phase === 'betting' || room.phase === 'playing' ? room.deadlineAt : null,
    shoeRemaining: room.shoe.length,
    canStart: isHost && (room.phase === 'lobby' || room.phase === 'finished'),
    canBet: room.phase === 'betting' && ownStatus === 'betting',
    canHit: room.phase === 'playing' && ownStatus === 'playing',
    canStand: room.phase === 'playing' && ownStatus === 'playing',
    canDouble: room.phase === 'playing' && ownStatus === 'playing' && viewer.cards.length === 2 && viewer.bankroll >= viewer.wager * 2,
    canNext: isHost && room.phase === 'results',
    message: room.message,
  };
}

function sendEvent(res, data) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function broadcast(room) {
  for (const player of room.players) {
    const state = makeState(room, player);
    for (const client of player.clients) {
      if (!sendEvent(client, state)) player.clients.delete(client);
    }
  }
}

function clearRoundTimer(room) {
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = null;
  room.deadlineAt = null;
}

function scoreRound(room) {
  if (room.phase !== 'playing') return;
  clearRoundTimer(room);
  const eligible = participants(room).filter((player) => handValue(player.cards).total <= 21 && !isBlackjack(player.cards));
  const dealerBlackjack = isBlackjack(room.dealer.cards);
  if (!dealerBlackjack && eligible.length) {
    while (handValue(room.dealer.cards).total < 17) room.dealer.cards.push(draw(room));
  }
  const dealerTotal = handValue(room.dealer.cards).total;
  room.dealer.status = dealerTotal > 21 ? 'bust' : 'stood';

  for (const player of participants(room)) {
    const total = handValue(player.cards).total;
    const natural = isBlackjack(player.cards);
    let outcome;
    let delta;
    let label;
    if (natural && dealerBlackjack) {
      [outcome, delta, label] = ['push', 0, `你 ${total} 点、庄家 ${dealerTotal} 点，双方均为自然 Blackjack；平局，退回下注 ${player.wager} 筹码`];
    } else if (natural) {
      delta = Math.floor(player.wager * 1.5);
      [outcome, label] = ['win', `你 ${total} 点（自然 Blackjack）、庄家 ${dealerTotal} 点${dealerTotal === 21 ? '（非自然）' : ''}；自然 Blackjack 获胜，赢得 ${delta} 筹码`];
    } else if (total > 21) {
      [outcome, delta, label] = ['lose', -player.wager, `你 ${total} 点爆牌、庄家 ${dealerTotal} 点；失去 ${player.wager} 筹码`];
    } else if (dealerBlackjack) {
      [outcome, delta, label] = ['lose', -player.wager, `你 ${total} 点${total === 21 ? '（非自然）' : ''}、庄家 ${dealerTotal} 点（自然 Blackjack）；庄家自然 Blackjack 获胜，失去 ${player.wager} 筹码`];
    } else if (dealerTotal > 21 || total > dealerTotal) {
      [outcome, delta, label] = ['win', player.wager, `你 ${total} 点、庄家 ${dealerTotal} 点；${dealerTotal > 21 ? '庄家爆牌' : '点数高于庄家'}，赢得 ${player.wager} 筹码`];
    } else if (total < dealerTotal) {
      [outcome, delta, label] = ['lose', -player.wager, `你 ${total} 点、庄家 ${dealerTotal} 点；点数低于庄家，失去 ${player.wager} 筹码`];
    } else {
      [outcome, delta, label] = ['push', 0, `你 ${total} 点、庄家 ${dealerTotal} 点；平局，退回下注 ${player.wager} 筹码`];
    }
    player.bankroll += delta;
    player.roundResult = { outcome, delta, points: delta, label };
    player.status = outcome;
  }

  const atTarget = room.players.filter((player) => player.bankroll >= TARGET_BANKROLL);
  if (atTarget.length) {
    const highest = Math.max(...atTarget.map((player) => player.bankroll));
    room.winners = atTarget.filter((player) => player.bankroll === highest).map((player) => player.id);
    room.phase = 'finished';
    const names = room.players.filter((player) => room.winners.includes(player.id)).map((player) => player.name);
    room.message = `${names.join('、')} 达到目标，挑战结束！主持人可以再开一场。`;
  } else if (room.players.every((player) => player.bankroll === 0)) {
    room.winners = [];
    room.phase = 'finished';
    room.message = '全员筹码归零，挑战结束。主持人可以再开一场。';
  } else {
    room.phase = 'results';
    room.message = '本局结算完成，等待主持人开启下一局下注。';
  }
  broadcast(room);
}

function finishIfReady(room) {
  if (room.phase !== 'playing') return;
  if (participants(room).every((player) => player.status !== 'playing')) scoreRound(room);
  else broadcast(room);
}

function finishBetting(room) {
  if (bettors(room).some((player) => player.status === 'ready')) {
    dealRound(room);
    return;
  }
  clearRoundTimer(room);
  room.phase = 'results';
  room.message = '本局无人下注，主持人可以开启下一局。';
  broadcast(room);
}

function dealRound(room) {
  clearRoundTimer(room);
  if (room.shoe.length < 78) room.shoe = makeShoe();
  room.phase = 'playing';
  room.dealer = { cards: [], status: 'playing' };
  const active = room.players.filter((player) => player.status === 'ready');
  for (const player of active) {
    player.status = 'playing';
    player.playedRounds += 1;
  }
  // Deal in table order: one card to each player, one to dealer, then repeat.
  for (const player of active) player.cards.push(draw(room));
  room.dealer.cards.push(draw(room));
  for (const player of active) player.cards.push(draw(room));
  room.dealer.cards.push(draw(room));
  for (const player of active) {
    if (isBlackjack(player.cards)) player.status = 'blackjack';
  }
  room.message = `第 ${room.round} 局：请要牌、停牌或加倍。`;
  if (isBlackjack(room.dealer.cards) || active.every((player) => player.status !== 'playing')) {
    scoreRound(room);
    return;
  }
  room.deadlineAt = Date.now() + TURN_MS;
  room.roundTimer = setTimeout(() => {
    if (room.phase !== 'playing') return;
    for (const player of participants(room)) {
      if (player.status === 'playing') player.status = 'stood';
    }
    scoreRound(room);
  }, TURN_MS);
  broadcast(room);
}

function beginBetting(room) {
  clearRoundTimer(room);
  room.round += 1;
  room.phase = 'betting';
  room.dealer = { cards: [], status: 'waiting' };
  const now = Date.now();
  for (const player of room.players) {
    player.cards = [];
    player.wager = 0;
    player.roundResult = null;
    const present = player.clients.size > 0 || now - player.lastSeen < 30_000;
    player.status = player.bankroll === 0 ? 'eliminated' : present ? 'betting' : 'spectating';
  }
  room.message = `第 ${room.round} 局：请选择下注额，30 秒后自动押最低额。`;
  room.deadlineAt = Date.now() + BET_MS;
  room.roundTimer = setTimeout(() => {
    if (room.phase !== 'betting') return;
    for (const player of bettors(room)) {
      if (player.status !== 'betting') continue;
      if (!player.clients.size && Date.now() - player.lastSeen >= 30_000) {
        player.status = 'spectating';
        continue;
      }
      player.wager = Math.min(MINIMUM_BET, player.bankroll);
      player.status = 'ready';
    }
    finishBetting(room);
  }, BET_MS);
  broadcast(room);
}

function createRoom(name) {
  const player = makePlayer(name);
  const room = {
    code: makeRoomCode(),
    phase: 'lobby',
    round: 0,
    players: [player],
    hostId: player.id,
    winners: [],
    dealer: { cards: [], status: 'waiting' },
    shoe: makeShoe(),
    message: '把房间码发给朋友，主持人可以开始游戏。',
    lastActivity: Date.now(),
    roundTimer: null,
    deadlineAt: null,
    hostTransferTimer: null,
  };
  rooms.set(room.code, room);
  return { room, player };
}

function scheduleHostTransfer(room) {
  if (room.hostTransferTimer) clearTimeout(room.hostTransferTimer);
  room.hostTransferTimer = setTimeout(() => {
    room.hostTransferTimer = null;
    const host = room.players.find((player) => player.id === room.hostId);
    if (host && host.clients.size) return;
    if (host && Date.now() - host.lastSeen < 30_000) {
      scheduleHostTransfer(room);
      return;
    }
    const nextHost = room.players.find((player) => player.clients.size > 0);
    if (nextHost && nextHost.id !== room.hostId) {
      room.hostId = nextHost.id;
      room.message = `${nextHost.name} 已接任主持人。`;
      broadcast(room);
    }
  }, 30_000);
  room.hostTransferTimer.unref();
}

function serveEvents(req, res, room, player) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  player.clients.add(res);
  if (room.hostId === player.id && room.hostTransferTimer) {
    clearTimeout(room.hostTransferTimer);
    room.hostTransferTimer = null;
  }
  touch(room, player);
  broadcast(room);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { res.end(); }
  }, 20_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    player.clients.delete(res);
    if (room.hostId === player.id && !player.clients.size) scheduleHostTransfer(room);
    broadcast(room);
  });
}

function handleAction(room, player, action, amount) {
  touch(room, player);
  if (action === 'start') {
    if (room.hostId !== player.id || !['lobby', 'finished'].includes(room.phase)) return '现在不能开始游戏';
    room.round = 0;
    room.shoe = makeShoe();
    room.winners = [];
    for (const seat of room.players) {
      seat.bankroll = STARTING_BANKROLL;
      seat.wager = 0;
      seat.playedRounds = 0;
    }
    beginBetting(room);
  } else if (action === 'next') {
    if (room.hostId !== player.id || room.phase !== 'results') return '现在不能进入下一回合';
    beginBetting(room);
  } else if (action === 'bet') {
    if (room.phase !== 'betting' || player.status !== 'betting') return '现在不能下注';
    const minimum = Math.min(MINIMUM_BET, player.bankroll);
    if (!Number.isSafeInteger(amount) || amount < minimum || amount > player.bankroll) {
      return `下注额须为 ${minimum} 到 ${player.bankroll} 的整数`;
    }
    player.wager = amount;
    player.status = 'ready';
    if (bettors(room).every((seat) => seat.status === 'ready')) finishBetting(room);
    else broadcast(room);
  } else if (action === 'hit') {
    if (room.phase !== 'playing' || player.status !== 'playing') return '现在不能要牌';
    player.cards.push(draw(room));
    const total = handValue(player.cards).total;
    if (total > 21) player.status = 'bust';
    else if (total === 21) player.status = 'stood';
    finishIfReady(room);
  } else if (action === 'stand') {
    if (room.phase !== 'playing' || player.status !== 'playing') return '现在不能停牌';
    player.status = 'stood';
    finishIfReady(room);
  } else if (action === 'double') {
    if (room.phase !== 'playing' || player.status !== 'playing' || player.cards.length !== 2 || player.bankroll < player.wager * 2) {
      return '现在不能加倍';
    }
    player.wager *= 2;
    player.cards.push(draw(room));
    player.status = handValue(player.cards).total > 21 ? 'bust' : 'stood';
    finishIfReady(room);
  } else {
    return '未知操作';
  }
  return null;
}

function leaveRoom(room, player) {
  const wasHost = room.hostId === player.id;
  room.players = room.players.filter((seat) => seat.id !== player.id);
  for (const client of player.clients) client.end();
  player.clients.clear();
  touch(room);

  if (room.players.length === 0) {
    clearRoundTimer(room);
    if (room.hostTransferTimer) clearTimeout(room.hostTransferTimer);
    rooms.delete(room.code);
    return;
  }
  if (wasHost) {
    room.hostId = (room.players.find((seat) => seat.clients.size) || room.players[0]).id;
    room.message = `${room.players.find((seat) => seat.id === room.hostId).name} 已接任主持人。`;
  }
  if (room.phase !== 'lobby' && room.phase !== 'finished' && room.players.every((seat) => seat.bankroll === 0)) {
    clearRoundTimer(room);
    room.phase = 'finished';
    room.winners = [];
    room.message = '全员筹码归零，挑战结束。主持人可以再开一场。';
    broadcast(room);
    return;
  }
  if (room.phase === 'playing') finishIfReady(room);
  else if (room.phase === 'betting' && bettors(room).every((seat) => seat.status === 'ready')) {
    finishBetting(room);
  } else broadcast(room);
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '请求方式不支持');
  const relative = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(relative); } catch { return fail(res, 400, '路径有误'); }
  if (decoded.split('/').some((part) => part.startsWith('.'))) return fail(res, 404, '页面不存在');
  const extension = path.extname(decoded).toLowerCase();
  if (!contentTypes[extension] || extension === '.json') return fail(res, 404, '页面不存在');
  const file = path.resolve(SITE_DIR, `.${decoded}`);
  if (!file.startsWith(`${SITE_DIR}${path.sep}`)) return fail(res, 404, '页面不存在');
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return fail(res, 404, '页面不存在');
    res.writeHead(200, {
      'Content-Type': contentTypes[extension],
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  } catch {
    fail(res, 404, '页面不存在');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, rooms: rooms.size });
    }
    if (pathname === '/api/rooms' && req.method === 'POST') {
      const body = await readJson(req);
      const name = checkName(body.name);
      if (!name) return fail(res, 400, '昵称需要 1–18 个字符');
      const { room, player } = createRoom(name);
      return sendJson(res, 201, { code: room.code, token: player.token });
    }
    if (pathname === '/api/rooms/join' && req.method === 'POST') {
      const body = await readJson(req);
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      const room = getRoom(code);
      const name = checkName(body.name);
      if (!name) return fail(res, 400, '昵称需要 1–18 个字符');
      if (!room) return fail(res, 404, '房间不存在或已过期');
      if (room.players.length >= MAX_PLAYERS) return fail(res, 409, '房间已满（最多 6 人）');
      const player = makePlayer(name);
      if (room.phase === 'betting' || room.phase === 'playing') player.status = 'spectating';
      room.players.push(player);
      touch(room, player);
      broadcast(room);
      if (!room.players.find((seat) => seat.id === room.hostId)?.clients.size) scheduleHostTransfer(room);
      return sendJson(res, 201, { code: room.code, token: player.token });
    }
    const match = /^\/api\/rooms\/([A-Z2-9]{6})\/(state|events|action)$/i.exec(pathname);
    if (match) {
      const room = getRoom(match[1]);
      if (!room) return fail(res, 404, '房间不存在或已过期');
      if (match[2] === 'state' && req.method === 'GET') {
        const player = getPlayer(room, url.searchParams.get('token'));
        if (!player) return fail(res, 403, '房间身份无效');
        touch(room, player);
        return sendJson(res, 200, makeState(room, player));
      }
      if (match[2] === 'events' && req.method === 'GET') {
        const player = getPlayer(room, url.searchParams.get('token'));
        if (!player) return fail(res, 403, '房间身份无效');
        return serveEvents(req, res, room, player);
      }
      if (match[2] === 'action' && req.method === 'POST') {
        const body = await readJson(req);
        const player = getPlayer(room, body.token);
        if (!player) return fail(res, 403, '房间身份无效');
        if (body.action === 'leave') {
          leaveRoom(room, player);
          return sendJson(res, 200, { left: true });
        }
        const error = handleAction(room, player, body.action, body.amount);
        if (error) return fail(res, 409, error);
        return sendJson(res, 200, makeState(room, player));
      }
      return fail(res, 405, '请求方式不支持');
    }
    if (pathname.startsWith('/api/')) return fail(res, 404, '接口不存在');
    return serveStatic(req, res, pathname);
  } catch (error) {
    if (!res.headersSent) fail(res, error.status || 500, error.status ? error.message : '服务器出了点问题');
    else res.end();
    if (!error.status) console.error(error);
  }
});

// Clear abandoned rooms without disturbing an active game or open event stream.
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.lastActivity >= cutoff || room.players.some((player) => player.clients.size)) continue;
    clearRoundTimer(room);
    if (room.hostTransferTimer) clearTimeout(room.hostTransferTimer);
    rooms.delete(code);
  }
}, 15 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`21 点牌桌已启动：http://localhost:${PORT}`);
    if (process.env.OPEN_BROWSER === '1' && process.platform === 'darwin') {
      require('node:child_process').spawn('open', [`http://localhost:${PORT}`], {
        stdio: 'ignore',
        detached: true,
      }).unref();
    }
  });
}

module.exports = { server, testing: { createRoom, makePlayer, handValue, isBlackjack, scoreRound, makeState } };
