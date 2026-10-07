const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { PonderSession, predictionScore, rankPredictions, allocatedSlice } = require('../app/ponder.cjs');
const { SearchSession } = require('../app/ai.cjs');
const { Game, initialState } = require('../app/game.cjs');
const { Board, Search } = require('../app/engine.cjs');
const fixtures = require('./fixtures/search-states.json').filter(item => item.domain === 'global');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (predicate()) return; await delay(10); }
  throw new Error('Dynamic pondering timed out');
}
function candidate(action, staticRank, score, depth = 2) {
  return { action, staticRank, seed: { result: { score: 999999, depth,
    iterations: [{ depth: 2, action: 13, score }, { depth: 3, action: 14, score: -90000 }] } } };
}
async function main() {
  const a = candidate(67, 0, 10, 3), b = candidate(163, 9, 20, 6), unknown = { action: 75, staticRank: 1 };
  assert.equal(predictionScore(a, 0), 10, 'Use common completed depth, not current score');
  assert.equal(predictionScore(b, 1), -20, 'Rank for the human side');
  assert.deepEqual(rankPredictions([a, b, unknown], 0).map(item => item.action), [163, 67, 75]);
  assert.deepEqual(rankPredictions([a, b], 1).map(item => item.action), [67, 163]);
  const partial = { action: 67, staticRank: 0, seed: { result: { score: 1000000, depth: 1,
    iterations: [{ depth: 1, score: 1000000 }], partialIteration: { depth: 2, completed: [{ score: 1000000 }] } } } };
  assert.equal(predictionScore(partial, 0), null);
  const proven = { seed: { result: { source: 'parallel-alpha-beta', reason: 'proven-win', score: 1000000, depth: 1 } } };
  assert.equal(predictionScore(proven, 0), 1000000); assert.equal(predictionScore(proven, 1), -1000000);
  const stable = { seed: { result: { iterations: [1,2,3,4,5].map(depth => ({ depth, action: 13, score: depth % 2 ? 0 : 100 })) } } };
  assert.equal(allocatedSlice(stable, 1500), 750);
  stable.seed.result.iterations[4].action = 14;
  assert.equal(allocatedSlice(stable, 1500), 1875);

  const real = fixtures[2], game = new Game(0, real.state), original = game.snapshot();
  const order = new Board(real.state).orderedActions(); assert.equal(order.indexOf(163), 9);
  const session = new SearchSession({ workers: 2 });
  const predictions = new PonderSession(session, { milliseconds: 5000, deepSlice: 150, mediumSlice: 100, coverSlice: 200 });
  try {
    predictions.start(game, 10);
    await until(() => predictions.epoch.focused.some(item => item.action === 163 && predictionScore(item, 0) !== null));
    assert.ok(predictions.epoch.promoted.has(163));
    const promoted = predictions.epoch.candidates.find(item => item.action === 163);
    assert.equal(predictionScore(promoted, 0), new Search({ milliseconds: 5000 }).minimax(new Board(promoted.state), 2));
    assert.equal(promoted.seed.result.iterations.find(item => item.depth === 2).score,
      new Search({ milliseconds: 5000 }).minimax(new Board(promoted.state), 2));
    assert.deepEqual(game.snapshot(), original);
    assert.ok(predictions.snapshot().rankingUpdates > 0);
    assert.equal(predictions.epoch.candidates.length, order.length, 'All legal predictions stay available');
    const stopped = predictions.take(promoted.state, promoted.seen); assert.equal(stopped.key, promoted.key);
    assert.equal(session.active, null); await delay(30); assert.equal(predictions.epoch, null);
    const depth = stopped.result.depth + 1;
    const resumed = await session.choose(promoted.state, { milliseconds: 15000, adaptive: false,
      maxDepth: depth, exact: false, resume: stopped, seen: promoted.seen }).promise;
    assert.equal(resumed.depth, depth);
    assert.equal(resumed.score, new Search({ milliseconds: 15000 }).minimax(new Board(promoted.state), depth));
  } finally { predictions.stop(); await session.close(); }

  // A scored tie broadens the deep set. Ready lines release slots, and a
  // newly ranked move replaces an old focus line without pruning legal actions.
  const fake = new PonderSession({ pool: [] });
  const candidates = Array.from({ length: 20 }, (_, index) => candidate(index, index, index < 8 ? 100 : 0));
  const epoch = { human: 0, candidates, focused: [], rankingUpdates: 0, promoted: new Set(),
    expansion: 12, nextStage: 'analysis', queue: [] };
  fake.refreshRanking(epoch); assert.equal(epoch.deepCount, 4);
  candidates[0].seed = { ...candidates[0].seed, budget: 30000, milliseconds: 30000 };
  fake.refill(epoch); assert.ok(!epoch.queue.some(task => task.candidate === candidates[0]));
  assert.equal(epoch.queue.filter(task => task.depth === 32).length, 4);
  candidates[12].seed.result.iterations[0].score = 200;
  fake.refreshRanking(epoch); assert.equal(epoch.focused[0].action, 12); assert.ok(epoch.promoted.has(12));
  candidates[0].seed.result.iterations[0].score = -1000;
  candidates[0].seed.milliseconds = 0;
  fake.refreshRanking(epoch); assert.ok(epoch.focused.includes(candidates[0]), 'Keep preparing the original leading human move');
  epoch.nextStage = 'analysis'; fake.refill(epoch);
  assert.equal(epoch.queue[0].candidate, candidates[0]);
  assert.ok(epoch.queue.some(task => task.candidate === candidates[12] && task.depth === 32));
  assert.equal(candidates.length, 20);
  const report = { sameDepthScoresOnly: true, bothPlayerSigns: true, partialBoundsIgnored: true,
    stableAndUnstableSlices: [750, 1875], tiesBroadenDeepSet: true, readyLinesReleaseSlots: true,
    actualPromotedMove: { fixture: real.name, action: 163, oldRank: 10 },
    unchangedGameAndSafeCancellation: true, allLegalMovesRetained: true, originalLeadingMoveStillPrepared: true };
  fs.writeFileSync(path.join(__dirname, '../reports', 'dynamic-ponder-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
