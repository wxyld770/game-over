(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JumpRules = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_HOLD_MS = 1100;
  const MAX_JUMPS = 10000;
  const STEP_SECONDS = 1 / 120;
  const GRAVITY = 850;
  const PLAYER_RADIUS = 19;
  const PLATFORM_Y_LIMIT = 55;
  const PLATFORM_WINDOW_SIZE = 2;
  const CAMERA_SPEED_PX = 96;
  const VIEW_SCALE_SPEED = 0.18;

  function frameDeltaSeconds(now, previous) {
    if (!Number.isFinite(now) || !Number.isFinite(previous)) return 0;
    return Math.max(0, Math.min(0.033, (now - previous) / 1000));
  }

  function moveToward(value, target, maximumChange) {
    if (Math.abs(target - value) <= maximumChange) return target;
    return value + Math.sign(target - value) * maximumChange;
  }

  function updateCameraView(view, scene, dt, snap = false) {
    if (!view || !scene || !Number.isFinite(dt) || dt < 0) throw new Error('Invalid camera state');
    const { player, platforms, displayWidth, displayHeight, baseViewScale } = scene;
    if (!Array.isArray(platforms)
      || !Number.isFinite(displayWidth) || displayWidth <= 0
      || !Number.isFinite(displayHeight) || displayHeight <= 0
      || !Number.isFinite(baseViewScale) || baseViewScale <= 0) {
      throw new Error('Invalid camera scene');
    }

    const current = player && (player.standing || platforms[0]);
    const next = player && platforms.find((platform) => platform !== current
      && platform.x + platform.w > player.x - player.r);
    const left = player
      ? Math.min(player.x - player.r * 1.7, player.standing && platforms[0] ? platforms[0].x : player.x)
      : 0;
    const right = player
      ? Math.max(player.x + player.r * 1.7, next ? next.x + next.w : player.x + 110)
      : displayWidth / baseViewScale;
    const targetScale = Math.min(baseViewScale, displayWidth / Math.max(1, right - left + 44));
    const previousScale = Number.isFinite(view.scale) && view.scale > 0 ? view.scale : baseViewScale;
    const scale = snap ? targetScale : moveToward(previousScale, targetScale, VIEW_SCALE_SPEED * dt);
    const width = displayWidth / scale;
    const height = displayHeight / scale;
    const targetCenterX = Math.max(width / 2, (left + right) / 2);
    const previousCenterX = Number.isFinite(view.centerX) ? view.centerX : targetCenterX;
    const maximumWorldChange = CAMERA_SPEED_PX * dt / scale;
    const movedCenterX = snap
      ? targetCenterX
      : moveToward(previousCenterX, targetCenterX, maximumWorldChange);
    const centerX = Math.max(width / 2, movedCenterX);

    return {
      scale,
      width,
      height,
      centerX,
      cameraX: centerX - width / 2,
      targetScale,
      targetCenterX,
    };
  }

  function randomGenerator(seed) {
    let value = seed >>> 0;
    return function () {
      value = (value + 0x6D2B79F5) >>> 0;
      let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }

  function nextPlatform(game, previous) {
    const gap = 98 + game.random() * 145;
    const width = 107 + game.random() * 32;
    const shift = game.random() * 34 - 17;
    game.spawned += 1;
    return {
      x: previous.x + previous.w + gap,
      y: Math.max(game.groundY - PLATFORM_Y_LIMIT, Math.min(game.groundY + PLATFORM_Y_LIMIT, previous.y + shift)),
      w: width,
      h: 25,
      hue: 176 + game.random() * 42,
      special: game.spawned % 4 === 2 ? 'star' : 'normal',
      pulse: 0,
    };
  }

  function createGame(seed, groundY = 0) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw new Error('Invalid game seed');
    if (!Number.isFinite(groundY)) throw new Error('Invalid ground position');
    const game = {
      seed,
      groundY,
      random: randomGenerator(seed),
      platforms: [{ x: 32, y: groundY, w: 145, h: 25, hue: 181, special: 'normal', pulse: 0 }],
      player: null,
      score: 0,
      perfectStreak: 0,
      spawned: 0,
      state: 'ready',
    };
    game.platforms.push(nextPlatform(game, game.platforms[0]));
    const first = game.platforms[0];
    game.player = { x: first.x + first.w / 2, y: first.y - PLAYER_RADIUS, vx: 0, vy: 0, r: PLAYER_RADIUS, standing: first };
    return game;
  }

  function jump(game, holdMs) {
    if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > MAX_HOLD_MS) throw new Error('Invalid charge duration');
    if (game.state !== 'ready') throw new Error('The player cannot jump now');
    const charge = holdMs / MAX_HOLD_MS;
    game.player.vx = 125 + 390 * charge;
    game.player.vy = -(390 + 45 * charge);
    game.player.standing = null;
    game.state = 'jumping';
  }

  function land(game, platform) {
    const player = game.player;
    player.y = platform.y - player.r;
    player.vx = 0;
    player.vy = 0;
    player.standing = platform;
    game.state = 'ready';
    platform.pulse = 1;
    const advanced = platform !== game.platforms[0];
    let perfect = false;
    let earned = 0;
    if (advanced) {
      perfect = Math.abs(player.x - (platform.x + platform.w / 2)) <= platform.w * 0.12;
      game.perfectStreak = perfect ? game.perfectStreak + 1 : 0;
      const centerBonus = perfect ? 2 + Math.min(game.perfectStreak - 1, 2) : 0;
      earned = 1 + centerBonus + (platform.special === 'star' ? 3 : 0);
      game.score += earned;
      game.platforms.shift();
      game.platforms.push(nextPlatform(game, platform));
    } else {
      game.perfectStreak = 0;
    }
    return { landed: true, advanced, perfect, earned, platform, score: game.score, perfectStreak: game.perfectStreak };
  }

  function step(game, dt = STEP_SECONDS) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.1) throw new Error('Invalid simulation step');
    if (game.state !== 'jumping') return null;
    const player = game.player;
    const previousBottom = player.y + player.r;
    player.vy += GRAVITY * dt;
    player.x += player.vx * dt;
    player.y += player.vy * dt;
    if (player.vy >= 0) {
      for (const platform of game.platforms) {
        if (previousBottom <= platform.y + 4
          && player.y + player.r >= platform.y
          && player.x + player.r * 0.55 >= platform.x
          && player.x - player.r * 0.55 <= platform.x + platform.w) {
          return land(game, platform);
        }
      }
    }
    if (player.y - player.r > game.groundY + 185) {
      game.state = 'over';
      return { over: true, score: game.score, perfectStreak: game.perfectStreak };
    }
    return null;
  }

  function replay(seed, holds) {
    if (!Array.isArray(holds) || !holds.length || holds.length > MAX_JUMPS) throw new Error('Invalid jump history');
    const game = createGame(seed);
    let chargeMs = 0;
    let steps = 0;
    for (const holdMs of holds) {
      jump(game, holdMs);
      chargeMs += holdMs;
      let flightSteps = 0;
      while (game.state === 'jumping') {
        step(game);
        steps += 1;
        flightSteps += 1;
        if (flightSteps > 2400) throw new Error('Invalid flight history');
      }
    }
    if (game.state !== 'over') throw new Error('The run has not finished');
    const flightDurationMs = steps * STEP_SECONDS * 1000;
    return { score: game.score, perfectStreak: game.perfectStreak, durationMs: chargeMs + flightDurationMs, flightDurationMs, jumpCount: holds.length };
  }

  return Object.freeze({
    createGame,
    jump,
    step,
    replay,
    MAX_HOLD_MS,
    MAX_JUMPS,
    STEP_SECONDS,
    GRAVITY,
    PLAYER_RADIUS,
    PLATFORM_Y_LIMIT,
    PLATFORM_WINDOW_SIZE,
    CAMERA_SPEED_PX,
    VIEW_SCALE_SPEED,
    frameDeltaSeconds,
    updateCameraView,
  });
}));
