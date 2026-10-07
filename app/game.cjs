const { Board, describe } = require('./engine.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
function initialState() {
  return { firstId: 0, playerPos: [{ x: 4, y: 8 }, { x: 4, y: 0 }], leftWalls: [10, 10],
    waitFor: 0, walls: [], winnerId: [], isOver: false, pendingReply: false };
}
function legalActions(state) {
  return state.isOver ? [] : new Board(state).legalActions();
}
function applyAction(state, action) {
  if (!Number.isInteger(action) || !legalActions(state).includes(action)) throw new Error('这个位置不能落子或放墙。');
  const next = clone(state), player = next.waitFor, finalReply = next.pendingReply;
  if (action < 81) {
    next.playerPos[player] = { x: action % 9, y: Math.floor(action / 9) };
    if ((player === 0 && action < 9) || (player === 1 && action >= 72)) {
      if (!next.winnerId.includes(player)) next.winnerId.push(player);
    }
  } else {
    const wall = action - 81, index = wall % 64;
    next.walls.push({ x: index % 8, y: Math.floor(index / 8), d: Math.floor(wall / 64), p: player });
    next.leftWalls[player]--;
  }
  next.waitFor = state.winnerId.includes(1 - player) ? player : 1 - player;
  if (finalReply || (player === 1 && next.winnerId.includes(1))) {
    next.isOver = true; next.pendingReply = false;
  } else if (player === 0 && next.winnerId.includes(0)) next.pendingReply = true;
  return next;
}
function actionText(action) {
  if (action < 81) return `走到 ${describe(action)}`;
  const wall = action - 81, index = wall % 64;
  return `${wall < 64 ? '横墙' : '竖墙'} ${'ABCDEFGHI'[index % 8]}${9 - Math.floor(index / 8)}`;
}
class Game {
  constructor(human = 0, state = initialState()) {
    this.human = human; this.state = clone(state); this.history = [];
    this.seen = new Map(); this.rebuildSeen();
  }
  play(action, analysis = null) {
    const before = clone(this.state), player = before.waitFor;
    this.state = applyAction(before, action);
    this.history.push({ player, action, text: actionText(action), before, analysis });
    const key = new Board(this.state).signature(); this.seen.set(key, (this.seen.get(key) || 0) + 1);
  }
  canUndo() { return this.history.some(entry => entry.player === this.human); }
  undo() {
    const index = this.history.findLastIndex(entry => entry.player === this.human);
    if (index < 0) throw new Error('还没有可撤回的走法。');
    this.state = clone(this.history[index].before); this.history.splice(index); this.rebuildSeen();
  }
  rebuildSeen() {
    this.seen.clear();
    for (const entry of this.history) {
      const key = new Board(entry.before).signature(); this.seen.set(key, (this.seen.get(key) || 0) + 1);
    }
    const key = new Board(this.state).signature(); this.seen.set(key, (this.seen.get(key) || 0) + 1);
  }
  snapshot() {
    return { ...clone(this.state), human: this.human, computer: 1 - this.human,
      actions: legalActions(this.state), canUndo: this.canUndo(),
      repetition: this.seen.get(new Board(this.state).signature()) || 1,
      history: this.history.map(({ player, action, text }) => ({ player, action, text })) };
  }
}
module.exports = { Game, initialState, legalActions, applyAction, actionText };
