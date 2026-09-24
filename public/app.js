const $ = (id) => document.getElementById(id);
const elements = {
  setupView: $('setupView'), gameView: $('gameView'), createForm: $('createForm'), joinForm: $('joinForm'),
  createName: $('createName'), joinName: $('joinName'), joinCode: $('joinCode'), joinButton: $('joinButton'),
  setupTitle: $('setupTitle'), setupIntro: $('setupIntro'), inviteNotice: $('inviteNotice'), inviteNoticeTitle: $('inviteNoticeTitle'), inviteNoticeText: $('inviteNoticeText'),
  connectionStatus: $('connectionStatus'), roomCode: $('roomCode'), roundLabel: $('roundLabel'),
  playerCountLabel: $('playerCountLabel'), matchGoalLabel: $('matchGoalLabel'), matchTimerBadge: $('matchTimerBadge'), timerBadge: $('timerBadge'), copyRoomCode: $('copyRoomCode'), shareInvite: $('shareInvite'), lobbyShareInvite: $('lobbyShareInvite'),
  leaveButton: $('leaveButton'), lobbyStage: $('lobbyStage'), bettingStage: $('bettingStage'), playStage: $('playStage'),
  finishedStage: $('finishedStage'), lobbySeats: $('lobbySeats'), startButton: $('startButton'),
  hostHint: $('hostHint'), dealerCards: $('dealerCards'), dealerTotal: $('dealerTotal'),
  selfCards: $('selfCards'), selfTotal: $('selfTotal'), selfOutcome: $('selfOutcome'),
  selfBankroll: $('selfBankroll'), selfWager: $('selfWager'), centerMessage: $('centerMessage'),
  hitButton: $('hitButton'), standButton: $('standButton'), doubleButton: $('doubleButton'),
  nextButton: $('nextButton'), waitingText: $('waitingText'), playersList: $('playersList'),
  playersBadge: $('playersBadge'), finalRanking: $('finalRanking'), shareResult: $('shareResult'), restartButton: $('restartButton'),
  finishedTitle: $('finishedTitle'), finishedMessage: $('finishedMessage'), finishedHint: $('finishedHint'),
  finalRoundNote: $('finalRoundNote'), reviewFinalHand: $('reviewFinalHand'),
  lobbyMatchSettings: $('lobbyMatchSettings'), lobbyTargetWrap: $('lobbyTargetWrap'), lobbyTarget: $('lobbyTarget'),
  restartMatchSettings: $('restartMatchSettings'), restartTargetWrap: $('restartTargetWrap'), restartTarget: $('restartTarget'),
  quickGoalRule: $('quickGoalRule'),
  betForm: $('betForm'), betAmount: $('betAmount'), betBankroll: $('betBankroll'), betLimits: $('betLimits'),
  betButton: $('betButton'), betPresets: $('betPresets'), betStatus: $('betStatus'),
  openRulesSetup: $('openRulesSetup'), openRulesInvite: $('openRulesInvite'), openRulesGame: $('openRulesGame'),
  rulesDialog: $('rulesDialog'), closeRules: $('closeRules'), toast: $('toast'),
};

let code = '';
let token = '';
let state = null;
let stream = null;
let pending = false;
let toastTimer = null;
let fallbackTimer = null;
let betDraftRound = null;
let selectedBetPreset = 'min';
let showFinalSummary = false;
let restartSettingsForMatch = '';
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const DEAL_STEP_MS = 450;
const DEALER_STEP_MS = 800;
const handVisual = { key: '', dealer: [], self: [], dealerTarget: [], selfTarget: [], timer: null };
const chipFormatter = new Intl.NumberFormat('zh-CN');
const chips = (amount) => chipFormatter.format(Number(amount) || 0);

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3800);
}

function setConnection(label, kind = '') {
  elements.connectionStatus.hidden = !code;
  elements.connectionStatus.className = `connection-status ${kind}`;
  elements.connectionStatus.lastChild.textContent = label;
}

function saveSession(roomCode, roomToken) {
  const sessions = JSON.parse(localStorage.getItem('blackjack:sessions') || '{}');
  sessions[roomCode] = roomToken;
  localStorage.setItem('blackjack:sessions', JSON.stringify(sessions));
  localStorage.setItem('blackjack:lastRoom', roomCode);
}

function clearSession(roomCode) {
  const sessions = JSON.parse(localStorage.getItem('blackjack:sessions') || '{}');
  delete sessions[roomCode];
  localStorage.setItem('blackjack:sessions', JSON.stringify(sessions));
  if (localStorage.getItem('blackjack:lastRoom') === roomCode) localStorage.removeItem('blackjack:lastRoom');
}

