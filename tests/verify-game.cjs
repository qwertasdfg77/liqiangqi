const assert = require('node:assert/strict');
const { Game, initialState, legalActions, applyAction } = require('../app/game.cjs');
const { Board, Search, WIN } = require('../app/engine.cjs');
const { choose } = require('../app/ai.cjs');
const { initial, rules, plain, sourceApply } = require('./reference-rules.cjs');
async function main() {
  let seed = 70719385, positions = 0;
  for (let episode = 0; episode < 25; episode++) {
    let source = initial(), state = initialState();
    for (let ply = 0; ply < 100 && !state.isOver; ply++) {
      const original = [...plain(rules.KD(source)).map(move => move.x + 9 * move.y),
        ...(source.leftWalls[source.waitFor] ? plain(rules.Db(source)).filter(wall => rules.s5(source, wall.x, wall.y, wall.d)).map(wall => 81 + wall.x + 8 * wall.y + 64 * wall.d) : [])];
      assert.deepEqual(legalActions(state).sort((a, b) => a - b), original.sort((a, b) => a - b));
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const candidates = seed % 3 === 0 ? original : original.filter(action => action < 81);
      const action = candidates[seed % candidates.length];
      state = applyAction(state, action); source = sourceApply(source, action);
      for (const key of ['playerPos', 'leftWalls', 'walls', 'waitFor', 'winnerId', 'isOver']) assert.deepEqual(state[key], plain(source[key]), key);
      assert.equal(state.pendingReply, !source.isOver && source.winnerId.includes(0)); positions++;
    }
  }
  const close = { ...initialState(), playerPos: [{ x: 4, y: 1 }, { x: 5, y: 7 }] };
  const pending = applyAction(close, 4);
  assert.equal(pending.pendingReply, true); assert.equal(pending.isOver, false);
  const shared = applyAction(pending, 77); assert.equal(shared.isOver, true); assert.deepEqual(shared.winnerId, [0, 1]);
  const declined = applyAction(pending, 91); assert.equal(declined.isOver, true); assert.deepEqual(declined.winnerId, [0]);
  const game = new Game();
  for (const action of [75, 3, 76, 4, 75, 3, 76, 4]) game.play(action);
  assert.equal(game.snapshot().repetition, 3); assert.equal(game.state.isOver, false);
  game.undo(); assert.equal(game.history.length, 6); assert.equal(game.state.waitFor, game.human);
  assert.throws(() => applyAction(initialState(), 0));
  const fixtures = [initialState(), { ...initialState(), waitFor: 1, playerPos: [{ x: 3, y: 6 }, { x: 4, y: 2 }], leftWalls: [1, 1], walls: [{ x: 3, y: 4, d: 0, p: 0 }] }];
  for (const state of fixtures) for (const depth of [2, 3]) {
    const board = new Board(state), reference = new Search({ milliseconds: 10000, maxEntries: 350000 });
    const expected = reference.minimax(board, depth);
    const calculation = choose(state, { milliseconds: 10000, workers: 3, maxDepth: depth, exact: false });
    const result = await calculation.promise;
    assert.equal(result.depth, depth); assert.equal(result.score, expected);
    const transition = board.apply(result.action);
    const actual = transition.terminal === null ? new Search({ milliseconds: 10000 }).minimax(board, depth - 1) : transition.terminal * WIN;
    assert.equal(actual, expected);
  }
  const cancellation = choose(initialState(), { milliseconds: 30000, workers: 2 }); cancellation.cancel();
  assert.equal(await cancellation.promise, null);
  const reply = await choose(pending).promise; assert.equal(reply.action, 77);
  console.log(JSON.stringify({ independentReferencePositions: positions, parallelSearchComparisons: 4, pendingFinalReply: true, repetitionNotDraw: true, cancellation: true }));
}
main().catch(cause => { console.error(cause); process.exitCode = 1; });
