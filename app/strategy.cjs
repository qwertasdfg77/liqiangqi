// These are heuristic resource values, in the same units as one walking step
// (100). No reserve is mandatory; terminal results always take precedence.
const RESERVE = [0, 250, 420, 520, 532, 544, 556, 568, 580, 592, 604];
function resourceValue(stock, opponentStock, distance) {
  const pressure = 1 + 0.015 * Math.min(8, opponentStock);
  const phase = 0.85 + 0.15 * Math.min(3, distance) / 3;
  // Pressure boosts the reserve premium, not the ordinary stock. Keep every
  // marginal wall positive and retain a positive incentive to walk forward.
  return Math.round((12 * stock + (RESERVE[stock] - 12 * stock) * pressure) * phase);
}
function routeRisk(board, player, distance) {
  if (!board.left[1 - player] || distance < 2) return 0;
  const cell = board.pawns[player], x = cell % 9, y = Math.floor(cell / 9), mask = board.blocked[cell];
  const exits = Number(x > 0 && !(mask & 1)) + Number(x < 8 && !(mask & 2))
    + Number(y > 0 && !(mask & 4)) + Number(y < 8 && !(mask & 8));
  const detour = Math.max(0, distance - (player === 0 ? y : 8 - y));
  const exposure = (exits === 1 ? 65 : exits === 2 ? 24 : 0) + Math.min(10, detour) * 3;
  return Math.round(exposure * Math.min(4, board.left[1 - player]) / 4);
}
function evaluatePosition(board, distances) {
  return 100 * (distances[1] - distances[0])
    + resourceValue(board.left[0], board.left[1], distances[0])
    - resourceValue(board.left[1], board.left[0], distances[1])
    + routeRisk(board, 1, distances[1]) - routeRisk(board, 0, distances[0]);
}
function goalField(board, player) {
  const distances = new Int16Array(81).fill(-1), queue = new Int16Array(81);
  let head = 0, tail = 0;
  for (let x = 0; x < 9; x++) { const cell = x + 72 * player; distances[cell] = 0; queue[tail++] = cell; }
  while (head < tail) {
    const cell = queue[head++], x = cell % 9, mask = board.blocked[cell];
    const neighbours = [x ? cell - 1 : -1, x < 8 ? cell + 1 : -1, cell >= 9 ? cell - 9 : -1, cell < 72 ? cell + 9 : -1];
    for (let d = 0; d < 4; d++) {
      const next = neighbours[d];
      if (next < 0 || (mask & (1 << d)) || distances[next] >= 0) continue;
      distances[next] = distances[cell] + 1; queue[tail++] = next;
    }
  }
  return distances;
}
function wallOpportunities(board) {
  const routes = [board.shortestRoute(0), board.shortestRoute(1)], out = [[], []];
  for (let wall = 0; wall < 128; wall++) {
    if (!board.wallGeometricallyLegal(wall)) continue;
    const word = wall >>> 5, bit = 1 << (wall & 31);
    if (!((routes[0].mask[word] | routes[1].mask[word]) & bit)) continue;
    board.toggleWall(wall, true);
    let distances;
    try { distances = routes.map((route, player) => route.mask[word] & bit ? board.distance(player) : route.distance); }
    finally { board.toggleWall(wall, false); }
    if (!distances.every(Number.isFinite)) continue;
    for (const player of [0, 1]) {
      const ownDelay = distances[player] - routes[player].distance;
      const opponentDelay = distances[1 - player] - routes[1 - player].distance;
      out[player].push({ action: 81 + wall, ownDelay, opponentDelay, gain: opponentDelay - ownDelay });
    }
  }
  for (const list of out) list.sort((a, b) => b.gain - a.gain || b.opponentDelay - a.opponentDelay || a.action - b.action);
  return { routes, opportunities: out };
}
function layoutAssessment(board) {
  const { routes, opportunities } = wallOpportunities(board);
  const options = [0, 1].map(player => {
    const field = goalField(board, player), cell = board.pawns[player], x = cell % 9;
    const neighbours = [x ? cell - 1 : -1, x < 8 ? cell + 1 : -1, cell >= 9 ? cell - 9 : -1, cell < 72 ? cell + 9 : -1];
    return neighbours.filter((next, d) => next >= 0 && !(board.blocked[cell] & (1 << d))
      && field[next] === field[cell] - 1).length;
  });
  const threats = [0, 1].map(player => board.left[1 - player] ? Math.max(0, opportunities[1 - player][0]?.gain || 0) : 0);
  return { distance: routes.map(route => route.distance), options, threats, opportunities,
    reserve: [0, 1].map(player => resourceValue(board.left[player], board.left[1 - player], routes[player].distance)) };
}
function planLayout(board, { milliseconds = 45, maxNodes = 350 } = {}) {
  const started = Date.now(), deadline = started + milliseconds, root = board.signature();
  const assessment = layoutAssessment(board), ordered = board.orderedActions(), player = board.turn;
  const candidateSet = new Set([...ordered.filter(action => action < 81),
    ...assessment.opportunities[player].slice(0, 6).map(item => item.action), ...ordered.slice(0, 6)]);
  const candidates = ordered.filter(action => candidateSet.has(action));
  // Spend the expensive full-channel assessment only at candidate roots. This
  // includes how the other side can exploit or extend the walls just placed.
  const priorities = new Map();
  for (const action of candidates) {
    if (Date.now() >= deadline) break;
    const transition = board.apply(action);
    try {
      const next = layoutAssessment(board);
      priorities.set(action, (player===0?1:-1)*(transition.terminal === null ? board.evaluate()
        + 20 * (next.threats[1] - next.threats[0]) + 12 * (next.options[0] - next.options[1]) : transition.terminal * 1000000));
    } finally { board.undo(transition.undo); }
  }
  candidates.sort((a,b) => (priorities.get(b)??-Infinity)-(priorities.get(a)??-Infinity));
  const plans = []; let nodes = 0;
  function beam(depth) {
    if (++nodes > maxNodes || Date.now() >= deadline) throw new Error('LAYOUT_LIMIT');
    if (!depth) return { score: board.evaluate(), line: [] };
    const sign = board.turn === 0 ? 1 : -1, actions = board.orderedActions();
    const shortlist = [...actions.filter(action => action < 81).slice(0, 1), ...actions.filter(action => action >= 81).slice(0, 2)];
    let best = null;
    for (const action of shortlist) {
      const transition = board.apply(action); let child;
      try { child = transition.terminal === null ? beam(depth - 1) : { score: transition.terminal * 1000000, line: [] }; }
      finally { board.undo(transition.undo); }
      if (!best || sign * child.score > sign * best.score) best = { score: child.score, line: [action, ...child.line] };
    }
    return best || { score: board.evaluate(), line: [] };
  }
  for (const action of candidates) {
    const transition = board.apply(action);
    try {
      const result = transition.terminal === null ? beam(4) : { score: transition.terminal * 1000000, line: [] };
      plans.push({ action, score: result.score, line: [action, ...result.line] });
    } catch (error) { if (error.message !== 'LAYOUT_LIMIT') throw error; break; }
    finally { board.undo(transition.undo); }
  }
  if (board.signature() !== root) throw new Error('Layout analysis did not restore the board');
  plans.sort((a, b) => (player === 0 ? b.score - a.score : a.score - b.score));
  const priority = plans.map(plan => plan.action);
  return { assessment, plans, order: [...priority, ...ordered.filter(action => !priority.includes(action))],
    nodes, milliseconds: Date.now() - started, horizon: 5, selective: true };
}
module.exports = { resourceValue, routeRisk, evaluatePosition, goalField, wallOpportunities, layoutAssessment, planLayout };
