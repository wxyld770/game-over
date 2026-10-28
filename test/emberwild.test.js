const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/emberwild-rules.js');

function make() {
  const profile = R.createProfile(1000);
  return { profile, run: R.startRun(profile, 'grove', 123) };
}

function pick(run) {
  const order = ['multishot', 'power', 'haste', 'pierce', 'regen', 'vitality', 'nova', 'swift'];
  const choices = run.pendingChoices.slice().sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  assert.equal(R.choosePerk(run, choices[0].id).ok, true);
}

function play(run, seconds = 125) {
  for (let frame = 0; frame < seconds * 20 + 100; frame++) {
    if (run.state === 'choice') { pick(run); continue; }
    if (run.state !== 'active' || run.time >= seconds) return;
    // A continuous oval is a simple movement strategy, with no health cheats,
    // building upgrades, aiming, teleportation, or foreknowledge of the RNG.
    const a = run.time * 0.75;
    const dx = 480 + Math.cos(a) * 290 - run.hero.x;
    const dy = 300 + Math.sin(a) * 180 - run.hero.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    R.stepRun(run, { x: dx / d, y: dy / d,
      nova: run.enemies.some((e) => Math.hypot(e.x - run.hero.x, e.y - run.hero.y) < 145) }, 0.05);
  }
}

test('新营地可升级但不能买满所有建筑；区域逐个解锁', () => {
  const { profile } = make();
  assert.ok(R.startRun(profile, 'grove', 1));
  assert.equal(R.startRun(profile, 'rift', 1), null);
  assert.equal(R.startRun(profile, 'bogus', 1), null);
  const before = R.stats(profile);
  assert.equal(R.upgradeBuilding(profile, 'forge', 1000).ok, true);
  assert.ok(R.stats(profile).attack > before.attack);
  assert.equal(R.upgradeBuilding(profile, '__proto__', 1000).ok, false);
  for (let i = 0; i < 100; i++) R.upgradeBuilding(profile, 'forge', 1000);
  assert.ok(profile.buildings.forge < 8);
  assert.ok(Object.values(profile.resources).every((v) => v >= 0));
});

test('离线生产封顶四小时、领取不重复，升级不追溯增加过去产量', () => {
  const p = R.createProfile(0);
  assert.deepEqual(R.previewProduction(p, 24 * 3600000).resources, { gold: 96, wood: 220, ore: 144 });
  const initial = { ...p.resources };
  const reward = R.claimProduction(p, 24 * 3600000);
  assert.equal(reward.elapsed, R.OFFLINE_CAP_MS);
  assert.equal(p.resources.wood, initial.wood + 220);
  assert.deepEqual(R.claimProduction(p, 24 * 3600000).resources, { gold: 0, wood: 0, ore: 0 });
  assert.deepEqual(R.claimProduction(p, 0).resources, { gold: 0, wood: 0, ore: 0 });
  assert.equal(p.productionAt, 24 * 3600000, 'clock rollback cannot repeat a reward');
  const other = R.createProfile(0);
  const wood = other.resources.wood;
  const cost = R.buildingCost(other, 'sawmill');
  assert.equal(R.upgradeBuilding(other, 'sawmill', 3600000).ok, true);
  assert.equal(other.resources.wood, wood + 55 - cost.wood, 'past hour uses old level');
  assert.equal(R.previewProduction(other, 7200000).resources.wood, 110);
});

test('频繁领取保留小数产量，仓库封顶', () => {
  const p = R.createProfile(0);
  const initial = p.resources.wood;
  for (let i = 1; i <= 3600; i++) R.claimProduction(p, i * 1000);
  assert.ok(Math.abs(p.resources.wood - initial - 55) <= 1);
  p.resources.wood = R.stats(p).cap - 2;
  assert.equal(R.claimProduction(p, 7200000).resources.wood, 2);
  assert.equal(p.resources.wood, R.stats(p).cap);
});

test('持久化资料修复坏数字与外部字段，完成局可以安全续存', () => {
  const p = R.restoreProfile({ version: 1, buildings: { hearth: 999 }, resources: { gold: Infinity }, level: -20, highestRegion: 100, productionAt: 99999 }, 1000);
  assert.equal(p.buildings.hearth, 8);
  assert.equal(p.level, 1);
  assert.equal(p.resources.gold, 0);
  assert.equal(p.highestRegion, 2);
  assert.equal(p.productionAt, 1000);
  assert.deepEqual(R.restoreProfile(null, 1000), R.createProfile(1000));
  const { profile, run } = make();
  for (let i = 0; i < 80; i++) R.stepRun(run, { x: 0.5 }, 0.05);
  const saved = JSON.parse(JSON.stringify(run));
  assert.deepEqual(R.restoreRun(saved, profile), saved);
  const resumed = R.restoreRun(saved, profile);
  for (let i = 0; i < 40; i++) {
    assert.deepEqual(R.stepRun(run, { x: -0.7, y: 0.4 }, 0.05), R.stepRun(resumed, { x: -0.7, y: 0.4 }, 0.05));
  }
  assert.deepEqual(run, resumed, 'RNG and all in-flight entities survive reload');
  saved.hero.x = NaN;
  assert.equal(R.restoreRun(saved, profile), null);
  saved.hero.x = 10; saved.enemies = Array(100).fill({});
  assert.equal(R.restoreRun(saved, profile), null);
});