function setInviteLanding(roomCode, expired = false) {
  const invited = /^[A-Z2-9]{6}$/.test(roomCode);
  elements.setupView.classList.toggle('invited', invited);
  elements.inviteNotice.hidden = !invited;
  elements.openRulesInvite.hidden = !invited;
  elements.setupTitle.innerHTML = invited ? '朋友在等你，<br /><em>上桌来一局。</em>' : '今晚，<br /><em>来一局 21 点。</em>';
  elements.setupIntro.textContent = invited
    ? `房间 ${roomCode} 已填好。输入昵称就能加入朋友的牌桌，一起挑战 21 点。`
    : '开一张私人牌桌，发链接叫上朋友。每人带着 1,000 虚拟筹码入场，自己设定获胜目标，或来一场 10 分钟挑战。';
  elements.inviteNoticeTitle.textContent = expired ? '这个邀请可能已失效' : '朋友邀请你上桌';
  elements.inviteNoticeText.textContent = expired
    ? `房间 ${roomCode} 已结束或身份失效；可以尝试重新加入，或请朋友发新链接。`
    : `房间 ${roomCode} 已填好，输入昵称即可加入。`;
  elements.joinButton.innerHTML = invited ? '加入朋友的牌桌 <span aria-hidden="true">→</span>' : '加入牌桌 <span aria-hidden="true">→</span>';
  if (invited) elements.joinCode.value = roomCode;
}

function setRoom(roomCode, roomToken) {
  code = roomCode.toUpperCase();
  token = roomToken;
  betDraftRound = null;
  showFinalSummary = false;
  restartSettingsForMatch = '';
  resetHandVisual();
  saveSession(code, token);
  history.replaceState(null, '', `${location.pathname}?room=${encodeURIComponent(code)}`);
  elements.setupView.hidden = true;
  elements.gameView.hidden = false;
  setConnection('连接中');
  connectStream();
  refreshState();
}

function leaveRoomUI({ retainInvite = false, expired = false } = {}) {
  const previousCode = code;
  closeStream();
  resetHandVisual();
  clearSession(code);
  code = '';
  token = '';
  state = null;
  betDraftRound = null;
  showFinalSummary = false;
  restartSettingsForMatch = '';
  history.replaceState(null, '', retainInvite ? `${location.pathname}?room=${encodeURIComponent(previousCode)}` : location.pathname);
  elements.gameView.hidden = true;
  elements.setupView.hidden = false;
  elements.connectionStatus.hidden = true;
  elements.joinCode.value = '';
  setInviteLanding(retainInvite ? previousCode : '', expired);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || data.message || `请求失败 (${response.status})`);
  return data;
}

async function refreshState() {
  if (!code || !token) return;
  try {
    const data = await request(`/api/rooms/${encodeURIComponent(code)}/state?token=${encodeURIComponent(token)}`);
    updateState(data);
    setConnection('已连接', 'connected');
  } catch (error) {
    if (/失效|无效|不存在|not found|unauthorized|invalid/i.test(error.message)) {
      const missingRoom = /不存在|not found/i.test(error.message);
      showToast(missingRoom ? '这个房间已结束，请朋友重新发邀请。' : '房间身份已失效，请重新加入。');
      leaveRoomUI({ retainInvite: true, expired: missingRoom });
    } else {
      setConnection('重连中', 'disconnected');
    }
  }
}

function closeStream() {
  if (stream) { stream.close(); stream = null; }
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}

function connectStream() {
  closeStream();
  if (!window.EventSource) {
    fallbackTimer = setInterval(refreshState, 2500);
    return;
  }
  stream = new EventSource(`/api/rooms/${encodeURIComponent(code)}/events?token=${encodeURIComponent(token)}`);
  const receive = (event) => {
    try { updateState(JSON.parse(event.data)); } catch { /* Ignore malformed event. */ }
  };
  stream.addEventListener('message', receive);
  stream.addEventListener('state', receive);
  stream.onopen = () => setConnection('已连接', 'connected');
  stream.onerror = () => setConnection('重连中', 'disconnected');
  fallbackTimer = setInterval(() => {
    if (!stream || stream.readyState !== EventSource.OPEN) refreshState();
  }, 3000);
}

function cardHTML(card, effect = '') {
  if (!card || card.hidden || card.back) return `<div class="playing-card back ${effect}" aria-label="盖着的牌"></div>`;
  const rank = escapeHTML(card.rank);
  const suit = escapeHTML(card.suit);
  const red = card.suit === '♥' || card.suit === '♦';
  return `<div class="playing-card ${red ? 'red' : ''} ${effect}" aria-label="${rank}${suit}"><span class="card-rank">${rank}</span><span class="card-corner-suit">${suit}</span><span class="card-center-suit">${suit}</span><span class="card-bottom">${rank}</span></div>`;
}

function cardSlots(cards = [], cardCount = cards.length) {
  const visible = Array.isArray(cards) ? cards : [];
  return [...visible, ...Array(Math.max(0, Number(cardCount || 0) - visible.length)).fill(null)];
}

function sameCard(a, b) {
  if (!a || a.hidden || a.back) return !b || !!b.hidden || !!b.back;
  return !!b && !b.hidden && !b.back && a.rank === b.rank && a.suit === b.suit;
}

function sameHand(a, b) {
  return a.length === b.length && a.every((card, index) => sameCard(card, b[index]));
}

function resetHandVisual() {
  clearTimeout(handVisual.timer);
  handVisual.key = '';
  handVisual.dealer = [];
  handVisual.self = [];
  handVisual.dealerTarget = [];
  handVisual.selfTarget = [];
  handVisual.timer = null;
  elements.dealerCards.replaceChildren();
  elements.selfCards.replaceChildren();
}

