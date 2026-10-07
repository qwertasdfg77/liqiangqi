const { evaluatePosition } = require('./strategy.cjs');
const WIDTH = 9;
const CELLS = 81;
const WIN = 1000000;
const BASE_NEIGHBOURS = Array.from({ length: CELLS }, (_, cell) => {
  const x = cell % WIDTH, y = Math.floor(cell / WIDTH);
  return [x ? cell - 1 : -1, x < 8 ? cell + 1 : -1, y ? cell - WIDTH : -1, y < 8 ? cell + WIDTH : -1];
});
const WALL_EDGES = Array.from({ length: 128 }, (_, wall) => {
  const index = wall % 64, x = index % 8, y = Math.floor(index / 8), a = x + 9 * y;
  return wall < 64 ? [[a, 3, a + 9, 2], [a + 1, 3, a + 10, 2]]
    : [[a, 1, a + 1, 0], [a + 9, 1, a + 10, 0]];
});
const WALL_CONFLICTS = Array.from({ length: 128 }, (_, wall) => {
  const index = wall % 64, x = index % 8, y = Math.floor(index / 8);
  return wall < 64 ? [wall, wall + 64, ...(x > 0 ? [wall - 1] : []), ...(x < 7 ? [wall + 1] : [])]
    : [wall, wall - 64, ...(y > 0 ? [wall - 8] : []), ...(y < 7 ? [wall + 8] : [])];
});
// Every edge has at most two wall placements that can close it. A surviving
// shortest route certifies both reachability and the unchanged distance.
const EDGE_WALLS = Array.from({ length: CELLS * 4 }, () => []);
for (let wall = 0; wall < WALL_EDGES.length; wall++) {
  for (const [a, da, b, db] of WALL_EDGES[wall]) {
    EDGE_WALLS[a * 4 + da].push(wall);
    EDGE_WALLS[b * 4 + db].push(wall);
  }
}

let optimisticFinishBounds;
function finishBounds() {
  if (optimisticFinishBounds) return optimisticFinishBounds;
  const size = 81 * 81 * 2;
  const parents = Array.from({ length: size }, () => []);
  const encode = (a, b, turn) => (a * 81 + b) * 2 + turn;
  for (let a = 0; a < 81; a++) for (let b = 0; b < 81; b++) if (a !== b) for (let turn = 0; turn < 2; turn++) {
    const from = turn === 0 ? a : b, other = turn === 0 ? b : a, id = encode(a, b, turn);
    const moves = [from]; // Optimistic pass: wall placements cannot move a pawn.
    for (let direction = 0; direction < 4; direction++) {
      const next = BASE_NEIGHBOURS[from][direction];
      if (next < 0) continue;
      if (next !== other) { moves.push(next); continue; }
      const beyond = BASE_NEIGHBOURS[other][direction];
      if (beyond >= 0) moves.push(beyond);
      // Always allow the side jump: some future wall may block the straight jump.
      // This is a superset of the real rules, therefore gives only a lower bound.
      for (const side of direction < 2 ? [2, 3] : [0, 1]) {
        const lateral = BASE_NEIGHBOURS[other][side];
        if (lateral >= 0) moves.push(lateral);
      }
    }
    for (const move of moves) parents[encode(turn === 0 ? move : a, turn === 1 ? move : b, 1 - turn)].push(id);
  }
  optimisticFinishBounds = [0, 1].map(target => {
    const distance = new Int16Array(size).fill(-1), queue = [];
    for (let a = 0; a < 81; a++) for (let b = 0; b < 81; b++) if (a !== b) {
      if (Math.floor((target === 0 ? a : b) / 9) !== (target === 0 ? 0 : 8)) continue;
      for (let turn = 0; turn < 2; turn++) { const id = encode(a, b, turn); distance[id] = 0; queue.push(id); }
    }
    for (let head = 0; head < queue.length; head++) {
      for (const parent of parents[queue[head]]) if (distance[parent] < 0) {
        distance[parent] = distance[queue[head]] + 1;
        queue.push(parent);
      }
    }
    return distance;
  });
  return optimisticFinishBounds;
}

