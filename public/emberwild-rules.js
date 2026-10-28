(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmberwildRules = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WIDTH = 960;
  const HEIGHT = 600;
  const OFFLINE_CAP_MS = 4 * 60 * 60 * 1000;
  const RESOURCES = ['gold', 'wood', 'ore'];
  const REGIONS = [
    { id: 'grove', name: '萤火林地', subtitle: '重燃第一束营火', color: '#7adea5', boss: '荆棘巨兽', difficulty: 1, reward: { gold: 65, wood: 45, ore: 16 } },
    { id: 'quarry', name: '赤岩矿场', subtitle: '深入被遗忘的矿脉', color: '#f0b86b', boss: '熔岩守卫', difficulty: 1.45, reward: { gold: 95, wood: 28, ore: 58 } },
    { id: 'rift', name: '灰烬裂隙', subtitle: '终结荒野的黑潮', color: '#c3a0ff', boss: '裂隙之王', difficulty: 2.05, reward: { gold: 155, wood: 60, ore: 65 } },
  ];
  const BUILDINGS = [
    { id: 'hearth', name: '营火', description: '提高生命与仓库容量，营地产出金币', maxLevel: 8, cost: { gold: 40, wood: 26, ore: 8 } },
    { id: 'forge', name: '锻造坊', description: '永久提高攻击力', maxLevel: 8, cost: { gold: 45, wood: 18, ore: 15 } },
    { id: 'sawmill', name: '伐木场', description: '持续产出木材，离线也能积累', maxLevel: 8, cost: { gold: 35, wood: 24, ore: 6 } },
    { id: 'mine', name: '采矿场', description: '持续产出矿石，离线也能积累', maxLevel: 8, cost: { gold: 38, wood: 28, ore: 8 } },
  ];
  const PERKS = [
    { id: 'power', name: '烈焰箭', description: '弹丸伤害 +30%', icon: '✦', maxLevel: 5 },
    { id: 'haste', name: '疾风弦', description: '攻击速度 +22%', icon: '»', maxLevel: 5 },
    { id: 'vitality', name: '坚韧之心', description: '生命上限 +30，立即回复 45', icon: '♥', maxLevel: 5 },
    { id: 'multishot', name: '分裂火花', description: '额外发射 1 枚散射弹丸', icon: '⋔', maxLevel: 2 },
    { id: 'swift', name: '追风靴', description: '移速 +15%，冲刺冷却缩短', icon: '↗', maxLevel: 3 },
    { id: 'nova', name: '余烬风暴', description: '爆发伤害 +55%，范围 +15%', icon: '☀', maxLevel: 4 },
    { id: 'pierce', name: '穿透之矢', description: '弹丸额外穿透 1 个敌人', icon: '➶', maxLevel: 3 },
    { id: 'regen', name: '野地祝福', description: '每秒回复 1.6 生命', icon: '❋', maxLevel: 3 },
  ];
  const QUESTS = [
    { id: 'first-run', name: '第一次远征', description: '击败敌人，或坚持 30 秒后完成一次远征', key: 'completedRuns', target: 1, reward: { gold: 40, wood: 25, ore: 15 } },
    { id: 'first-victory', name: '林地守护者', description: '击败萤火林地首领', key: 'victories', target: 1, reward: { gold: 65, wood: 35, ore: 25 } },
    { id: 'hunter', name: '荒野猎人', description: '累计击败 60 个敌人', key: 'totalKills', target: 60, reward: { gold: 70, wood: 30, ore: 30 } },
    { id: 'builder', name: '营地初成', description: '建筑总等级达到 8', key: 'buildingLevels', target: 8, reward: { gold: 80, wood: 40, ore: 35 } },
    { id: 'rift-keeper', name: '余烬不灭', description: '击败灰烬裂隙首领', key: 'clearedRegions', target: 3, reward: { gold: 200, wood: 100, ore: 100 } },
  ];

  // UI contract: stepRun mutates a JSON-serializable run and returns transient
  // {type:'kill',enemyType,x,y}, {type:'hurt',amount}, {type:'wave',wave},
  // {type:'level-up',level,choices}, {type:'boss-warning',x,y}, dash/nova and
  // victory/defeat events. Loot and XP enter the run immediately on a kill;
  // finishRun transfers them exactly once to the persistent profile.

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const integer = (value, fallback, min = 0, max = 1000000000) => Math.floor(clamp(finite(value, fallback), min, max));
  const timeValue = (now) => Math.max(0, finite(now, 0));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const copy = (value) => JSON.parse(JSON.stringify(value));

  function createProfile(now = 0) {
    const at = timeValue(now);
    return { version: 1, createdAt: at, updatedAt: at, productionAt: at, level: 1, xp: 0,
      resources: { gold: 100, wood: 65, ore: 30 }, buildings: { hearth: 1, forge: 1, sawmill: 1, mine: 1 },
      productionRemainder: { gold: 0, wood: 0, ore: 0 }, highestRegion: 0, clearedRegions: 0,
      completedRuns: 0, victories: 0, totalKills: 0, questClaims: [], settledRuns: [], revision: 0 };
  }

  function restoreProfile(raw, now = 0) {
    const profile = createProfile(now);
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return profile;
    profile.createdAt = clamp(finite(raw.createdAt, profile.createdAt), 0, timeValue(now));
    profile.productionAt = clamp(finite(raw.productionAt, timeValue(now)), 0, timeValue(now));
    for (const building of BUILDINGS) profile.buildings[building.id] = integer(raw.buildings?.[building.id], 1, 1, building.maxLevel);
    profile.level = integer(raw.level, 1, 1, 100);
    profile.xp = integer(raw.xp, 0, 0, profileXp(profile.level) - 1);
    const cap = stats(profile).cap;
    for (const id of RESOURCES) {
      profile.resources[id] = integer(raw.resources?.[id], 0, 0, cap);
      profile.productionRemainder[id] = clamp(finite(raw.productionRemainder?.[id], 0), 0, 0.999999);
    }
    for (const key of ['completedRuns', 'victories', 'totalKills', 'revision']) profile[key] = integer(raw[key], 0);
    profile.highestRegion = integer(raw.highestRegion, 0, 0, REGIONS.length - 1);
    profile.clearedRegions = integer(raw.clearedRegions, 0, 0, REGIONS.length);
    profile.questClaims = QUESTS.filter((q) => Array.isArray(raw.questClaims) && raw.questClaims.includes(q.id)).map((q) => q.id);
    profile.settledRuns = Array.isArray(raw.settledRuns) ? raw.settledRuns.filter((id) => typeof id === 'string' && id.length < 120).slice(-40) : [];
    return profile;
  }

  function stats(profile) {
    const b = profile.buildings;
    return { maxHp: 120 + (b.hearth - 1) * 18 + (profile.level - 1) * 6,
      attack: 15 + (b.forge - 1) * 3.5 + (profile.level - 1) * 1.5,
      speed: 220, cap: 700 + b.hearth * 400,
      production: { gold: 24 * b.hearth, wood: 55 * b.sawmill, ore: 36 * b.mine }, nextXp: profileXp(profile.level) };
  }
  function profileXp(level) { return 70 + (level - 1) * 45; }
  function buildingCost(profile, id) {
    const building = BUILDINGS.find((b) => b.id === id);
    if (!building || profile.buildings[id] >= building.maxLevel) return null;
    return Object.fromEntries(RESOURCES.map((r) => [r, Math.ceil(building.cost[r] * Math.pow(1.52, profile.buildings[id] - 1))]));
  }
  function previewProduction(profile, now) {
    const elapsed = clamp(timeValue(now) - profile.productionAt, 0, OFFLINE_CAP_MS);
    const s = stats(profile);
    const resources = Object.fromEntries(RESOURCES.map((id) => [id,
      Math.min(Math.max(0, s.cap - profile.resources[id]), Math.floor(elapsed / 3600000 * s.production[id] + profile.productionRemainder[id]))]));
    return { resources, elapsed, capMs: OFFLINE_CAP_MS };
  }
  function claimProduction(profile, now) {
    const preview = previewProduction(profile, now);
    const rate = stats(profile).production;
    for (const id of RESOURCES) {
      const amount = preview.elapsed / 3600000 * rate[id] + profile.productionRemainder[id];
      profile.productionRemainder[id] = amount - Math.floor(amount);
      profile.resources[id] += preview.resources[id];
    }
    profile.productionAt = Math.max(profile.productionAt, timeValue(now));
    profile.updatedAt = timeValue(now);
    profile.revision++;
    return { ok: true, ...preview };
  }
  function upgradeBuilding(profile, id, now) {
    const building = BUILDINGS.find((b) => b.id === id);
    if (!building) return { ok: false, reason: 'unknown-building' };
    const cost = buildingCost(profile, id);
    if (!cost) return { ok: false, reason: 'max-level' };
    if (RESOURCES.some((r) => profile.resources[r] < cost[r])) return { ok: false, reason: 'insufficient-resources', cost };
    // Settle the old production rate before raising a building's rate.
    claimProduction(profile, now);
    for (const resource of RESOURCES) profile.resources[resource] -= cost[resource];
    profile.buildings[id]++;
    profile.revision++;
    return { ok: true, id, level: profile.buildings[id], cost };
  }
  function addResources(profile, rewards) {
    const added = {};
    const cap = stats(profile).cap;
    for (const id of RESOURCES) {
      added[id] = Math.min(cap - profile.resources[id], Math.max(0, Math.floor(rewards[id] || 0)));
      profile.resources[id] += added[id];
    }
    return added;
  }
  function getQuests(profile) {
    return QUESTS.map((q) => {
      const progress = q.key === 'buildingLevels' ? Object.values(profile.buildings).reduce((a, b) => a + b, 0) : profile[q.key];
      return { ...copy(q), progress: Math.min(q.target, progress), claimed: profile.questClaims.includes(q.id), ready: progress >= q.target && !profile.questClaims.includes(q.id) };
    });
  }
  function claimQuest(profile, id, now) {
    const quest = getQuests(profile).find((q) => q.id === id);
    if (!quest || !quest.ready) return { ok: false, reason: 'quest-unavailable' };
    const resources = addResources(profile, quest.reward);
    profile.questClaims.push(id);
    profile.updatedAt = timeValue(now);
    profile.revision++;
    return { ok: true, resources };
  }

  function random(run) {
    let n = run.rng += 0x6D2B79F5;
    n = Math.imul(n ^ n >>> 15, n | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    run.rng >>>= 0;
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  }
  function startRun(profile, regionId, seed = 1) {
    const regionIndex = typeof regionId === 'number' ? regionId : REGIONS.findIndex((r) => r.id === regionId);
    if (!REGIONS[regionIndex] || regionIndex > profile.highestRegion) return null;
    const s = stats(profile);
    const seedNumber = finite(seed, 1) >>> 0;
    return { id: `${profile.createdAt}-${profile.revision}-${seedNumber}`, seed: seedNumber, rng: seedNumber,
      region: REGIONS[regionIndex].id, regionIndex, state: 'active', time: 0, wave: 1, waveTime: 0,
      spawned: 0, spawnTimer: 0.8, level: 1, xp: 0, nextXp: 12, entityId: 0,
      hero: { x: WIDTH / 2, y: HEIGHT / 2, hp: s.maxHp, maxHp: s.maxHp, attack: s.attack, speed: s.speed,
        radius: 16, directionX: 1, directionY: 0, invincible: 0, dashTime: 0, dashX: 0, dashY: 0 },
      enemies: [], projectiles: [], effects: [], pendingChoices: [], perkLevels: {},
      cooldowns: { dash: 0, nova: 0, shot: 0 }, loot: { gold: 0, wood: 0, ore: 0 },
      stats: { kills: 0, damageDealt: 0, damageTaken: 0, dashes: 0, novas: 0, bossKilled: false }, reported: false };
  }

  function restoreRun(raw, profile) {
    try {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length > 119
        || raw.reported || profile.settledRuns.includes(raw.id)
        || !['active', 'choice', 'victory', 'defeat', 'retreated'].includes(raw.state)) return null;
      const regionIndex = REGIONS.findIndex((r) => r.id === raw.region);
      if (regionIndex < 0 || regionIndex > profile.highestRegion || regionIndex !== raw.regionIndex) return null;
      const numeric = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
      const point = (p) => p && numeric(p.x, -100, WIDTH + 100) && numeric(p.y, -100, HEIGHT + 100);
      const whole = (n, min, max) => numeric(n, min, max) && Number.isInteger(n);
      if (!whole(raw.seed, 0, 4294967295) || !whole(raw.rng, 0, 4294967295)
        || !whole(raw.wave, 1, 4) || !numeric(raw.time, 0, 86400) || !numeric(raw.waveTime, 0, 86400)
        || !whole(raw.spawned, 0, 18) || !numeric(raw.spawnTimer, -1, 100)
        || !whole(raw.level, 1, 100) || !numeric(raw.xp, 0, 10000)
        || !numeric(raw.nextXp, 1, 10000) || !whole(raw.entityId, 0, 10000000)) return null;
      const h = raw.hero;
      if (!point(h) || !numeric(h.maxHp, 1, 10000) || !numeric(h.hp, 0, h.maxHp)
        || !numeric(h.attack, 1, 10000) || !numeric(h.speed, 1, 1000)
        || h.radius !== 16 || !numeric(h.directionX, -1, 1) || !numeric(h.directionY, -1, 1)
        || !numeric(h.invincible, 0, 1) || !numeric(h.dashTime, 0, 0.2)
        || !numeric(h.dashX, -1, 1) || !numeric(h.dashY, -1, 1)) return null;
      if (!raw.cooldowns || ['dash', 'nova', 'shot'].some((key) => !numeric(raw.cooldowns[key], 0, 30))) return null;
      if (!raw.loot || RESOURCES.some((key) => !whole(raw.loot[key], 0, 100000))) return null;
      if (!raw.stats || ['kills', 'dashes', 'novas'].some((key) => !whole(raw.stats[key], 0, 100000))
        || ['damageDealt', 'damageTaken'].some((key) => !numeric(raw.stats[key], 0, 100000000))
        || typeof raw.stats.bossKilled !== 'boolean') return null;
      if (!Array.isArray(raw.enemies) || raw.enemies.length > 90 || !Array.isArray(raw.projectiles)
        || raw.projectiles.length > 350 || !Array.isArray(raw.effects) || raw.effects.length > 250) return null;
      if (raw.enemies.some((e) => !point(e) || !whole(e.id, 1, 10000000)
        || !['crawler', 'brute', 'spitter', 'boss'].includes(e.type)
        || !numeric(e.maxHp, 1, 100000) || !numeric(e.hp, 0, e.maxHp)
        || !numeric(e.speed, 1, 1000) || !numeric(e.damage, 0, 10000)
        || !numeric(e.radius, 1, 100) || !numeric(e.xp, 0, 1000)
        || !['moving', 'windup', 'recover'].includes(e.phase) || !numeric(e.timer, -0.1, 10)
        || !numeric(e.attackX, 0, WIDTH) || !numeric(e.attackY, 0, HEIGHT)
        || !numeric(e.specialTimer, -1, 10) || !whole(e.pattern, 0, 100000)
        || !numeric(e.flash, 0, 1))) return null;
      if (raw.projectiles.some((p) => !point(p) || !whole(p.id, 1, 10000000)
        || !['hero', 'enemy'].includes(p.owner) || !numeric(p.vx, -1000, 1000)
        || !numeric(p.vy, -1000, 1000) || !numeric(p.damage, 0, 10000)
        || !numeric(p.radius, 1, 20) || !numeric(p.ttl, 0, 4) || !whole(p.pierce, 0, 3)
        || !Array.isArray(p.hitIds) || p.hitIds.length > 10 || p.hitIds.some((id) => !whole(id, 1, 10000000)))) return null;
      const effectKinds = ['spawn', 'dash', 'nova', 'hurt', 'defeat', 'warning', 'blast', 'boss-cast', 'heal'];
      if (raw.effects.some((e) => !point(e) || !whole(e.id, 1, 10000000) || !effectKinds.includes(e.kind)
        || !numeric(e.radius, 1, 500) || !numeric(e.ttl, 0, 5) || !numeric(e.maxTtl, 0.01, 5)
        || (e.kind === 'warning' && !numeric(e.damage, 0, 10000)))) return null;
      if (!raw.perkLevels || PERKS.some((p) => raw.perkLevels[p.id] !== undefined && !whole(raw.perkLevels[p.id], 0, p.maxLevel))) return null;
      if (!Array.isArray(raw.pendingChoices) || raw.pendingChoices.length > 3) return null;
      const choices = raw.pendingChoices.map((p) => PERKS.find((known) => known.id === p?.id));
      if (choices.some((p) => !p) || new Set(choices.map((p) => p.id)).size !== choices.length
        || (raw.state === 'choice' && !choices.length) || (raw.state !== 'choice' && choices.length)) return null;
      if ((raw.state === 'active' || raw.state === 'choice') && h.hp <= 0) return null;
      if (raw.state === 'victory' && !raw.stats.bossKilled) return null;
      const run = startRun(profile, regionIndex, raw.seed);
      for (const key of ['id', 'rng', 'state', 'time', 'wave', 'waveTime', 'spawned', 'spawnTimer', 'level', 'xp', 'nextXp', 'entityId']) run[key] = raw[key];
      const select = (object, keys) => Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, copy(object[key])]));
      for (const key of ['hero', 'cooldowns', 'loot', 'stats']) run[key] = select(raw[key], Object.keys(run[key]));
      run.enemies = raw.enemies.map((e) => select(e, ['id', 'type', 'x', 'y', 'hp', 'maxHp', 'speed', 'damage', 'radius', 'xp', 'phase', 'timer', 'attackX', 'attackY', 'specialTimer', 'pattern', 'flash']));
      run.projectiles = raw.projectiles.map((p) => select(p, ['id', 'owner', 'x', 'y', 'vx', 'vy', 'damage', 'radius', 'ttl', 'pierce', 'hitIds']));
      run.effects = raw.effects.map((e) => select(e, ['id', 'kind', 'x', 'y', 'radius', 'ttl', 'maxTtl', 'damage', 'enemyType']));
      run.perkLevels = Object.fromEntries(PERKS.filter((p) => raw.perkLevels[p.id]).map((p) => [p.id, raw.perkLevels[p.id]]));
      run.pendingChoices = copy(choices);
      return run;
    } catch (_) { return null; }
  }
  function effect(run, kind, x, y, radius, ttl, extra = {}) {
    run.effects.push({ id: ++run.entityId, kind, x, y, radius, ttl, maxTtl: ttl, ...extra });
  }
  function offerPerks(run, events) {
    const pool = PERKS.filter((p) => (run.perkLevels[p.id] || 0) < p.maxLevel).slice();
    const choices = [];
    while (choices.length < 3 && pool.length) choices.push(copy(pool.splice(Math.floor(random(run) * pool.length), 1)[0]));
    run.pendingChoices = choices;
    run.state = 'choice';
    events.push({ type: 'level-up', level: run.level, choices });
  }
  function choosePerk(run, id) {
    if (run.state !== 'choice' || !run.pendingChoices.some((p) => p.id === id)) return { ok: false, reason: 'invalid-choice' };
    run.perkLevels[id] = (run.perkLevels[id] || 0) + 1;
    if (id === 'vitality') { run.hero.maxHp += 30; run.hero.hp = Math.min(run.hero.maxHp, run.hero.hp + 45); }
    if (id === 'swift') run.hero.speed *= 1.15;
    if (id === 'nova') run.cooldowns.nova = Math.min(2, run.cooldowns.nova);
    run.pendingChoices = [];
    run.state = 'active';
    if (run.xp >= run.nextXp) {
      run.xp -= run.nextXp; run.level++; run.nextXp += 11; offerPerks(run, []);
    }
    return { ok: true, id };
  }
  function spawnEnemy(run, forcedType) {
    const side = Math.floor(random(run) * 4);
    const x = side === 0 ? 25 : side === 1 ? WIDTH - 25 : 35 + random(run) * (WIDTH - 70);
    const y = side === 2 ? 25 : side === 3 ? HEIGHT - 25 : 35 + random(run) * (HEIGHT - 70);
    const roll = random(run);
    const type = forcedType || (run.wave >= 2 && roll > 0.78 ? 'spitter' : run.wave >= 2 && roll < 0.26 ? 'brute' : 'crawler');
    const base = { crawler: [23, 72, 9, 15, 3], brute: [67, 47, 17, 22, 6], spitter: [30, 49, 10, 16, 4], boss: [620, 42, 24, 41, 30] }[type];
    const difficulty = REGIONS[run.regionIndex].difficulty;
    const hp = Math.round(base[0] * difficulty);
    const enemy = { id: ++run.entityId, type, x, y, hp, maxHp: hp, speed: base[1] * (1 + run.regionIndex * 0.08),
      damage: Math.round(base[2] * difficulty), radius: base[3], xp: base[4], phase: 'moving', timer: 0,
      attackX: 0, attackY: 0, specialTimer: type === 'boss' ? 2.7 : 1.5, pattern: 0, flash: 0 };
    run.enemies.push(enemy);
    effect(run, 'spawn', x, y, enemy.radius + 10, 0.65);
    return enemy;
  }
  function damageHero(run, amount, events) {
    const hero = run.hero;
    if (hero.invincible > 0 || run.state !== 'active') return;
    const actual = Math.min(hero.hp, amount);
    hero.hp = Math.max(0, hero.hp - amount);
    hero.invincible = 0.55;
    run.stats.damageTaken += actual;
    effect(run, 'hurt', hero.x, hero.y, 27, 0.3);
    events.push({ type: 'hurt', amount: actual });
    if (hero.hp <= 0) { run.state = 'defeat'; events.push({ type: 'defeat' }); }
  }
  function damageEnemy(run, enemy, amount, events) {
    if (enemy.hp <= 0) return;
    const actual = Math.min(enemy.hp, amount);
    enemy.hp = Math.max(0, enemy.hp - amount); enemy.flash = 0.09; run.stats.damageDealt += actual;
    if (enemy.hp > 0) return;
    run.stats.kills++;
    run.xp += enemy.xp;
    run.loot.gold += enemy.type === 'boss' ? 18 : 3;
    run.loot.wood += run.regionIndex === 0 ? 2 : 1;
    run.loot.ore += run.regionIndex === 1 ? 2 : 1;
    effect(run, 'defeat', enemy.x, enemy.y, enemy.radius + 10, 0.4, { enemyType: enemy.type });
    events.push({ type: 'kill', enemyType: enemy.type, x: enemy.x, y: enemy.y });
    if (enemy.type === 'boss') {
      run.stats.bossKilled = true; run.state = 'victory';
      run.pendingChoices = []; events.push({ type: 'victory' });
    }
  }
  function projectile(run, owner, x, y, angle, damage, speed, pierce = 0) {
    run.projectiles.push({ id: ++run.entityId, owner, x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      damage, radius: owner === 'hero' ? 5 : 8, ttl: 3, pierce, hitIds: [] });
  }
  function stepRun(run, input = {}, dtSeconds = 0) {
    const events = [];
    if (run.state !== 'active') return events;
    const dt = clamp(finite(dtSeconds, 0), 0, 0.05);
    if (!dt) return events;
    const hero = run.hero;
    run.time += dt; run.waveTime += dt;
    for (const key of Object.keys(run.cooldowns)) run.cooldowns[key] = Math.max(0, run.cooldowns[key] - dt);
    hero.invincible = Math.max(0, hero.invincible - dt);
    let ix = clamp(finite(input.x, 0), -1, 1), iy = clamp(finite(input.y, 0), -1, 1);
    const length = Math.hypot(ix, iy);
    if (length > 1) { ix /= length; iy /= length; }
    if (length > 0.05) { hero.directionX = ix / Math.hypot(ix, iy); hero.directionY = iy / Math.hypot(ix, iy); }
    if (input.dash && run.cooldowns.dash <= 0) {
      hero.dashTime = 0.18; hero.dashX = hero.directionX; hero.dashY = hero.directionY; hero.invincible = 0.42;
      run.cooldowns.dash = Math.max(1.9, 3.6 - (run.perkLevels.swift || 0) * 0.35);
      run.stats.dashes++; effect(run, 'dash', hero.x, hero.y, 25, 0.28); events.push({ type: 'dash' });
    }
    const isDashing = hero.dashTime > 0;
    hero.dashTime = Math.max(0, hero.dashTime - dt);
    hero.x = clamp(hero.x + (isDashing ? hero.dashX * 780 : ix * hero.speed) * dt, hero.radius, WIDTH - hero.radius);
    hero.y = clamp(hero.y + (isDashing ? hero.dashY * 780 : iy * hero.speed) * dt, hero.radius, HEIGHT - hero.radius);
    hero.hp = Math.min(hero.maxHp, hero.hp + (run.perkLevels.regen || 0) * 1.6 * dt);
    if (input.nova && run.cooldowns.nova <= 0) {
      const level = run.perkLevels.nova || 0;
      const radius = 155 * (1 + level * 0.15);
      const damage = hero.attack * 3.5 * (1 + level * 0.55);
      effect(run, 'nova', hero.x, hero.y, radius, 0.55);
      run.cooldowns.nova = 8; run.stats.novas++; events.push({ type: 'nova' });
      for (const enemy of run.enemies) if (distance(hero, enemy) < radius + enemy.radius) damageEnemy(run, enemy, damage, events);
    }
    if (run.state !== 'active') return events;
    run.spawnTimer -= dt;
    const waveCount = [0, 10, 14, 18, 1][run.wave];
    if (run.spawnTimer <= 0 && run.spawned < waveCount) {
      spawnEnemy(run, run.wave === 4 ? 'boss' : null); run.spawned++;
      run.spawnTimer = run.wave === 4 ? 99 : Math.max(0.65, 1.3 - run.wave * 0.1);
    }
    let target = null, nearest = Infinity;
    for (const enemy of run.enemies) {
      if (enemy.hp <= 0) continue;
      const d = distance(hero, enemy);
      if (d < nearest) { nearest = d; target = enemy; }
    }
    if (target && run.cooldowns.shot <= 0) {
      const angle = Math.atan2(target.y - hero.y, target.x - hero.x);
      const extra = run.perkLevels.multishot || 0;
      for (let i = 0; i <= extra; i++) projectile(run, 'hero', hero.x, hero.y, angle + (i - extra / 2) * 0.16,
        hero.attack * (1 + (run.perkLevels.power || 0) * 0.3), 590, run.perkLevels.pierce || 0);
      run.cooldowns.shot = 0.44 / (1 + (run.perkLevels.haste || 0) * 0.22);
    }
    for (const enemy of run.enemies) {
      if (enemy.hp <= 0) continue;
      enemy.flash = Math.max(0, enemy.flash - dt);
      const d = distance(hero, enemy);
      if (enemy.phase === 'windup') {
        enemy.timer -= dt;
        if (enemy.timer <= 0) {
          if (enemy.type === 'spitter') projectile(run, 'enemy', enemy.x, enemy.y, Math.atan2(enemy.attackY - enemy.y, enemy.attackX - enemy.x), enemy.damage, 190);
          else if (distance(hero, enemy) < enemy.radius + hero.radius + 24) damageHero(run, enemy.damage, events);
          enemy.phase = 'recover'; enemy.timer = enemy.type === 'boss' ? 0.65 : 0.8;
        }
      } else if (enemy.phase === 'recover') {
        enemy.timer -= dt; if (enemy.timer <= 0) enemy.phase = 'moving';
      } else if (d < (enemy.type === 'spitter' ? 300 : enemy.radius + hero.radius + 14)) {
        enemy.phase = 'windup'; enemy.timer = enemy.type === 'spitter' ? 0.85 : 0.65;
        enemy.attackX = hero.x; enemy.attackY = hero.y;
      } else if (d > 0) {
        enemy.x += (hero.x - enemy.x) / d * enemy.speed * dt;
        enemy.y += (hero.y - enemy.y) / d * enemy.speed * dt;
      }
      if (enemy.type === 'boss') {
        enemy.specialTimer -= dt;
        if (enemy.specialTimer <= 0) {
          enemy.specialTimer = 3.2; enemy.pattern++;
          if (enemy.pattern % 2) {
            effect(run, 'warning', hero.x, hero.y, 74, 1.05, { damage: enemy.damage });
            events.push({ type: 'boss-warning', x: hero.x, y: hero.y });
          } else {
            const angle = Math.atan2(hero.y - enemy.y, hero.x - enemy.x);
            for (let j = 0; j < 8; j++) projectile(run, 'enemy', enemy.x, enemy.y, angle + j * Math.PI / 4, enemy.damage * 0.7, 145);
            effect(run, 'boss-cast', enemy.x, enemy.y, 60, 0.5);
          }
        }
      }
    }
    for (const p of run.projectiles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.ttl -= dt;
      if (p.owner === 'hero') {
        for (const enemy of run.enemies) {
          if (p.ttl <= 0 || enemy.hp <= 0 || p.hitIds.includes(enemy.id)) continue;
          if (distance(p, enemy) < p.radius + enemy.radius) {
            damageEnemy(run, enemy, p.damage, events); p.hitIds.push(enemy.id);
            if (p.pierce <= 0) p.ttl = 0; else p.pierce--;
          }
        }
      } else if (distance(p, hero) < p.radius + hero.radius) { damageHero(run, p.damage, events); p.ttl = 0; }
    }
    run.projectiles = run.projectiles.filter((p) => p.ttl > 0 && p.x > -40 && p.x < WIDTH + 40 && p.y > -40 && p.y < HEIGHT + 40);
    // Iterate a snapshot: an expiring warning can safely create a fresh blast effect.
    for (const e of run.effects.slice()) {
      e.ttl -= dt;
      if (e.kind === 'warning' && e.ttl <= 0) {
        effect(run, 'blast', e.x, e.y, e.radius, 0.45);
        if (distance(hero, e) < e.radius + hero.radius) damageHero(run, e.damage, events);
      }
    }
    run.effects = run.effects.filter((e) => e.ttl > 0);
    run.enemies = run.enemies.filter((enemy) => enemy.hp > 0);
    if (run.state !== 'active') return events;
    if (run.spawned >= waveCount && run.enemies.length === 0 && run.wave < 4) {
      run.wave++; run.waveTime = 0; run.spawned = 0; run.spawnTimer = 1.8;
      hero.hp = Math.min(hero.maxHp, hero.hp + hero.maxHp * 0.14);
      run.projectiles = run.projectiles.filter((p) => p.owner === 'hero');
      events.push({ type: 'wave', wave: run.wave }); effect(run, 'heal', hero.x, hero.y, 45, 0.8);
    }
    if (run.xp >= run.nextXp) { run.xp -= run.nextXp; run.level++; run.nextXp += 11; offerPerks(run, events); }
    return events;
  }
  function finishRun(profile, run, outcome, now) {
    if (!run || run.reported || profile.settledRuns.includes(run.id)) return { ok: false, reason: 'already-settled' };
    if (!['victory', 'defeat', 'retreated'].includes(outcome)) return { ok: false, reason: 'invalid-outcome' };
    if (outcome !== 'retreated' && (run.state !== outcome || (outcome === 'victory' && !run.stats.bossKilled))) return { ok: false, reason: 'run-unfinished' };
    const beforeLevel = profile.level, beforeRegion = profile.highestRegion;
    const rewards = { ...run.loot };
    if (outcome === 'victory') for (const id of RESOURCES) rewards[id] += REGIONS[run.regionIndex].reward[id];
    const resources = addResources(profile, rewards);
    const xp = Math.round(run.stats.kills * 2 + (outcome === 'victory' ? 50 + run.regionIndex * 20 : 0));
    profile.xp += xp;
    while (profile.level < 100 && profile.xp >= profileXp(profile.level)) { profile.xp -= profileXp(profile.level); profile.level++; }
    if (profile.level >= 100) profile.xp = Math.min(profile.xp, profileXp(100) - 1);
    if (run.stats.kills > 0 || run.time >= 30) profile.completedRuns++;
    profile.totalKills += run.stats.kills;
    if (outcome === 'victory') {
      profile.victories++; profile.highestRegion = Math.max(profile.highestRegion, Math.min(REGIONS.length - 1, run.regionIndex + 1));
      profile.clearedRegions = Math.max(profile.clearedRegions, run.regionIndex + 1);
    }
    profile.updatedAt = timeValue(now); profile.revision++;
    profile.settledRuns.push(run.id); profile.settledRuns = profile.settledRuns.slice(-40);
    run.reported = true; run.state = outcome;
    return { ok: true, outcome, resources, xp, level: profile.level, levelsGained: profile.level - beforeLevel,
      unlockedRegion: profile.highestRegion > beforeRegion ? REGIONS[profile.highestRegion].id : null,
      kills: run.stats.kills, seconds: run.time, quests: getQuests(profile).filter((q) => q.ready) };
  }
  return { WIDTH, HEIGHT, OFFLINE_CAP_MS, REGIONS, BUILDINGS, PERKS, QUESTS, createProfile, restoreProfile,
    validateProfile: restoreProfile, stats, profileXp, buildingCost, previewProduction, claimProduction,
    upgradeBuilding, getQuests, claimQuest, startRun, restoreRun, stepRun, choosePerk, finishRun };
}));
