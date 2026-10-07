const assert = require('node:assert/strict');
const { Board } = require('./engine.cjs');
const encode = (a, b, turn) => (a * 81 + b) * 2 + turn;
function layoutKey(walls) {
  const codes = walls.map(wall => wall.x + 8 * wall.y + 64 * wall.d).sort((a, b) => a - b);
  const mirrored = codes.map(code => 64 * Math.floor(code / 64) + 7 - code % 8 + 8 * Math.floor(code % 64 / 8)).sort((a, b) => a - b);
  return [codes.join(','), mirrored.join(',')].sort()[0];
}
function solveFixedWalls(walls) {
  const identity = walls.map(wall => wall.x + 8 * wall.y + 64 * wall.d).sort((a, b) => a - b).join(',');
  const board = new Board({ playerPos: [{ x: 4, y: 8 }, { x: 4, y: 0 }], leftWalls: [0, 0], waitFor: 0, walls });
  const reachable = [new Uint8Array(81), new Uint8Array(81)];
  for (const player of [0, 1]) for (let cell = 0; cell < 81; cell++) {
    board.pawns[player] = cell;
    reachable[player][cell] = Number.isFinite(board.distance(player));
  }
  const ids = new Int32Array(81 * 81 * 2).fill(-1), nodes = [];
  for (let a = 9; a < 81; a++) for (let b = 0; b < 72; b++) if (a !== b && reachable[0][a] && reachable[1][b]) {
    for (const turn of [0, 1]) {
      ids[encode(a, b, turn)] = nodes.length;
      nodes.push({ a, b, turn, edges: [] });
    }
  }
  const win0 = nodes.length, win1 = win0 + 1, shared = win0 + 2;
  const incoming = Array.from({ length: nodes.length + 3 }, () => []);
  for (let id = 0; id < nodes.length; id++) {
    const node = nodes[id]; board.pawns = [node.a, node.b]; board.turn = node.turn;
    for (const action of board.pawnMoves()) {
      const result = board.apply(action);
      const next = result.terminal === 1 ? win0 : result.terminal === -1 ? win1 : result.terminal === 0 ? shared
        : ids[encode(board.pawns[0], board.pawns[1], board.turn)];
      board.undo(result.undo);
      assert.ok(next >= 0);
      node.edges.push({ action, next }); incoming[next].push(id);
    }
    assert.ok(node.edges.length);
  }
  const values = new Int8Array(nodes.length + 3), ranks = new Int32Array(values.length);
  const remaining = Int16Array.from([...nodes.map(node => node.edges.length), 0, 0, 0]);
  const queue = [win0, win1]; values[win0] = 1; values[win1] = -1;
  for (let head = 0; head < queue.length; head++) {
    const child = queue[head];
    for (const parent of incoming[child]) {
      if (values[parent] !== 0) continue;
      const wanted = nodes[parent].turn === 0 ? 1 : -1;
      if (values[child] === wanted) {
        values[parent] = wanted; ranks[parent] = ranks[child] + 1; queue.push(parent);
      } else if (--remaining[parent] === 0) {
        values[parent] = -wanted;
        ranks[parent] = 1 + Math.max(...nodes[parent].edges.map(edge => ranks[edge.next]));
        queue.push(parent);
      }
    }
  }
  const histogram = { player0SoleWin: 0, player1SoleWin: 0, noForcedSoleWin: 0 };
  for (let id = 0; id < nodes.length; id++) {
    const node = nodes[id], children = node.edges.map(edge => values[edge.next]);
    assert.equal(values[id], node.turn === 0 ? Math.max(...children) : Math.min(...children));
    if (values[id]) {
      const wanted = node.turn === 0 ? 1 : -1;
      const decreases = edge => values[edge.next] === values[id] && ranks[edge.next] < ranks[id];
      assert.ok(values[id] === wanted ? node.edges.some(decreases) : node.edges.every(decreases));
    }
    histogram[values[id] === 1 ? 'player0SoleWin' : values[id] === -1 ? 'player1SoleWin' : 'noForcedSoleWin']++;
  }
  function query(state) {
    assert.ok(state.leftWalls.length === 2 && state.leftWalls.every(count => count === 0), 'Exact oracle requires both wall stocks to be exhausted');
    if (state.walls) assert.equal(state.walls.map(wall => wall.x + 8 * wall.y + 64 * wall.d).sort((a, b) => a - b).join(','), identity,
      'Query walls differ from the solved layout');
    const a = state.playerPos[0].x + 9 * state.playerPos[0].y, b = state.playerPos[1].x + 9 * state.playerPos[1].y;
    const id = ids[encode(a, b, state.waitFor)]; assert.ok(id >= 0, 'State is outside this nonterminal graph');
    const node = nodes[id], value = values[id];
    const optimal = node.edges.filter(edge => values[edge.next] === value);
    let preferred = optimal;
    if (value) {
      const winningTurn = value === (state.waitFor === 0 ? 1 : -1);
      const rank = (winningTurn ? Math.min : Math.max)(...optimal.map(edge => ranks[edge.next]));
      preferred = optimal.filter(edge => ranks[edge.next] === rank);
    }
    return { value, rank: value ? ranks[id] : null, action: preferred[0].action,
      optimalActions: optimal.map(edge => edge.action), preferredActions: preferred.map(edge => edge.action),
      actions: node.edges.map(edge => edge.action), nodeId: id };
  }
  return { walls, nodes, values, ranks, query, vertices: nodes.length,
    edges: nodes.reduce((sum, node) => sum + node.edges.length, 0), histogram };
}
module.exports = { solveFixedWalls, layoutKey };