test('相同种子与操作可重放；暂停选择不推进战斗时间', () => {
  const { profile } = make();
  const a = R.startRun(profile, 'grove', 42), b = R.startRun(profile, 'grove', 42);
  for (let i = 0; i < 500; i++) {
    if (a.state === 'choice') {
      const before = JSON.stringify(a);
      assert.deepEqual(R.stepRun(a, { dash: true, nova: true }, 0.05), []);
      assert.equal(JSON.stringify(a), before);
      assert.equal(R.choosePerk(a, 'invalid').ok, false);
      const id = a.pendingChoices[0].id;
      R.choosePerk(a, id); R.choosePerk(b, id);
    }
    const input = { x: Math.cos(i / 30), y: Math.sin(i / 30), nova: i % 50 === 0 };
    assert.deepEqual(R.stepRun(a, input, 0.05), R.stepRun(b, input, 0.05));
  }
  assert.deepEqual(a, b);
});

test('移动归一化、场地边界与大帧限幅；冲刺会产生无敌并进入冷却', () => {
  const { run } = make();
  const x = run.hero.x, y = run.hero.y;
  R.stepRun(run, { x: 1, y: 1 }, 9);
  assert.ok(Math.abs(Math.hypot(run.hero.x - x, run.hero.y - y) - run.hero.speed * 0.05) < 1e-8);
  assert.equal(run.time, 0.05);
  R.stepRun(run, { x: 1, y: 0, dash: true }, 0.05);
  assert.ok(run.hero.invincible > 0);
  assert.equal(run.stats.dashes, 1);
  R.stepRun(run, { dash: true }, 0.05);
  assert.equal(run.stats.dashes, 1);
  for (let i = 0; i < 100; i++) R.stepRun(run, { x: 999, y: -999 }, 0.05);
  assert.ok(run.hero.x <= R.WIDTH - run.hero.radius);
  assert.ok(run.hero.y >= run.hero.radius);
});

test('近战有预警且可走位躲开，敌人伤害不立即贴身扣血', () => {
  const { run } = make();
  while (!run.enemies.length) R.stepRun(run, {}, 0.05);
  const enemy = run.enemies[0];
  run.spawnTimer = 99;
  enemy.x = run.hero.x + 20; enemy.y = run.hero.y;
  enemy.hp = enemy.maxHp = 99999;
  const hp = run.hero.hp;
  R.stepRun(run, {}, 0.05);
  assert.equal(enemy.phase, 'windup');
  assert.equal(run.hero.hp, hp);
  for (let i = 0; i < 16; i++) R.stepRun(run, { x: -1 }, 0.05);
  assert.equal(run.hero.hp, hp, 'walking out of a melee warning avoids the attack');
});

test('零永久升级、普通走位可在两分钟内通关首区并获得经营资源', () => {
  for (let seed = 1; seed <= 24; seed++) {
    const profile = R.createProfile(1000);
    const run = R.startRun(profile, 'grove', seed);
    play(run, 120);
    assert.equal(run.state, 'victory', `seed ${seed}, time ${run.time}, hp ${run.hero.hp}`);
    assert.equal(run.wave, 4);
    assert.equal(run.stats.kills, 43);
    assert.ok(run.time < 120);
    const initial = { ...profile.resources };
    const restored = R.restoreRun(JSON.parse(JSON.stringify(run)), profile);
    assert.ok(restored, 'winning state survives a reload before settlement');
    const summary = R.finishRun(profile, restored, 'victory', 100000);
    assert.equal(summary.ok, true);
    assert.equal(summary.unlockedRegion, 'quarry');
    assert.ok(profile.resources.gold > initial.gold + 100);
    assert.ok(profile.resources.wood > initial.wood + 80);
    assert.ok(profile.level >= 2);
    const savedProfile = JSON.stringify(profile);
    assert.equal(R.finishRun(profile, run, 'victory', 100000).ok, false, 'a second copy of the run cannot settle twice');
    assert.equal(JSON.stringify(profile), savedProfile);
  }
});

