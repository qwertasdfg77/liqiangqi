const { initialState, applyAction } = require('../app/game.cjs');
const { Board } = require('../app/engine.cjs');
function replay(actions) {
  return actions.reduce((state, action) => applyAction(state, action), initialState());
}
const walls = [];
for (const y of [0, 2, 4, 6]) for (const x of [0, 2, 5, 7]) walls.push(81 + x + 8 * y);
const fixtures = [
  { name: 'opening', state: initialState(), depth: 4 },
  { name: 'contact', state: replay([67,13,58,22,49,31]), depth: 4 },
  { name: 'many-walls', state: replay(walls), depth: 5 },
  { name: 'near-finish', state: { ...initialState(), waitFor: 1,
    playerPos: [{ x: 3, y: 2 }, { x: 5, y: 6 }], leftWalls: [6,6],
    walls: [{x:3,y:1,d:0,p:0},{x:5,y:6,d:0,p:1},{x:3,y:4,d:1,p:0},{x:6,y:3,d:1,p:1}] }, depth: 4 }
];
for (const fixture of fixtures) for (const player of [0,1]) {
  if (!Number.isFinite(new Board(fixture.state).distance(player))) throw new Error('Invalid fixture');
}
function randomStates(count = 160) {
  const states = []; let seed = 19385707, state = initialState();
  for (let ply = 0; states.length < count; ply++) {
    if (ply % 3 === 0) states.push(state);
    const actions = new Board(state).legalActions();
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const action = actions[seed % actions.length];
    state = applyAction(state, action);
    if (state.isOver || state.pendingReply || ply % 80 === 79) state = initialState();
  }
  return states;
}
module.exports = { fixtures, randomStates, replay };
