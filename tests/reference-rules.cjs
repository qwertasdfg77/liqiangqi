// Independent, deliberately simple rule oracle: arrays and breadth-first paths.
// No production move generator, bitboards or website source are used here.
const assert = require('node:assert/strict');
const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const plain = value => JSON.parse(JSON.stringify(value));
const inside = ({x,y}) => x >= 0 && x < 9 && y >= 0 && y < 9;
const same = (a,b) => a.x === b.x && a.y === b.y;
const shift = (p,[x,y]) => ({x:p.x+x, y:p.y+y});
function initial() {
  return {firstId:0, waitFor:0, playerPos:[{x:4,y:8},{x:4,y:0}],
    leftWalls:[10,10], walls:[], winnerId:[], isOver:false, pendingReply:false};
}
function open(a,b,walls) {
  if (!inside(a) || !inside(b)) return false;
  return !walls.some(wall => wall.d === 0
    ? a.x === b.x && Math.min(a.y,b.y) === wall.y && a.x >= wall.x && a.x <= wall.x+1
    : a.y === b.y && Math.min(a.x,b.x) === wall.x && a.y >= wall.y && a.y <= wall.y+1);
}
function pawnMoves(state) {
  if (state.isOver) return [];
  const start = state.playerPos[state.waitFor], other = state.playerPos[1-state.waitFor], moves=[];
  for (const direction of directions) {
    const adjacent = shift(start,direction);
    if (!open(start,adjacent,state.walls)) continue;
    if (!same(adjacent,other)) { moves.push(adjacent); continue; }
    const jump = shift(other,direction);
    if (open(other,jump,state.walls)) moves.push(jump);
    else for (const side of [[direction[1],-direction[0]],[-direction[1],direction[0]]]) {
      const diagonal = shift(other,side);
      if (open(other,diagonal,state.walls)) moves.push(diagonal);
    }
  }
  return [...new Map(moves.map(p=>[p.x+9*p.y,p])).values()];
}
function reachable(position, goal, walls) {
  const queue=[position], seen=new Set([position.x+9*position.y]);
  for (let cursor=0; cursor<queue.length; cursor++) {
    const cell=queue[cursor]; if (cell.y === goal) return true;
    for (const d of directions) {
      const next=shift(cell,d), id=next.x+9*next.y;
      if (!seen.has(id) && open(cell,next,walls)) { seen.add(id); queue.push(next); }
    }
  }
  return false;
}
function wallLegal(state,x,y,d) {
  if (state.isOver || state.leftWalls[state.waitFor] <= 0 || x<0 || x>7 || y<0 || y>7 || ![0,1].includes(d)) return false;
  const conflicts=state.walls.some(w=>w.d === d
    ? (d === 0 ? w.y === y && Math.abs(w.x-x)<2 : w.x === x && Math.abs(w.y-y)<2)
    : w.x === x && w.y === y);
  if (conflicts) return false;
  const walls=[...state.walls,{x,y,d}];
  return reachable(state.playerPos[0],0,walls) && reachable(state.playerPos[1],8,walls);
}
function legalActions(state) {
  const actions=pawnMoves(state).map(p=>p.x+9*p.y);
  if (!state.isOver && state.leftWalls[state.waitFor]>0) for (let d=0; d<2; d++) for (let y=0; y<8; y++) for (let x=0; x<8; x++)
    if (wallLegal(state,x,y,d)) actions.push(81+x+8*y+64*d);
  return actions;
}
function sourceApply(state,action) {
  assert.ok(Number.isInteger(action) && legalActions(state).includes(action), 'Reference rejects illegal action '+action);
  const next=plain(state), player=state.waitFor;
  if (action<81) {
    next.playerPos[player]={x:action%9,y:Math.floor(action/9)};
    if (next.playerPos[player].y === (player === 0 ? 0 : 8) && !next.winnerId.includes(player)) next.winnerId.push(player);
  } else {
    const index=(action-81)%64;
    next.walls.push({x:index%8,y:Math.floor(index/8),d:Math.floor((action-81)/64),p:player}); next.leftWalls[player]--;
  }
  next.waitFor=state.winnerId.includes(1-player) ? player : 1-player;
  const pending=state.pendingReply || (!state.isOver && state.winnerId.includes(0));
  next.isOver=Boolean(pending || player === 1 && next.winnerId.includes(1));
  next.pendingReply=!next.isOver && player === 0 && next.winnerId.includes(0);
  return next;
}
// Small adapters retained by the regression tests migrated from the private lab.
const rules={KD:pawnMoves, Db:state=>legalActions(state).filter(a=>a>=81).map(a=>({x:(a-81)%8,y:Math.floor(((a-81)%64)/8),d:Math.floor((a-81)/64)})),s5:wallLegal};
module.exports={initial,plain,sourceApply,rules,legalActions,Board:require('../app/engine.cjs').Board};