function nextCardStep() {
  const { dealer, self, dealerTarget, selfTarget } = handVisual;
  // The first four cards arrive in table order. Even if a fast round has
  // already ended, the dealer's second card appears face down before reveal.
  if (self.length === 0 && selfTarget.length) return ['self', 0, selfTarget[0], 'deal'];
  if (dealer.length === 0 && dealerTarget.length) return ['dealer', 0, dealerTarget[0], 'deal'];
  if (self.length === 1 && selfTarget.length > 1) return ['self', 1, selfTarget[1], 'deal'];
  if (dealer.length === 1 && dealerTarget.length > 1) return ['dealer', 1, null, 'deal'];
  // Finish any newly drawn player card before revealing the dealer's hidden card.
  for (const side of ['self', 'dealer']) {
    const current = handVisual[side];
    const target = handVisual[`${side}Target`];
    for (let index = 0; index < Math.min(current.length, target.length); index += 1) {
      if (!sameCard(current[index], target[index])) return [side, index, target[index], 'flip'];
    }
    if (current.length < target.length) return [side, current.length, target[current.length], 'deal'];
  }
  return null;
}

function syncHandVisual(dealer, self) {
  const key = `${code}:${state.round}`;
  if (handVisual.key !== key) {
    resetHandVisual();
    handVisual.key = key;
  }
  handVisual.dealerTarget = cardSlots(dealer?.cards, dealer?.cardCount);
  handVisual.selfTarget = cardSlots(self?.cards, self?.cardCount);
  if (prefersReducedMotion.matches) {
    clearTimeout(handVisual.timer);
    handVisual.timer = null;
    for (const side of ['dealer', 'self']) {
      const target = handVisual[`${side}Target`];
      if (!sameHand(handVisual[side], target)) {
        elements[`${side}Cards`].innerHTML = target.map((card) => cardHTML(card)).join('');
        handVisual[side] = [...target];
      }
    }
    return false;
  }
  if (!handVisual.timer) {
    const step = nextCardStep();
    if (step) {
      const [side, index, card, kind] = step;
      const container = elements[`${side}Cards`];
      if (kind === 'flip') {
        container.children[index].outerHTML = cardHTML(card, 'flipping-card');
        handVisual[side][index] = card;
      } else {
        container.insertAdjacentHTML('beforeend', cardHTML(card, 'dealing-card'));
        handVisual[side].push(card);
      }
      handVisual.timer = setTimeout(() => {
        handVisual.timer = null;
        render();
      }, side === 'dealer' && ['results', 'finished'].includes(state.phase) ? DEALER_STEP_MS : DEAL_STEP_MS);
    }
  }
  return !!handVisual.timer || !!nextCardStep();
}

function statusText(player, phase) {
  if (!player.connected) return '暂时离线';
  if (phase === 'lobby') return '等待开局';
  if (phase === 'results') {
    const result = { win: '获胜', lose: '失利', push: '平局扣半' }[player.roundResult?.outcome] || '本局结束';
    return `${player.readyNext ? '已准备下一局' : '待准备下一局'} · ${result}`;
  }
  if (phase === 'dealing') return '正在发牌';
  if (player.status === 'spectating') return '下局加入';
  if (player.status === 'eliminated') return '筹码用尽 · 旁观中';
  if (phase === 'betting') return player.status === 'ready' ? '已下注 · 等待发牌' : '选择下注额';
  if (phase === 'finished') return { win: '末局获胜', lose: '末局失利', push: '末局平局扣半' }[player.roundResult?.outcome] || '本场结束';
  const dictionary = { playing: '考虑中', stood: '已停牌', bust: '已爆牌', blackjack: '21 点', waiting: '等待发牌', done: '已完成' };
  return dictionary[player.status] || '游戏中';
}

function readySummary(players) {
  const online = players.filter((player) => player.connected);
  return { ready: online.filter((player) => player.readyNext).length, total: online.length };
}

function renderPlayers(players, phase, settling = false) {
  const ordered = [...players].sort((a, b) => Number(b.bankroll || 0) - Number(a.bankroll || 0));
  elements.playersBadge.textContent = `${players.length} / 6`;
  elements.playersList.innerHTML = ordered.map((player) => {
    const self = player.id === state.selfId;
    const wager = player.wager > 0 && ['betting', 'dealing', 'playing', 'dealer-turn', 'results'].includes(phase) ? ` · 押 ${chips(player.wager)}` : '';
    const displayedBankroll = settling ? player.bankroll - (player.roundResult?.delta || 0) : player.bankroll;
    const displayedStatus = settling ? '庄家结算中…' : statusText(player, phase);
    return `<div class="player-row ${self ? 'self' : ''}">
      <span class="player-avatar">${escapeHTML((player.name || '?').slice(0, 1))}</span>
      <span class="player-info"><span class="player-name">${escapeHTML(player.name)}${self ? ' · 你' : ''}</span><span class="player-sub">${escapeHTML(displayedStatus)}${wager}</span></span>
      <span class="player-score"><strong>${chips(displayedBankroll)}</strong><small>筹码</small></span>
    </div>`;
  }).join('');
  elements.lobbySeats.innerHTML = players.map((player) => `<span class="seat"><span class="seat-avatar">${escapeHTML((player.name || '?').slice(0, 1))}</span>${escapeHTML(player.name)}${player.id === state.selfId ? ' · 你' : ''}</span>`).join('');
  elements.finalRanking.innerHTML = ordered.map((player) => {
    const place = ordered.findIndex((seat) => seat.bankroll === player.bankroll) + 1;
    const winner = Array.isArray(state.winners) && state.winners.includes(player.id);
    return `<div class="final-row ${winner ? 'champion' : ''}"><span class="place">${String(place).padStart(2, '0')}</span><span class="name">${escapeHTML(player.name)}${player.id === state.selfId ? ' · 你' : ''}${winner ? ' · 冠军' : ''}</span><span class="score">${chips(player.bankroll)} 筹码</span></div>`;
  }).join('');
}