class Board {
  constructor(source) {
    this.pawns = source ? source.playerPos.map(pos => pos.x + 9 * pos.y) : [76, 4];
    this.turn = source ? source.waitFor : 0;
    this.left = source ? [...source.leftWalls] : [10, 10];
    this.walls = new Uint8Array(128);
    this.blocked = new Uint8Array(CELLS);
    this.bits = new Int32Array(4);
    this.reflectedBits = new Int32Array(4);
    this.queue = new Int16Array(CELLS);
    this.seen = new Uint32Array(CELLS);
    this.parents = new Int16Array(CELLS);
    this.bfsClock = 0;
    this.layoutKey = '0,0,0,0'; this.reflectedLayoutKey = this.layoutKey;
    this.wallVersion = 0; this.keyVersion = 0; this.mirrorKeyVersion = 0;
    if (source) for (const wall of source.walls) this.toggleWall(wall.x + 8 * wall.y + 64 * wall.d, true);
  }
  toggleWall(wall, add) {
    this.walls[wall] = add ? 1 : 0;
    const word = Math.floor(wall / 32), bit = 1 << (wall % 32);
    if (add) this.bits[word] |= bit; else this.bits[word] &= ~bit;
    const index = wall % 64;
    const reflected = 64 * Math.floor(wall / 64) + 7 - index % 8 + 8 * Math.floor(index / 8);
    const reflectedWord = Math.floor(reflected / 32), reflectedBit = 1 << (reflected % 32);
    if (add) this.reflectedBits[reflectedWord] |= reflectedBit;
    else this.reflectedBits[reflectedWord] &= ~reflectedBit;
    for (const [a, directionA, b, directionB] of WALL_EDGES[wall]) {
      if (add) { this.blocked[a] |= 1 << directionA; this.blocked[b] |= 1 << directionB; }
      else { this.blocked[a] &= ~(1 << directionA); this.blocked[b] &= ~(1 << directionB); }
    }
    // Exact wall bits, rather than a probabilistic hash. Pawn moves reuse these
    // strings; changing or undoing a wall updates both mirror orientations.
    this.wallVersion++;
  }
  refreshWallKeys(reflected = false) {
    if (reflected) {
      if (this.mirrorKeyVersion !== this.wallVersion) {
        this.reflectedLayoutKey = `${this.reflectedBits[0]},${this.reflectedBits[1]},${this.reflectedBits[2]},${this.reflectedBits[3]}`;
        this.mirrorKeyVersion = this.wallVersion;
      }
      return;
    }
    if (this.keyVersion === this.wallVersion) return;
    this.layoutKey = `${this.bits[0]},${this.bits[1]},${this.bits[2]},${this.bits[3]}`;
    this.keyVersion = this.wallVersion;
  }
  signature() {
    return `${this.pawns[0]},${this.pawns[1]},${this.turn},${this.left[0]},${this.left[1]},${this.bits[0]},${this.bits[1]},${this.bits[2]},${this.bits[3]}`;
  }
  positionSignature() {
    return `${this.pawns[0]},${this.pawns[1]},${this.left[0]},${this.left[1]},${this.bits[0]},${this.bits[1]},${this.bits[2]},${this.bits[3]}`;
  }
  canonicalSignature() {
    return this.canonicalState().key;
  }
  canonicalState(compact = true) {
    if (compact) {
      const a = this.pawns[0], b = this.pawns[1];
      const position = (((a * 81 + b) * 2 + this.turn) * 11 + this.left[0]) * 11 + this.left[1];
      const ra = 8 - a % 9 + 9 * Math.floor(a / 9), rb = 8 - b % 9 + 9 * Math.floor(b / 9);
      const mirror = (((ra * 81 + rb) * 2 + this.turn) * 11 + this.left[0]) * 11 + this.left[1];
      let reflected = position > mirror;
      if (position === mirror) for (let word=0;word<4;word++) {
        const normal=this.bits[word]>>>0, other=this.reflectedBits[word]>>>0;
        if(normal!==other){reflected=normal>other;break;}
      }
      this.refreshWallKeys(reflected);
      return { key: reflected ? `${mirror}|${this.reflectedLayoutKey}` : `${position}|${this.layoutKey}`, reflected };
    }
    const ordinary = this.signature();
    const a = this.pawns[0], b = this.pawns[1];
    const reflectedA = 8 - a % 9 + 9 * Math.floor(a / 9), reflectedB = 8 - b % 9 + 9 * Math.floor(b / 9);
    const reflected = `${reflectedA},${reflectedB},${this.turn},${this.left[0]},${this.left[1]},${this.reflectedBits[0]},${this.reflectedBits[1]},${this.reflectedBits[2]},${this.reflectedBits[3]}`;
    return ordinary <= reflected ? { key: ordinary, reflected: false } : { key: reflected, reflected: true };
  }
  symmetric() {
    return this.pawns[0] % 9 === 4 && this.pawns[1] % 9 === 4 && this.bits.every((bits, index) => bits === this.reflectedBits[index]);
  }
  pawnMoves(player = this.turn) {
    const from = this.pawns[player], other = this.pawns[1 - player], out = [];
    for (let direction = 0; direction < 4; direction++) {
      const next = BASE_NEIGHBOURS[from][direction];
      if (next < 0 || (this.blocked[from] & (1 << direction))) continue;
      if (next !== other) { out.push(next); continue; }
      const beyond = BASE_NEIGHBOURS[other][direction];
      if (beyond >= 0 && !(this.blocked[other] & (1 << direction))) {
        out.push(beyond);
      } else {
        for (const side of direction < 2 ? [2, 3] : [0, 1]) {
          const lateral = BASE_NEIGHBOURS[other][side];
          if (lateral >= 0 && !(this.blocked[other] & (1 << side))) out.push(lateral);
        }
      }
    }
    return out;
  }
  distance(player) {
    const start = this.pawns[player];
    let token = (this.bfsClock + 1) >>> 0;
    if (token === 0) { this.seen.fill(0); token = 1; }
    this.bfsClock = token;
    const queue = this.queue, seen = this.seen, blocked = this.blocked;
    queue[0] = start;
    seen[start] = token;
    let head = 0, tail = 1, depth = 0, end = 1;
    while (head < tail) {
      const cell = queue[head++];
      if (player === 0 ? cell < 9 : cell >= 72) return depth;
      const neighbours = BASE_NEIGHBOURS[cell], mask = blocked[cell];
      const a = neighbours[0], b = neighbours[1], c = neighbours[2], d = neighbours[3];
      if (a >= 0 && !(mask & 1) && seen[a] !== token) { seen[a] = token; queue[tail++] = a; }
      if (b >= 0 && !(mask & 2) && seen[b] !== token) { seen[b] = token; queue[tail++] = b; }
      if (c >= 0 && !(mask & 4) && seen[c] !== token) { seen[c] = token; queue[tail++] = c; }
      if (d >= 0 && !(mask & 8) && seen[d] !== token) { seen[d] = token; queue[tail++] = d; }
      if (head === end) { depth++; end = tail; }
    }
    return Infinity;
  }
  shortestRoute(player) {
    const start = this.pawns[player], mask = new Int32Array(4);
    let token = (this.bfsClock + 1) >>> 0;
    if (token === 0) { this.seen.fill(0); token = 1; }
    this.bfsClock = token;
    const queue = this.queue, seen = this.seen, parents = this.parents;
    queue[0] = start; seen[start] = token;
    let head = 0, tail = 1, depth = 0, end = 1;
    while (head < tail) {
      const cell = queue[head++];
      if (player === 0 ? cell < 9 : cell >= 72) {
        for (let child = cell; child !== start;) {
          const parent = parents[child], delta = child - parent;
          const direction = delta === -1 ? 0 : delta === 1 ? 1 : delta === -9 ? 2 : 3;
          for (const wall of EDGE_WALLS[parent * 4 + direction]) mask[wall >>> 5] |= 1 << (wall & 31);
          child = parent;
        }
        return { distance: depth, mask };
      }
      const neighbours = BASE_NEIGHBOURS[cell], blocked = this.blocked[cell];
      for (let direction = 0; direction < 4; direction++) {
        const next = neighbours[direction];
        if (next < 0 || (blocked & (1 << direction)) || seen[next] === token) continue;
        seen[next] = token; parents[next] = cell; queue[tail++] = next;
      }
      if (head === end) { depth++; end = tail; }
    }
    return { distance: Infinity, mask };
  }
  wallGeometricallyLegal(wall) { return WALL_CONFLICTS[wall].every(other => !this.walls[other]); }
  wallLegal(wall, routes) {
    if (!this.wallGeometricallyLegal(wall)) return false;
    const word = wall >>> 5, bit = 1 << (wall & 31);
    if (routes && !(routes[0].mask[word] & bit) && !(routes[1].mask[word] & bit)) {
      return Number.isFinite(routes[0].distance) && Number.isFinite(routes[1].distance);
    }
    this.toggleWall(wall, true);
    const d0 = routes && !(routes[0].mask[word] & bit) ? routes[0].distance : this.distance(0);
    const d1 = routes && !(routes[1].mask[word] & bit) ? routes[1].distance : this.distance(1);
    const legal = Number.isFinite(d0) && Number.isFinite(d1);
    this.toggleWall(wall, false);
    return legal;
  }
  legalActions() {
    const actions = this.pawnMoves();
    if (this.left[this.turn] > 0) {
      const routes = [this.shortestRoute(0), this.shortestRoute(1)];
      for (let wall = 0; wall < 128; wall++) if (this.wallLegal(wall, routes)) actions.push(81 + wall);
    }
    return actions;
  }
  apply(action) {
    const player = this.turn;
    const undo = { player, oldPawn: this.pawns[player], action };
    let terminal = null;
    if (action < 81) {
      this.pawns[player] = action;
      if (player === 1 && Math.floor(action / 9) === 8) terminal = -1;
      else if (player === 0 && Math.floor(action / 9) === 0) {
        terminal = this.pawnMoves(1).some(move => Math.floor(move / 9) === 8) ? 0 : 1;
      }
    } else {
      this.toggleWall(action - 81, true);
      this.left[player]--;
    }
    this.turn = 1 - player;
    return { undo, terminal };
  }
  undo(undo) {
    this.turn = undo.player;
    if (undo.action < 81) this.pawns[undo.player] = undo.oldPawn;
    else { this.toggleWall(undo.action - 81, false); this.left[undo.player]++; }
  }
  evaluate() {
    const distances = [this.distance(0), this.distance(1)];
    // Credit only the player to move, and only when a jump actually shortens
    // the remaining route. Opponent jumps may disappear after the next action.
    const corrected = [...distances], player = this.turn, from = this.pawns[player];
    for (const move of this.pawnMoves(player)) {
      const displacement = Math.abs(move % 9 - from % 9) + Math.abs(Math.floor(move / 9) - Math.floor(from / 9));
      if (displacement !== 2) continue;
      this.pawns[player] = move;
      corrected[player] = Math.min(corrected[player], 1 + this.distance(player));
      this.pawns[player] = from;
    }
    return evaluatePosition(this, corrected);
  }
  orderedActions(preferred = -1) {
    const player = this.turn;
    const routes = [this.shortestRoute(0), this.shortestRoute(1)];
    const candidates = this.pawnMoves();
    if (this.left[player] > 0) for (let wall = 0; wall < 128; wall++) if (this.wallGeometricallyLegal(wall)) candidates.push(81 + wall);
    const scored = [];
    for (const action of candidates) {
      const score = this.actionScore(action, routes);
      if (score !== null) {
        scored.push({ action, score: action === preferred ? (player === 0 ? 2 * WIN : -2 * WIN) : score });
      }
    }
    scored.sort((a, b) => player === 0 ? b.score - a.score : a.score - b.score);
    return scored.map(candidate => candidate.action);
  }
  actionScore(action, routes) {
    const player = this.turn, { undo, terminal } = this.apply(action);
    try {
      const wall = action - CELLS, word = wall >>> 5, bit = 1 << (wall & 31);
      const d0 = action < CELLS ? (player === 0 ? this.distance(0) : routes[0].distance)
        : (routes[0].mask[word] & bit ? this.distance(0) : routes[0].distance);
      const d1 = action < CELLS ? (player === 1 ? this.distance(1) : routes[1].distance)
        : (routes[1].mask[word] & bit ? this.distance(1) : routes[1].distance);
      if (!Number.isFinite(d0) || !Number.isFinite(d1)) return null;
      return terminal === null ? evaluatePosition(this, [d0, d1]) : terminal * WIN;
    } finally { this.undo(undo); }
  }
  *searchActions(preferred = -1, killers, history) {
    const pawns = this.pawnMoves(), emitted = [];
    const isLegal = action => Number.isInteger(action) && action >= 0 && (action < CELLS
      ? pawns.includes(action) : this.left[this.turn] > 0 && action < 209 && this.wallLegal(action - CELLS));
    if (isLegal(preferred)) { emitted.push(preferred); yield preferred; }
    if (killers) for (const action of killers) {
      if (!emitted.includes(action) && isLegal(action)) { emitted.push(action); yield action; }
    }
    const player = this.turn, routes = [this.shortestRoute(0), this.shortestRoute(1)], scored = [];
    for (const action of pawns) if (!emitted.includes(action)) {
      const score = this.actionScore(action, routes);
      if (score !== null) scored.push({ action, score });
    }
    if (this.left[player] > 0) for (let wall = 0; wall < 128; wall++) {
      const word = wall >>> 5, bit = 1 << (wall & 31), action = CELLS + wall;
      if (!((routes[0].mask[word] | routes[1].mask[word]) & bit) || emitted.includes(action)
        || !this.wallGeometricallyLegal(wall)) continue;
      const score = this.actionScore(action, routes);
      if (score !== null) scored.push({ action, score });
    }
    scored.sort((a, b) => (player === 0 ? b.score - a.score : a.score - b.score)
      || (history ? history[player * 209 + b.action] - history[player * 209 + a.action] : 0));
    const hasWalls = this.left[player] > 0;
    if (hasWalls) this.left[player]--;
    const neutralScore = evaluatePosition(this, routes.map(route => route.distance));
    if (hasWalls) this.left[player]++;
    let index = 0;
    while (index < scored.length && (player === 0 ? scored[index].score >= neutralScore : scored[index].score <= neutralScore)) {
      yield scored[index++].action;
    }
    // These walls preserve both chosen shortest routes. Generate them only
    // if the promising stages failed to cut off; no path search is necessary.
    if (this.left[player] > 0 && Number.isFinite(neutralScore)) for (let wall = 0; wall < 128; wall++) {
      const word = wall >>> 5, bit = 1 << (wall & 31), action = CELLS + wall;
      if (!((routes[0].mask[word] | routes[1].mask[word]) & bit) && !emitted.includes(action)
        && this.wallGeometricallyLegal(wall)) yield action;
    }
    while (index < scored.length) yield scored[index++].action;
  }
}