test('不允许伪造胜利；撤退保留已取得资源并且任务只能领取一次', () => {
  const { profile, run } = make();
  assert.equal(R.finishRun(profile, run, 'victory', 2000).ok, false);
  run.loot = { gold: 18, wood: 9, ore: 5 }; run.stats.kills = 6;
  const before = profile.resources.gold;
  assert.equal(R.finishRun(profile, run, 'retreated', 2000).ok, true);
  assert.equal(profile.resources.gold, before + 18);
  const quest = R.getQuests(profile).find((q) => q.id === 'first-run');
  assert.equal(quest.ready, true);
  assert.equal(R.claimQuest(profile, quest.id, 2000).ok, true);
  const after = JSON.stringify(profile);
  assert.equal(R.claimQuest(profile, quest.id, 2000).ok, false);
  assert.equal(JSON.stringify(profile), after);
});

test('Boss落点预警持续一秒，爆发之前不扣血且能走出范围', () => {
  for (const evade of [false, true]) {
    const { profile, run } = make();
    run.wave = 4; run.spawned = 0; run.spawnTimer = 0;
    for (let i = 0; i < 80 && !run.effects.some((e) => e.kind === 'warning'); i++) R.stepRun(run, {}, 0.05);
    const warning = run.effects.find((e) => e.kind === 'warning');
    assert.ok(warning);
    const saved = R.restoreRun(JSON.parse(JSON.stringify(run)), profile);
    assert.ok(saved, 'boss telegraph also survives a saved game');
    const before = run.hero.hp;
    for (let i = 0; i < 8; i++) R.stepRun(run, { y: evade ? -1 : 0 }, 0.05);
    assert.equal(run.hero.hp, before, 'no damage in first 400 ms of telegraph');
    for (let i = 0; i < 16; i++) R.stepRun(run, { y: evade ? -1 : 0 }, 0.05);
    assert.equal(run.hero.hp < before, !evade, 'only a hero remaining inside the warning is hit');
  }
});

test('升级选择与失败战斗可续存，退出不会丢失已经获得的资源', () => {
  const { profile, run } = make();
  for (let i = 0; i < 1200 && run.state === 'active'; i++) {
    const a = run.time * 0.75;
    R.stepRun(run, { x: Math.cos(a), y: Math.sin(a), nova: true }, 0.05);
  }
  assert.equal(run.state, 'choice');
  const restored = R.restoreRun(JSON.parse(JSON.stringify(run)), profile);
  assert.ok(restored);
  assert.deepEqual(restored.pendingChoices, run.pendingChoices);
  const loot = { ...run.loot };
  assert.ok(loot.gold > 0);
  assert.deepEqual(R.finishRun(profile, restored, 'retreated', 2000).resources, loot);
  const next = R.startRun(profile, 'grove', 124);
  next.hero.hp = 0; next.state = 'defeat'; next.loot.gold = 10;
  const failed = R.restoreRun(JSON.parse(JSON.stringify(next)), profile);
  assert.ok(failed);
  assert.equal(R.finishRun(profile, failed, 'defeat', 3000).resources.gold, 10);
});

test('立即出征撤退不能刷永久经验或首次远征奖励，有效参与后仍可完成任务', () => {
  const profile = R.createProfile(1000);
  const resources = { ...profile.resources };
  for (let i = 0; i < 50; i++) {
    const run = R.startRun(profile, 'grove', i);
    const summary = R.finishRun(profile, run, 'retreated', 2000 + i);
    assert.equal(summary.ok, true);
    assert.equal(summary.xp, 0);
    assert.equal(profile.xp, 0);
    assert.equal(profile.level, 1);
    assert.equal(profile.completedRuns, 0);
    assert.equal(R.getQuests(profile).find((q) => q.id === 'first-run').ready, false);
    assert.equal(R.claimQuest(profile, 'first-run', 2000 + i).ok, false);
  }
  assert.deepEqual(profile.resources, resources);
  const nearThreshold = R.startRun(profile, 'grove', 51);
  nearThreshold.time = 29.99;
  R.finishRun(profile, nearThreshold, 'retreated', 3000);
  assert.equal(profile.completedRuns, 0);
  const survivor = R.startRun(profile, 'grove', 52);
  survivor.time = 30;
  assert.equal(R.finishRun(profile, survivor, 'retreated', 4000).xp, 0);
  assert.equal(profile.completedRuns, 1, '30 seconds of participation counts even without kills');
  assert.equal(R.getQuests(profile).find((q) => q.id === 'first-run').ready, true);
  assert.equal(R.claimQuest(profile, 'first-run', 4000).ok, true);
  assert.equal(R.claimQuest(profile, 'first-run', 4000).ok, false);
  const hunter = R.startRun(profile, 'grove', 53);
  hunter.time = 8; hunter.stats.kills = 1;
  assert.equal(R.finishRun(profile, hunter, 'retreated', 5000).xp, 2);
  assert.equal(profile.completedRuns, 2, 'a kill qualifies a shorter expedition');
  assert.equal(profile.totalKills, 1);
});