function renderTimer() {
  if (!state) {
    elements.matchTimerBadge.hidden = true;
    elements.timerBadge.hidden = true;
    return;
  }
  const matchRunning = state.matchMode === 'endless' && !['lobby', 'finished'].includes(state.phase) && state.matchDeadlineAt;
  elements.matchTimerBadge.hidden = !matchRunning;
  if (matchRunning) {
    const remaining = Math.max(0, Math.ceil((Number(state.matchDeadlineAt) - Date.now()) / 1000));
    elements.matchTimerBadge.textContent = `整场 ${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  }
  const actionRunning = ['betting', 'playing'].includes(state.phase) && state.deadlineAt;
  elements.timerBadge.hidden = !actionRunning;
  if (actionRunning) {
    const seconds = Math.max(0, Math.ceil((Number(state.deadlineAt) - Date.now()) / 1000));
    elements.timerBadge.textContent = `${state.phase === 'betting' ? '下注' : '操作'} ${seconds} 秒`;
  }
}

function roundResultText(player, dealer) {
  const label = player?.roundResult?.label || '';
  if (!label || typeof player?.total !== 'number' || typeof dealer?.total !== 'number' || /你\s*\d+\s*点/.test(label)) return label;
  return `你 ${player.total} 点 · 庄家 ${dealer.total} 点；${label}`;
}

function betPresetAmount(preset, bankroll, minimum) {
  if (preset === 'min') return minimum;
  if (preset === 'all') return bankroll;
  const divisor = { quarter: 4, third: 3, half: 2 }[preset];
  return divisor ? Math.floor(bankroll / divisor) : NaN;
}

function renderBetting(self) {
  const bankroll = Number(self?.bankroll || 0);
  const minimum = Math.min(Number(state.minimumBet || 50), bankroll);
  elements.betBankroll.innerHTML = `${chips(bankroll)} <small>筹码</small>`;
  elements.betAmount.min = String(minimum);
  elements.betAmount.max = String(bankroll);
  elements.betLimits.textContent = bankroll < state.minimumBet
    ? `余额不足 ${state.minimumBet} 筹码，需要全押剩余 ${chips(bankroll)} 筹码。`
    : `本局最低 ${chips(minimum)} 筹码，最高 ${chips(bankroll)} 筹码。比例档向下取整，低于最低额时不可选。`;
  const currentRound = `${code}:${state.round}`;
  if (betDraftRound !== currentRound) {
    betDraftRound = currentRound;
    selectedBetPreset = 'min';
    elements.betAmount.value = String(minimum);
  }
  elements.betForm.hidden = !state.canBet;
  elements.betStatus.hidden = !!state.canBet;
  elements.betStatus.textContent = self?.status === 'ready'
    ? `已下注 ${chips(self.wager)} 筹码，等待其他玩家完成下注…`
    : self?.status === 'eliminated' ? '筹码已用完，本局只能旁观。'
      : '本局旁观，从下一局开始下注。';
  for (const button of elements.betPresets.querySelectorAll('button')) {
    const amount = betPresetAmount(button.dataset.bet, bankroll, minimum);
    const valid = Number.isSafeInteger(amount) && amount >= minimum && amount <= bankroll;
    button.dataset.amount = valid ? String(amount) : '';
    button.querySelector('strong').textContent = chips(amount);
    const label = button.querySelector('span').textContent;
    button.title = valid ? `${label}：${chips(amount)} 筹码` : `${label}低于最低下注额 ${chips(minimum)} 筹码`;
    button.setAttribute('aria-label', button.title);
    button.disabled = pending || !state.canBet || !valid;
    button.classList.toggle('active', selectedBetPreset === button.dataset.bet && state.canBet && valid);
  }
}

function render() {
  if (!state) return;
  const phase = state.phase;
  const players = Array.isArray(state.players) ? state.players : [];
  const self = players.find((player) => player.id === state.selfId) || null;
  const canReviewFinalHand = phase === 'finished' && !!self?.roundResult && (self?.cards?.length || 0) >= 2 && (state.dealer?.cards?.length || 0) >= 2;
  const reviewingFinalHand = canReviewFinalHand && !showFinalSummary;
  const showingHand = ['dealing', 'playing', 'dealer-turn', 'results'].includes(phase) || reviewingFinalHand;
  const goalLabel = state.matchMode === 'endless' ? '10 分钟无尽模式' : `目标 ${chips(state.targetBankroll || 10000)}`;

  elements.setupView.hidden = true;
  elements.gameView.hidden = false;
  elements.roomCode.textContent = state.code || code;
  elements.roundLabel.textContent = phase === 'lobby' ? '等待开局' : reviewingFinalHand ? `第 ${state.round} 局 · 最终结算` : phase === 'finished' ? '本场结束' : `第 ${state.round || 1} 局${phase === 'betting' ? ' · 下注' : phase === 'dealing' ? ' · 发牌' : phase === 'dealer-turn' ? ' · 庄家回合' : phase === 'results' ? ' · 结算' : ''}`;
  elements.matchGoalLabel.hidden = phase === 'lobby';
  elements.matchGoalLabel.textContent = goalLabel;
  elements.playerCountLabel.textContent = `${players.length} / 6 人`;
  elements.quickGoalRule.textContent = state.matchMode === 'endless'
    ? '无尽模式整场 10 分钟；多人只剩一人有筹码时提前获胜。'
    : `最先达到 ${chips(state.targetBankroll || 10000)} 筹码，赢下本场挑战。`;
  renderTimer();

  elements.lobbyStage.hidden = phase !== 'lobby';
  elements.bettingStage.hidden = phase !== 'betting';
  elements.playStage.hidden = !showingHand;
  elements.finishedStage.hidden = phase !== 'finished' || reviewingFinalHand;

  if (phase === 'lobby') {
    elements.startButton.hidden = !state.canStart;
    elements.hostHint.hidden = !!state.canStart;
  }

  if (phase === 'betting') renderBetting(self);

  let animating = false;
  if (showingHand) {
    const dealer = state.dealer || {};
    animating = syncHandVisual(dealer, self);
    elements.dealerTotal.textContent = animating || dealer.total == null ? '? 点' : `${dealer.total} 点`;
    elements.selfTotal.textContent = animating || self?.total == null ? '? 点' : `${self.total} 点`;
    const settling = animating && (phase === 'results' || reviewingFinalHand);
    elements.selfBankroll.textContent = chips(settling ? self?.bankroll - (self?.roundResult?.delta || 0) : self?.bankroll);
    elements.selfWager.textContent = chips(self?.wager);

    const result = self?.roundResult;
    elements.selfOutcome.textContent = animating ? '' : phase === 'dealer-turn'
      ? (self?.status === 'bust' ? '爆牌了，等待庄家翻牌' : '')
      : roundResultText(self, dealer) || (self?.status === 'bust' ? '爆牌了，等待本局结算' : '');
    elements.selfOutcome.className = `self-outcome ${result?.outcome === 'win' ? 'win' : result?.outcome === 'lose' ? 'lose' : result?.outcome === 'push' ? 'push' : ''}`;
    const ready = readySummary(players);
    elements.centerMessage.textContent = phase === 'dealer-turn'
      ? (animating ? '你的手牌正在落定，庄家稍后翻牌…' : '庄家即将翻开暗牌…')
      : animating || phase === 'dealing'
        ? phase === 'results' || reviewingFinalHand ? '庄家正在揭牌与补牌…' : '正在逐张发牌…'
        : reviewingFinalHand ? '最终局 · 请查看双方手牌与结算原因'
          : phase === 'results' ? `本局已结算 · ${ready.ready} / ${ready.total} 位在线玩家已准备`
            : self?.status === 'spectating' ? '下局起加入'
              : self?.status === 'eliminated' ? '筹码已用完，本局旁观'
                : self?.status === 'bust' ? '超过 21 点'
                  : state.canHit || state.canStand ? '轮到你决定' : '等待其他玩家';

    elements.hitButton.hidden = phase !== 'playing' || !state.canHit;
    elements.standButton.hidden = phase !== 'playing' || !state.canStand;
    elements.doubleButton.hidden = phase !== 'playing' || !state.canDouble;
    elements.nextButton.hidden = animating || (!reviewingFinalHand && (phase !== 'results' || !state.canNext));
    elements.nextButton.innerHTML = reviewingFinalHand ? '查看最终排名 <span aria-hidden="true">→</span>' : '准备下一局 <span aria-hidden="true">→</span>';
    const hasMove = state.canHit || state.canStand || state.canDouble;
    elements.waitingText.hidden = !animating && phase !== 'dealing' && (reviewingFinalHand || (phase === 'results' ? !!state.canNext : hasMove));
    elements.waitingText.textContent = phase === 'dealer-turn'
      ? (animating ? '你的手牌正在落定，庄家随后翻牌…' : '庄家稍后翻开暗牌…')
      : animating && (phase === 'results' || reviewingFinalHand) ? '庄家正在翻牌与补牌，请稍等…'
        : animating || phase === 'dealing' ? '正在发牌，请稍等…'
          : phase === 'results' ? `你已准备，等待其他在线玩家（${ready.ready} / ${ready.total}）…`
            : self?.status === 'spectating' ? '旁观中，下局起加入…'
              : self?.status === 'eliminated' ? '筹码已用完，等待本局结算…'
                : '等待其他玩家完成本局…';
  }

  renderPlayers(players, phase, animating && (phase === 'results' || reviewingFinalHand));

  if (phase === 'finished') {
    const winners = players.filter((player) => Array.isArray(state.winners) && state.winners.includes(player.id));
    elements.finishedTitle.textContent = winners.length === 0 ? '本桌无人获胜' : winners.length === 1 ? `${winners[0].name} 赢下牌桌！` : '并列冠军！';
    elements.finishedMessage.textContent = state.message || (winners.length ? `${goalLabel}，本场排名已结算。` : '全员筹码归零。');
    elements.finalRoundNote.hidden = !canReviewFinalHand;
    elements.finalRoundNote.textContent = canReviewFinalHand ? `最后一局：${roundResultText(self, state.dealer)}` : '';
    elements.reviewFinalHand.hidden = !canReviewFinalHand;
    elements.restartButton.hidden = !state.canStart;
    elements.restartMatchSettings.hidden = !state.canStart;
    elements.finishedHint.hidden = !!state.canStart;
    const matchKey = `${state.code}:${state.matchStartedAt || state.round}`;
    if (restartSettingsForMatch !== matchKey) {
      restartSettingsForMatch = matchKey;
      const mode = state.matchMode === 'endless' ? 'endless' : 'target';
      elements.restartMatchSettings.querySelector(`input[value="${mode}"]`).checked = true;
      elements.restartTarget.value = String(state.targetBankroll || 10000);
      updateModeControls('restart');
    }
  }

  [elements.betButton, elements.hitButton, elements.standButton, elements.doubleButton, elements.startButton, elements.nextButton, elements.reviewFinalHand, elements.restartButton].forEach((button) => { button.disabled = pending || (animating && [elements.hitButton, elements.standButton, elements.doubleButton, elements.nextButton].includes(button)); });
}

function updateState(newState) {
  if (!newState || !newState.phase) return;
  if (newState.phase !== 'finished' || newState.code !== state?.code || newState.round !== state?.round) showFinalSummary = false;
  state = newState;
  render();
}

async function submitAction(action, { amount, mode, targetBankroll, throwOnError = false } = {}) {
  if (pending || !code || !token) return;
  if (handVisual.timer && ['hit', 'stand', 'double', 'next'].includes(action)) {
    if (throwOnError) throw new Error('发牌动画尚未结束');
    return;
  }
  pending = true;
  render();
  try {
    const response = await request(`/api/rooms/${encodeURIComponent(code)}/action`, {
      method: 'POST', body: JSON.stringify({ token, action, ...(amount === undefined ? {} : { amount }), ...(mode === undefined ? {} : { mode }), ...(targetBankroll === undefined ? {} : { targetBankroll }) }),
    });
    if (action === 'leave') {
      leaveRoomUI();
      return { left: true };
    }
    updateState(response);
    return state;
  } catch (error) {
    showToast(error.message || '操作失败，请重试');
    if (throwOnError) throw error;
  } finally {
    pending = false;
    render();
  }
}

function matchSettings(prefix) {
  const container = prefix === 'restart' ? elements.restartMatchSettings : elements.lobbyMatchSettings;
  const targetInput = prefix === 'restart' ? elements.restartTarget : elements.lobbyTarget;
  const mode = container.querySelector('input[type="radio"]:checked')?.value || 'target';
  return { mode, targetInput };
}

function updateModeControls(prefix) {
  const { mode, targetInput } = matchSettings(prefix);
  const wrap = prefix === 'restart' ? elements.restartTargetWrap : elements.lobbyTargetWrap;
  wrap.hidden = mode !== 'target';
  targetInput.disabled = mode !== 'target';
}

function startMatch(prefix) {
  const { mode, targetInput } = matchSettings(prefix);
  const targetBankroll = Number(targetInput.value);
  if (mode === 'target' && (!Number.isSafeInteger(targetBankroll) || targetBankroll < 1001 || targetBankroll > 1000000)) {
    showToast('目标筹码须为 1,001 到 1,000,000 之间的整数');
    targetInput.focus();
    return;
  }
  submitAction('start', { mode, targetBankroll: mode === 'target' ? targetBankroll : undefined });
}

for (const prefix of ['lobby', 'restart']) {
  const container = prefix === 'restart' ? elements.restartMatchSettings : elements.lobbyMatchSettings;
  container.addEventListener('change', () => updateModeControls(prefix));
  updateModeControls(prefix);
}

elements.createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = elements.createName.value.trim();
  if (!name) return;
  const button = elements.createForm.querySelector('button');
  button.disabled = true;
  try {
    localStorage.setItem('blackjack:name', name);
    const result = await request('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) });
    setRoom(result.code, result.token);
  } catch (error) { showToast(error.message || '开桌失败，请重试'); }
  finally { button.disabled = false; }
});

elements.joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = elements.joinName.value.trim();
  const roomCode = elements.joinCode.value.trim().toUpperCase();
  if (!name || !roomCode) return;
  const button = elements.joinForm.querySelector('button');
  button.disabled = true;
  try {
    localStorage.setItem('blackjack:name', name);
    const result = await request('/api/rooms/join', { method: 'POST', body: JSON.stringify({ code: roomCode, name }) });
    setRoom(result.code, result.token);
  } catch (error) {
    if (/不存在|已过期/i.test(error.message)) setInviteLanding(roomCode, true);
    showToast(error.message || '加入失败，请检查房间码');
  }
  finally { button.disabled = false; }
});

function inviteUrl() {
  const localHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const origin = location.hostname === 'game.5iyeji.xyz'
    ? 'https://game.5iyeji.xyz'
    : localHost && state?.networkUrl ? state.networkUrl : location.origin;
  return `${origin}${location.pathname}?room=${encodeURIComponent(code)}`;
}

async function copyText(value, message) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(value);
    showToast(message);
  } catch {
    window.prompt('复制并发给朋友', value);
  }
}

function shareContent({ title, text, url, copyValue, copiedMessage }) {
  // Call Web Share directly from the click handler so mobile browsers retain user activation.
  if (navigator.share) {
    try {
      Promise.resolve(navigator.share({ title, text, url })).catch((error) => {
        if (error?.name !== 'AbortError') copyText(copyValue, copiedMessage);
      });
      return;
    } catch { /* Use the clipboard fallback. */ }
  }
  copyText(copyValue, copiedMessage);
}

function shareInvite() {
  if (!code) return;
  const url = inviteUrl();
  const isInProgress = state && !['lobby', 'results', 'finished'].includes(state.phase);
  shareContent({
    title: `来玩 21 点 · 房间 ${code}`,
    text: `我开了 21 点牌桌，房间码 ${code}。${isInProgress ? '现在加入可旁观，下一局起参与。' : '输入昵称就能一起玩。'}`,
    url,
    copyValue: url,
    copiedMessage: '邀请链接已复制，发给朋友即可加入',
  });
}

function shareResult() {
  if (!state || state.phase !== 'finished') return;
  const players = [...state.players].sort((a, b) => Number(b.bankroll || 0) - Number(a.bankroll || 0));
  const self = players.find((player) => player.id === state.selfId);
  const rank = self ? players.findIndex((player) => player.bankroll === self.bankroll) + 1 : null;
  const champion = players.filter((player) => state.winners?.includes(player.id)).map((player) => player.name).join('、');
  const myResult = self ? `我拿到 ${chips(self.bankroll)} 筹码，排名第 ${rank}。` : '';
  const championText = champion ? `本桌冠军：${champion}。` : '本桌无人获胜。';
  const url = inviteUrl();
  const text = `21 点朋友牌桌战绩：${myResult}${championText}来和我同桌再战！`;
  shareContent({
    title: '21 点 · 本桌战绩', text, url,
    copyValue: `${text}\n${url}`,
    copiedMessage: '战绩和牌桌链接已复制，可以发给朋友',
  });
}

elements.copyRoomCode.addEventListener('click', () => {
  if (code) copyText(code, `房间码 ${code} 已复制`);
});
elements.shareInvite.addEventListener('click', shareInvite);
elements.lobbyShareInvite.addEventListener('click', shareInvite);
elements.shareResult.addEventListener('click', shareResult);

elements.leaveButton.addEventListener('click', () => submitAction('leave'));
elements.startButton.addEventListener('click', () => startMatch('lobby'));
elements.betForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!state?.canBet) return;
  const amount = Number(elements.betAmount.value);
  const self = state.players.find((player) => player.id === state.selfId);
  const minimum = Math.min(Number(state.minimumBet || 50), Number(self?.bankroll || 0));
  if (!Number.isSafeInteger(amount) || amount < minimum || amount > Number(self?.bankroll || 0)) {
    showToast(`请输入 ${chips(minimum)} 到 ${chips(self?.bankroll)} 之间的整数下注额`);
    elements.betAmount.focus();
    return;
  }
  submitAction('bet', { amount });
});
elements.betPresets.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-bet]');
  if (!button || button.disabled || !state?.canBet) return;
  const amount = Number(button.dataset.amount);
  if (!Number.isSafeInteger(amount)) return;
  elements.betAmount.value = String(amount);
  selectedBetPreset = button.dataset.bet;
  const self = state.players.find((player) => player.id === state.selfId);
  renderBetting(self);
});
elements.betAmount.addEventListener('input', () => {
  selectedBetPreset = '';
  if (state?.phase !== 'betting') return;
  const self = state.players.find((player) => player.id === state.selfId);
  renderBetting(self);
});
elements.hitButton.addEventListener('click', () => submitAction('hit'));
elements.standButton.addEventListener('click', () => submitAction('stand'));
elements.doubleButton.addEventListener('click', () => submitAction('double'));
elements.nextButton.addEventListener('click', () => {
  if (state?.phase === 'finished') {
    showFinalSummary = true;
    render();
  } else submitAction('next');
});
elements.reviewFinalHand.addEventListener('click', () => {
  showFinalSummary = false;
  render();
});
elements.restartButton.addEventListener('click', () => startMatch('restart'));
for (const button of [elements.openRulesSetup, elements.openRulesInvite, elements.openRulesGame]) {
  button.addEventListener('click', () => elements.rulesDialog.showModal());
}
elements.closeRules.addEventListener('click', () => elements.rulesDialog.close());
elements.rulesDialog.addEventListener('click', (event) => {
  if (event.target === elements.rulesDialog) elements.rulesDialog.close();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshState(); });
prefersReducedMotion.addEventListener('change', () => render());
setInterval(renderTimer, 1000);

(function restore() {
  const name = localStorage.getItem('blackjack:name') || '';
  elements.createName.value = name;
  elements.joinName.value = name;
  const invitedRoom = (new URL(location.href).searchParams.get('room') || '').trim().toUpperCase();
  const requestedRoom = invitedRoom || (localStorage.getItem('blackjack:lastRoom') || '').toUpperCase();
  if (!requestedRoom) return;
  if (invitedRoom) setInviteLanding(invitedRoom);
  else elements.joinCode.value = requestedRoom;
  let sessions = {};
  try { sessions = JSON.parse(localStorage.getItem('blackjack:sessions') || '{}'); } catch { /* Ignore invalid storage. */ }
  if (sessions[requestedRoom]) setRoom(requestedRoom, sessions[requestedRoom]);
})();

// Browsers that support WebMCP can use the same game actions as the visible controls.
(async function registerGameTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const tools = [
    {
      name: 'blackjack_get_state', title: '查看 21 点牌桌',
      description: '读取当前房间、自己的手牌、玩家筹码、下注额和可执行操作。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        if (!code) throw new Error('尚未进入房间');
        await refreshState();
        return state;
      },
    },
    {
      name: 'blackjack_create_room', title: '创建 21 点房间',
      description: '用指定昵称创建私人牌桌，并在页面中打开房间。',
      inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 16 } }, required: ['name'], additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        if (code) throw new Error('请先退出当前房间');
        const name = String(input?.name || '').trim();
        if (!name || name.length > 16) throw new Error('昵称需要 1–16 个字符');
        const result = await request('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) });
        localStorage.setItem('blackjack:name', name);
        setRoom(result.code, result.token);
        return { code: result.code, playerCount: 1 };
      },
    },
    {
      name: 'blackjack_join_room', title: '加入 21 点房间',
      description: '用房间码和昵称加入朋友的私人牌桌。',
      inputSchema: { type: 'object', properties: { code: { type: 'string', minLength: 6, maxLength: 6 }, name: { type: 'string', minLength: 1, maxLength: 16 } }, required: ['code', 'name'], additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        if (code) throw new Error('请先退出当前房间');
        const roomCode = String(input?.code || '').trim().toUpperCase();
        const name = String(input?.name || '').trim();
        if (!/^[A-Z2-9]{6}$/.test(roomCode) || !name || name.length > 16) throw new Error('请填写有效房间码和昵称');
        const result = await request('/api/rooms/join', { method: 'POST', body: JSON.stringify({ code: roomCode, name }) });
        localStorage.setItem('blackjack:name', name);
        setRoom(result.code, result.token);
        return { code: result.code, joined: true };
      },
    },
    {
      name: 'blackjack_game_action', title: '操作 21 点牌桌',
      description: '执行开始、下注、要牌、停牌、加倍（立即补一张并停牌）、准备下一局或退出房间。开始时可选模式和目标；下注时须提供整数 amount。',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'bet', 'hit', 'stand', 'double', 'next', 'leave'] }, amount: { type: 'integer', minimum: 1, description: '下注筹码数；仅在 action 为 bet 时填写' }, mode: { type: 'string', enum: ['target', 'endless'], description: '开始游戏时填写，默认 target' }, targetBankroll: { type: 'integer', minimum: 1001, maximum: 1000000, description: '目标模式的获胜筹码数；默认 10000' } }, required: ['action'], additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        if (!code) throw new Error('尚未进入房间');
        if (!['start', 'bet', 'hit', 'stand', 'double', 'next', 'leave'].includes(input?.action)) throw new Error('无效操作');
        if (input.action === 'bet' && !Number.isSafeInteger(input.amount)) throw new Error('下注时请提供整数 amount');
        if (input.action === 'start' && input.mode !== undefined && !['target', 'endless'].includes(input.mode)) throw new Error('无效游戏模式');
        if (input.action === 'start' && input.targetBankroll !== undefined && (!Number.isSafeInteger(input.targetBankroll) || input.targetBankroll < 1001 || input.targetBankroll > 1000000)) throw new Error('目标筹码须为 1,001 到 1,000,000');
        if (pending) throw new Error('上一步操作尚未完成');
        return await submitAction(input.action, { amount: input.action === 'bet' ? input.amount : undefined, mode: input.action === 'start' ? input.mode : undefined, targetBankroll: input.action === 'start' ? input.targetBankroll : undefined, throwOnError: true });
      },
    },
  ];
  for (const tool of tools) {
    try { await Promise.resolve(context.registerTool(tool)); } catch { /* Standard not available in this browser. */ }
  }
})();
