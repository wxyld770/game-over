(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Match3Rules = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROWS = 8;
  const COLS = 9;
  const TOTAL = ROWS * COLS;
  const KINDS = 6;
  const MAX_MOVES = 2_000;
  const MAX_SCORE = 1_000_000_000;
  const BASE_SWAP_MS = 200;
  const CASCADE_MS = 600;
  const MIN_MOVE_MS = BASE_SWAP_MS + CASCADE_MS;

  function randomGenerator(seed) {
    let value = seed >>> 0;
    return function random() {
      value = (value + 0x6D2B79F5) >>> 0;
      let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }

  const row = (index) => Math.floor(index / COLS);
  const col = (index) => index % COLS;

  function adjacent(a, b) {
    return Number.isInteger(a) && Number.isInteger(b)
      && a >= 0 && b >= 0 && a < TOTAL && b < TOTAL
      && Math.abs(row(a) - row(b)) + Math.abs(col(a) - col(b)) === 1;
  }

  function swapPath(vector, progress, target) {
    const x = Number(vector?.x) || 0;
    const y = Number(vector?.y) || 0;
    const amount = Math.max(0, Math.min(1, Number(progress) || 0));
    const distance = Math.hypot(x, y);
    const bend = distance * 0.46 * Math.sin(Math.PI * amount);
    let bendX = 0;
    let bendY = 0;
    if (Math.abs(x) >= Math.abs(y)) {
      bendY = (row(target) < ROWS / 2 ? 1 : -1) * bend;
    } else {
      bendX = (col(target) < COLS / 2 ? 1 : -1) * bend;
    }
    return {
      source: { x: x * amount, y: y * amount },
      peer: { x: -x * amount + bendX, y: -y * amount + bendY },
    };
  }

  function matchRuns(board) {
    const runs = [];
    for (let r = 0; r < ROWS; r += 1) {
      for (let c = 0; c < COLS;) {
        const kind = board[r * COLS + c];
        let end = c + 1;
        while (kind !== null && end < COLS && board[r * COLS + end] === kind) end += 1;
        if (end - c >= 3) {
          runs.push({ axis: 'h', kind, cells: Array.from({ length: end - c }, (_, offset) => r * COLS + c + offset) });
        }
        c = end;
      }
    }
    for (let c = 0; c < COLS; c += 1) {
      for (let r = 0; r < ROWS;) {
        const kind = board[r * COLS + c];
        let end = r + 1;
        while (kind !== null && end < ROWS && board[end * COLS + c] === kind) end += 1;
        if (end - r >= 3) {
          runs.push({ axis: 'v', kind, cells: Array.from({ length: end - r }, (_, offset) => (r + offset) * COLS + c) });
        }
        r = end;
      }
    }
    return runs;
  }

  function isSevenTileT(runs, cells) {
    if (cells.length !== 7) return false;
    const horizontal = runs.filter((run) => run.axis === 'h');
    const vertical = runs.filter((run) => run.axis === 'v');
    return horizontal.some((hRun) => vertical.some((vRun) => {
      const longRun = hRun.cells.length === 5 && vRun.cells.length === 3 ? hRun
        : vRun.cells.length === 5 && hRun.cells.length === 3 ? vRun : null;
      const shortRun = longRun === hRun ? vRun : longRun === vRun ? hRun : null;
      if (!longRun || !shortRun) return false;
      const intersection = longRun.cells.find((index) => shortRun.cells.includes(index));
      return intersection !== undefined
        && longRun.cells.indexOf(intersection) === 2
        && [0, 2].includes(shortRun.cells.indexOf(intersection));
    }));
  }

  function scoreGroup(size, crossed, tSeven) {
    if (tSeven) return { shape: 't7', points: 500 };
    if (crossed) return { shape: 'cross', points: 260 + Math.max(0, size - 5) * 55 };
    if (size >= 5) return { shape: 'five', points: 180 + (size - 5) * 45 };
    if (size === 4) return { shape: 'four', points: 90 };
    return { shape: 'three', points: 30 };
  }

  function matchGroups(board) {
    const runs = matchRuns(board);
    if (!runs.length) return [];
    const matched = new Set(runs.flatMap((run) => run.cells));
    const pending = new Set(matched);
    const groups = [];
    while (pending.size) {
      const first = pending.values().next().value;
      const kind = board[first];
      const cells = [];
      const queue = [first];
      pending.delete(first);
      while (queue.length) {
        const index = queue.pop();
        cells.push(index);
        const r = row(index);
        const c = col(index);
        const neighbors = [];
        if (r > 0) neighbors.push(index - COLS);
        if (r + 1 < ROWS) neighbors.push(index + COLS);
        if (c > 0) neighbors.push(index - 1);
        if (c + 1 < COLS) neighbors.push(index + 1);
        for (const neighbor of neighbors) {
          if (pending.has(neighbor) && board[neighbor] === kind) {
            pending.delete(neighbor);
            queue.push(neighbor);
          }
        }
      }
      cells.sort((a, b) => a - b);
      const cellSet = new Set(cells);
      const componentRuns = runs.filter((run) => run.kind === kind
        && run.cells.some((index) => cellSet.has(index)));
      const axes = new Set(componentRuns.map((run) => run.axis));
      const scored = scoreGroup(cells.length, axes.size > 1, isSevenTileT(componentRuns, cells));
      groups.push({ kind, cells, ...scored });
    }
    return groups;
  }

  function hasMatches(board) {
    return matchRuns(board).length > 0;
  }

  function findMoves(board, limit = Infinity) {
    const moves = [];
    for (let index = 0; index < TOTAL && moves.length < limit; index += 1) {
      for (const neighbor of [index + 1, index + COLS]) {
        if (!adjacent(index, neighbor) || board[index] === board[neighbor]) continue;
        [board[index], board[neighbor]] = [board[neighbor], board[index]];
        const groups = matchGroups(board);
        [board[index], board[neighbor]] = [board[neighbor], board[index]];
        if (groups.some((group) => group.cells.includes(index) || group.cells.includes(neighbor))) {
          moves.push([index, neighbor]);
          if (moves.length >= limit) break;
        }
      }
    }
    return moves;
  }

  function stableRandomBoard(random) {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const board = Array(TOTAL);
      for (let index = 0; index < TOTAL; index += 1) {
        const unavailable = new Set();
        const r = row(index);
        const c = col(index);
        if (c >= 2 && board[index - 1] === board[index - 2]) unavailable.add(board[index - 1]);
        if (r >= 2 && board[index - COLS] === board[index - COLS * 2]) unavailable.add(board[index - COLS]);
        const choices = Array.from({ length: KINDS }, (_, kind) => kind).filter((kind) => !unavailable.has(kind));
        board[index] = choices[Math.floor(random() * choices.length)];
      }
      if (findMoves(board, 1).length) return board;
    }
    throw new Error('Unable to generate playable board');
  }

  function collapseAndRefill(board, random) {
    const next = Array(TOTAL).fill(null);
    const drops = [];
    const spawns = [];
    for (let c = 0; c < COLS; c += 1) {
      let destination = ROWS - 1;
      for (let r = ROWS - 1; r >= 0; r -= 1) {
        const from = r * COLS + c;
        if (board[from] === null) continue;
        const to = destination * COLS + c;
        next[to] = board[from];
        if (to !== from) drops.push({ from, to, kind: board[from] });
        destination -= 1;
      }
      while (destination >= 0) {
        const to = destination * COLS + c;
        const kind = Math.floor(random() * KINDS);
        next[to] = kind;
        spawns.push({ fromRow: destination - (spawns.length + ROWS), to, kind });
        destination -= 1;
      }
    }
    return { board: next, drops, spawns };
  }

  function shufflePlayable(board, random) {
    const values = board.slice();
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const shuffled = values.slice();
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
      }
      if (!hasMatches(shuffled) && findMoves(shuffled, 1).length) return shuffled;
    }
    return stableRandomBoard(random);
  }

  function createGame(seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw new Error('Invalid game seed');
    const random = randomGenerator(seed);
    return { seed, random, board: stableRandomBoard(random), score: 0, moves: 0 };
  }

  function swap(game, a, b, options = {}) {
    if (!game || !Array.isArray(game.board) || game.board.length !== TOTAL || !adjacent(a, b)) {
      return { valid: false, reason: 'invalid' };
    }
    const swapped = game.board.slice();
    [swapped[a], swapped[b]] = [swapped[b], swapped[a]];
    let groups = matchGroups(swapped);
    if (!groups.some((group) => group.cells.includes(a) || group.cells.includes(b))) {
      return { valid: false, reason: 'nomatch' };
    }

    game.moves += 1;
    let current = swapped;
    let combo = 1;
    const stages = [];
    while (groups.length) {
      if (combo > 100) throw new Error('Cascade limit exceeded');
      const matched = [...new Set(groups.flatMap((group) => group.cells))].sort((x, y) => x - y);
      const points = groups.reduce((total, group) => total + group.points, 0) * combo;
      game.score += points;
      if (!Number.isSafeInteger(game.score) || game.score > MAX_SCORE) throw new Error('Score limit exceeded');
      const cleared = current.slice();
      for (const index of matched) cleared[index] = null;
      const settled = collapseAndRefill(cleared, game.random);
      if (options.captureStages !== false) {
        stages.push({
          combo,
          groups: groups.map((group) => ({ ...group, cells: group.cells.slice() })),
          matched,
          before: current.slice(),
          cleared,
          after: settled.board.slice(),
          drops: settled.drops,
          spawns: settled.spawns,
          points,
          totalScore: game.score,
        });
      }
      current = settled.board;
      groups = matchGroups(current);
      combo += 1;
    }
    let reshuffled = false;
    if (!findMoves(current, 1).length) {
      current = shufflePlayable(current, game.random);
      reshuffled = true;
    }
    game.board = current;
    return {
      valid: true,
      a,
      b,
      swapped: swapped.slice(),
      stages,
      cascadeCount: combo - 1,
      reshuffled,
      board: current.slice(),
      score: game.score,
      moves: game.moves,
    };
  }

  function replay(seed, moves) {
    if (!Array.isArray(moves) || moves.length < 2 || moves.length > MAX_MOVES * 2 || moves.length % 2 !== 0) {
      throw new Error('Invalid move history');
    }
    const game = createGame(seed);
    let cascadeCount = 0;
    for (let index = 0; index < moves.length; index += 2) {
      const a = moves[index];
      const b = moves[index + 1];
      const result = Number.isInteger(a) && Number.isInteger(b)
        ? swap(game, a, b, { captureStages: false }) : null;
      if (!result?.valid) {
        throw new Error('Invalid move history');
      }
      cascadeCount += result.cascadeCount;
    }
    return {
      score: game.score,
      moveCount: game.moves,
      cascadeCount,
      durationMs: game.moves * BASE_SWAP_MS + cascadeCount * CASCADE_MS,
    };
  }

  return Object.freeze({
    ROWS,
    COLS,
    TOTAL,
    KINDS,
    MAX_MOVES,
    MAX_SCORE,
    MIN_MOVE_MS,
    adjacent,
    swapPath,
    matchRuns,
    matchGroups,
    findMoves,
    createGame,
    swap,
    replay,
  });
}));
