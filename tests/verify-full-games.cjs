const assert = require('node:assert/strict');
const { createApp } = require('../app/server.cjs');
const { Board, sourceApply, initial, plain } = require('./reference-rules.cjs');
async function main() {
  const results = [];
  for (const human of [0, 1]) {
    const app = createApp({ milliseconds: 180, workers: 2, human });
    const url = await app.listen();
    let source = initial(), replayed = 0, humanTurns = 0;
    const seen = new Map();
    try {
      for (let attempt = 0; attempt < 2500; attempt++) {
        const state = await (await fetch(url + '/api/state')).json();
        for (const entry of state.history.slice(replayed)) {
          assert.equal(source.waitFor, entry.player);
          source = sourceApply(source, entry.action); replayed++;
        }
        for (const key of ['playerPos', 'leftWalls', 'walls', 'waitFor', 'winnerId', 'isOver']) assert.deepEqual(state[key], plain(source[key]));
        assert.equal(state.error, '');
        if (state.isOver) {
          assert.ok(state.winnerId.length > 0); assert.equal(state.actions.length, 0);
          results.push({ human, plies: replayed, winners: state.winnerId, walls: state.walls.length }); break;
        }
        if (state.thinking) { await new Promise(resolve => setTimeout(resolve, 15)); continue; }
        assert.equal(state.waitFor, human);
        const board = new Board(state);
        const wall = [81, 152][humanTurns];
        let action = wall !== undefined && state.actions.includes(wall) ? wall : null;
        if (action === null) {
          const moves = board.pawnMoves().map(move => {
            const applied = board.apply(move);
            const penalty = (seen.get(board.signature()) || 0) * 10;
            const distance = board.distance(human);
            board.undo(applied.undo); return { move, value: distance + penalty };
          }).sort((a, b) => a.value - b.value);
          action = moves[0].move;
        }
        humanTurns++;
        const applied = board.apply(action), signature = board.signature(); board.undo(applied.undo);
        seen.set(signature, (seen.get(signature) || 0) + 1);
        const response = await fetch(url + '/api/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, revision: state.revision }) });
        assert.equal(response.status, 200);
        assert.ok(replayed < 200, 'Automated test game exceeded its move limit');
      }
      assert.equal(results.length, human + 1, 'Full game did not finish');
    } finally { await app.close(); }
  }
  console.log(JSON.stringify({ completeGames: results, eachMoveComparedWithIndependentReference: true }));
}
main().catch(cause => { console.error(cause); process.exitCode = 1; });