class Search {
  constructor({ milliseconds = 60000, maxEntries = 200000, pvs = true, compactKeys = true } = {}) {
    this.deadline = Date.now() + milliseconds;
    this.started = Date.now();
    this.nodes = 0;
    this.maxEntries = maxEntries;
    this.table = new Map();
    this.proofTable = new Map();
    this.best = new Map();
    this.killers = [];
    this.history = new Int32Array(2 * 209);
    this.pvs = pvs;
    this.compactKeys = compactKeys;
    this.aborted = false;
  }
  tick() {
    this.nodes++;
    if ((this.nodes & 1023) === 0 && Date.now() >= this.deadline) {
      this.aborted = true;
      throw new Error('SEARCH_TIME_LIMIT');
    }
  }
  minimax(board, depth, alpha = -2 * WIN, beta = 2 * WIN) {
    this.tick();
    if (depth === 0) return board.evaluate();
    const positionKey = board.signature(), canonical = board.canonicalState(this.compactKeys);
    const key = `${depth}|${canonical.key}`, entry = this.table.get(key);
    const preferred = entry ? (canonical.reflected ? mirrorAction(entry.action) : entry.action) : this.best.get(positionKey);
    const oldAlpha = alpha, oldBeta = beta;
    if (entry && entry.depth >= depth) {
      if (entry.flag === 'exact') return entry.value;
      if (entry.flag === 'lower') alpha = Math.max(alpha, entry.value);
      if (entry.flag === 'upper') beta = Math.min(beta, entry.value);
      if (alpha >= beta) return entry.value;
    }
    const maximizing = board.turn === 0;
    let value = maximizing ? -2 * WIN : 2 * WIN, bestAction = -1;
    const symmetry = board.symmetric();
    for (const action of board.searchActions(preferred, this.killers[depth], this.history)) {
      if (symmetry && action > mirrorAction(action)) continue;
      const { undo, terminal } = board.apply(action);
      let child;
      try {
        if (terminal !== null) child = terminal * WIN;
        else if (!this.pvs || bestAction === -1) child = this.minimax(board, depth - 1, alpha, beta);
        else {
          // First establish the principal line; test alternatives with a
          // one-point window and re-search every improvement inside the bounds.
          child = maximizing ? this.minimax(board, depth - 1, alpha, Math.min(beta, alpha + 1))
            : this.minimax(board, depth - 1, Math.max(alpha, beta - 1), beta);
          if (child > alpha && child < beta) child = this.minimax(board, depth - 1, alpha, beta);
        }
      }
      finally { board.undo(undo); }
      if (bestAction === -1 || (maximizing ? child > value : child < value)) { value = child; bestAction = action; }
      if (maximizing) alpha = Math.max(alpha, value); else beta = Math.min(beta, value);
      if (alpha >= beta) {
        const previous = this.killers[depth];
        this.killers[depth] = previous ? (previous[0] !== action ? [action, previous[0]] : previous) : [action];
        const index = (maximizing ? 0 : 1) * 209 + action;
        this.history[index] = Math.min(1000000, this.history[index] + depth * depth);
        break;
      }
    }
    const flag = value <= oldAlpha ? 'upper' : value >= oldBeta ? 'lower' : 'exact';
    const storedAction = canonical.reflected ? mirrorAction(bestAction) : bestAction;
    if (this.table.size < this.maxEntries || this.table.has(key)) this.table.set(key, { depth, value, flag, action: storedAction });
    if (this.best.size < this.maxEntries || this.best.has(positionKey)) this.best.set(positionKey, bestAction);
    return value;
  }
  // Exact finite-horizon reachability, without heuristic evaluations at leaves.
  // False means no forced sole win within this horizon, not a full-game loss.
  forceWin(board, target, depth) {
    this.tick();
    if (depth === 0) return false;
    const relaxedMinimum = finishBounds()[target][(board.pawns[0] * 81 + board.pawns[1]) * 2 + board.turn];
    if (relaxedMinimum > depth) return false;
    const ownTurns = board.turn === target ? Math.ceil(depth / 2) : Math.floor(depth / 2);
    if (2 * ownTurns < board.distance(target)) return false;
    const key = `${target}|${depth}|${board.canonicalSignature()}`;
    if (this.proofTable.has(key)) return this.proofTable.get(key);
    const own = board.turn === target;
    let result = !own;
    const symmetry = board.symmetric();
    for (const action of board.searchActions(this.best.get(board.signature()))) {
      if (symmetry && action > mirrorAction(action)) continue;
      const { undo, terminal } = board.apply(action);
      let child;
      try { child = terminal === null ? this.forceWin(board, target, depth - 1) : terminal === (target === 0 ? 1 : -1); }
      finally { board.undo(undo); }
      if ((own && child) || (!own && !child)) { result = child; break; }
    }
    if (this.proofTable.size < this.maxEntries) this.proofTable.set(key, result);
    return result;
  }
  principalVariation(board, depth) {
    const line = [], undos = [];
    try {
      for (let ply = 0; ply < depth; ply++) {
        const canonical = board.canonicalState(this.compactKeys);
        const entry = this.table.get(`${depth - ply}|${canonical.key}`);
        if (!entry || entry.action < 0) break;
        const action = canonical.reflected ? mirrorAction(entry.action) : entry.action;
        if (!board.legalActions().includes(action)) break;
        const player = board.turn;
        const { undo, terminal } = board.apply(action);
        undos.push(undo);
        line.push({ player: player + 1, action, label: describe(action), terminal });
        if (terminal !== null) break;
      }
    } finally { for (let i = undos.length - 1; i >= 0; i--) board.undo(undos[i]); }
    return line;
  }
}
function describe(action) {
  if (action < 81) return `${'ABCDEFGHI'[action % 9]}${9 - Math.floor(action / 9)}`;
  const wall = action - 81, index = wall % 64;
  return `${wall < 64 ? 'H' : 'V'}(${index % 8},${Math.floor(index / 8)})`;
}
function mirrorAction(action) {
  if (action < 81) return 8 - action % 9 + 9 * Math.floor(action / 9);
  const wall = action - 81, index = wall % 64;
  return 81 + 64 * Math.floor(wall / 64) + 7 - index % 8 + 8 * Math.floor(index / 8);
}
module.exports = { Board, Search, describe, mirrorAction, WIN };
