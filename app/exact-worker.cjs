const { parentPort, workerData } = require('node:worker_threads');
const { Board } = require('./engine.cjs');
const { solveFixedWalls } = require('./fixed-wall-oracle.cjs');
const state = workerData.state, board = new Board(state), seen = new Map(workerData.seen);
const label = solveFixedWalls(state.walls).query(state);
const score = action => {
  const result = board.apply(action), repetitions = seen.get(board.signature()) || 0;
  const cost = repetitions * 1000 + (result.terminal === 0 ? -100 : board.distance(state.waitFor));
  board.undo(result.undo); return cost;
};
const choices = [...label.preferredActions].sort((a, b) => score(a) - score(b));
parentPort.postMessage({ action: choices[0], source: 'exact-endgame', value: label.value, rank: label.rank });
