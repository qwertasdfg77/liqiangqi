const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SearchSession, choose } = require('../app/ai.cjs');
const { Board, Search, WIN, mirrorAction } = require('../app/engine.cjs');
const { initialState, applyAction } = require('../app/game.cjs');
const { timePlan, stableChoice } = require('../app/time-control.cjs');
function reference(state, depth) { return new Search({ milliseconds: 15000 }).minimax(new Board(state), depth); }
function chosenScore(state, result) {
  const board = new Board(state), applied = board.apply(result.action);
  return applied.terminal === null ? new Search({ milliseconds: 15000 }).minimax(board, result.depth - 1) : applied.terminal * WIN;
}
async function main() {
  const opening = applyAction(initialState(), 67), board = new Board(opening);
  const calm = timePlan(board, 30000), contact = timePlan(new Board({ ...initialState(), playerPos: [{ x: 4, y: 5 }, { x: 4, y: 3 }] }), 30000);
  assert.equal(calm.kind, 'simple'); assert.equal(contact.kind, 'critical');
  assert.ok(contact.minimumDepth > calm.minimumDepth); assert.ok(contact.minimum > calm.minimum);
  assert.equal(calm.hard, 30000); assert.equal(contact.hard, 30000);
  assert.equal(timePlan(board, 180).soft, 108);
  const stable = [1, 2, 3, 4, 5, 6].map(depth => ({ depth, action: 13, score: depth % 2 ? 0 : 100 }));
  assert.equal(stableChoice(stable.slice(0, 5), calm), true);
  assert.equal(stableChoice(stable.slice(0, 5), contact), false);
  assert.equal(stableChoice(stable, contact), true);
  assert.equal(stableChoice([...stable.slice(0, 4), { depth: 5, action: 14, score: 0 }], calm), false);
  assert.equal(stableChoice([...stable.slice(0, 4), { depth: 5, action: 13, score: 80 }], calm), false);
  const session = new SearchSession({ workers: 1 });
  const fixed = { milliseconds: 15000, adaptive: false, maxDepth: 4, exact: false };
  const cases = [];
  try {
    const cold = await session.choose(opening, fixed).promise;
    const warm = await session.choose(opening, fixed).promise;
    assert.equal(cold.score, reference(opening, 4)); assert.equal(warm.score, cold.score);
    assert.equal(chosenScore(opening, warm), cold.score);
    assert.ok(warm.reusedHits > 0); assert.ok(warm.nodes < cold.nodes);
    cases.push({ case: 'same-position', coldNodes: cold.nodes, warmNodes: warm.nodes, reusedHits: warm.reusedHits });
    const following = applyAction(applyAction(opening, cold.action), 58);
    const continued = await session.choose(following, { ...fixed, maxDepth: 2 }).promise;
    assert.equal(continued.score, reference(following, 2)); assert.equal(chosenScore(following, continued), continued.score);
    assert.ok(continued.reusedHits > 0); cases.push({ case: 'next-round', reusedHits: continued.reusedHits });
    const reflected = { ...following, playerPos: following.playerPos.map(pos => ({ x: 8 - pos.x, y: pos.y })) };
    const mirror = await session.choose(reflected, { ...fixed, maxDepth: 2 }).promise;
    assert.equal(mirror.score, continued.score); assert.equal(chosenScore(reflected, mirror), mirror.score);
    assert.ok(new Board(reflected).legalActions().includes(mirrorAction(continued.action)));
    const walled = applyAction(initialState(), 81);
    const changed = await session.choose(walled, { ...fixed, maxDepth: 2 }).promise;
    assert.equal(changed.score, reference(walled, 2)); assert.equal(chosenScore(walled, changed), changed.score);
    const interrupted = session.choose(opening, { ...fixed, maxDepth: 32 });
    await new Promise(resolve => setTimeout(resolve, 100)); interrupted.cancel();
    const replacement = session.choose(walled, { ...fixed, maxDepth: 2 });
    assert.equal(await interrupted.promise, null);
    const resumed = await replacement.promise;
    assert.equal(resumed.score, reference(walled, 2)); assert.equal(chosenScore(walled, resumed), resumed.score);
    await session.reset();
    const cleared = await session.choose(walled, { ...fixed, maxDepth: 2 }).promise;
    assert.equal(cleared.retainedEntries, 0); assert.equal(cleared.reusedHits, 0);
    assert.equal(cleared.score, reference(walled, 2));
  } finally { await session.close(); }
  const progress = [];
  // Give worker startup and the 100 ms phase timer enough scheduling margin.
  // A 220 ms deadline can expire before its first post-soft-budget tick.
  const timed = await choose(opening, { milliseconds: 1000, workers: 2, onProgress: value => progress.push(value) }).promise;
  assert.equal(timed.reason, 'time-limit'); assert.ok(timed.milliseconds < 2500);
  assert.ok(progress.some(value => value.phase === 'extended'));
  assert.ok(new Board(opening).legalActions().includes(timed.action));
  const report = { cacheCases: cases, fixedDepthMovesMatchReference: true, symmetryAndWallStockIsolation: true,
    cancelledSearchCannotAffectNextJob: true, resetClearsCache: true, criticalPositionGetsMoreTime: true,
    equalParityStability: true, hardDeadlineMilliseconds: timed.milliseconds };
  fs.writeFileSync(path.join(__dirname, '../reports', 'adaptive-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(cause => { console.error(cause); process.exitCode = 1; });
