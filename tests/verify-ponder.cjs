const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SearchSession, analysisKey, finishedSeed } = require('../app/ai.cjs');
const { PonderSession } = require('../app/ponder.cjs');
const { Board, Search, WIN } = require('../app/engine.cjs');
const { Game, initialState, applyAction } = require('../app/game.cjs');
const { createApp } = require('../app/server.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await delay(20); }
  throw new Error('Ponder verification timed out');
}
async function main() {
  const opening = applyAction(initialState(), 67), seen = new Map([[new Board(opening).signature(), 1]]);
  const search = new SearchSession({ workers: 2 });
  const options = { milliseconds: 15000, maxDepth: 2, adaptive: false, exact: false, seen };
  try {
    const shallow = search.choose(opening, options); await shallow.promise;
    const seed = shallow.checkpoint(); assert.equal(seed.result.depth, 2);
    assert.equal(seed.result.reason, 'depth-limit'); assert.equal(finishedSeed(seed, 15000, true), false);
    await delay(50); assert.equal(shallow.checkpoint().milliseconds, seed.milliseconds, 'Idle time is not computation');
    const result = await search.choose(opening, { ...options, maxDepth: 4, resume: seed }).promise;
    assert.equal(result.resumed, true); assert.equal(result.precomputedDepth, 2);
    assert.deepEqual(result.iterations.map(item => item.depth), [1, 2, 3, 4]);
    const reference = new Search({ milliseconds: 15000 }).minimax(new Board(opening), 4);
    assert.equal(result.score, reference);
    const board = new Board(opening), transition = board.apply(result.action);
    assert.equal(transition.terminal === null ? new Search({ milliseconds: 15000 }).minimax(board, 3) : transition.terminal * WIN, reference);
    const changedHistory = new Map(seen); changedHistory.set(new Board(initialState()).signature(), 3);
    assert.notEqual(analysisKey(opening, changedHistory), seed.key);
    for (const altered of [ { ...opening, leftWalls: [9, 10] },
      { ...opening, playerPos: [{ x: 3, y: 7 }, opening.playerPos[1]] },
      applyAction(opening, 81), { ...opening, pendingReply: true }, { ...opening, winnerId: [0] } ])
      assert.notEqual(analysisKey(altered, seen), seed.key);
    const rejected = await search.choose(opening, { ...options, seen: changedHistory, resume: seed }).promise;
    assert.equal(rejected.resumed, false);
    const timed = search.choose(opening, { ...options, milliseconds: 300, maxDepth: 32 });
    await timed.promise; const ready = timed.checkpoint();
    assert.equal(ready.result.reason, 'time-limit'); assert.ok(ready.result.depth > 0);
    assert.equal(finishedSeed(ready, 300, false), true);
    await delay(50); assert.equal(timed.checkpoint().milliseconds, ready.milliseconds);
    const reused = await search.choose(opening, { ...options, milliseconds: 300, maxDepth: 32, resume: ready }).promise;
    assert.equal(reused.ponderReady, true); assert.equal(reused.action, ready.result.action);
    assert.ok(reused.foregroundMilliseconds < 100);
    const interrupted = search.choose(opening, { ...options, maxDepth: 32, sliceMilliseconds: 120 });
    await delay(60); const partial = interrupted.checkpoint(); interrupted.cancel();
    assert.equal(await interrupted.promise, null);
    if (partial) assert.ok(partial.result.depth <= partial.result.iterations.at(-1).depth);
    const next = await search.choose(applyAction(initialState(), 81), { ...options, seen: new Map() }).promise;
    assert.equal(next.resumed, false); assert.ok(Number.isFinite(next.score));
    let connected = true;
    const game = new Game(), before = game.snapshot();
    const predictions = new PonderSession(search, { milliseconds: 400, adaptive: false,
      coverSlice: 200, deepSlice: 200, mediumSlice: 100, shouldContinue: () => connected });
    predictions.start(game, 9);
    assert.equal(predictions.snapshot().total, before.actions.length);
    assert.equal(predictions.snapshot().focus, 6); assert.equal(predictions.snapshot().deep, 2);
    await until(() => predictions.snapshot().covered > 6);
    assert.deepEqual(game.snapshot(), before); assert.ok(search.pool.length <= 2);
    connected = false; await until(() => predictions.snapshot().phase === 'paused');
    const idle = predictions.snapshot().milliseconds; await delay(50);
    assert.equal(predictions.snapshot().milliseconds, idle);
    connected = true; predictions.start(game, 9);
    await until(() => predictions.snapshot().active);
    predictions.stop(); assert.equal(search.active, null);
    await delay(50); assert.equal(predictions.snapshot().phase, 'disabled');
  } finally { await search.close(); }

  const sliced = new SearchSession({ workers: 1 });
  try {
    let calculation, partial;
    calculation = sliced.choose(opening, { ...options, maxDepth: 4, onProgress: () => {
      const checkpoint = calculation?.checkpoint();
      if (!partial && checkpoint?.partialIteration?.depth === 4) {
        partial = checkpoint; calculation.cancel();
      }
    } });
    assert.equal(await calculation.promise, null); assert.ok(partial.partialIteration.completed.length > 0);
    const resumed = await sliced.choose(opening, { ...options, maxDepth: 4, resume: partial }).promise;
    assert.equal(resumed.depth, 4);
    assert.equal(resumed.score, new Search({ milliseconds: 15000 }).minimax(new Board(opening), 4));
  } finally { await sliced.close(); }

  const app = createApp({ milliseconds: 700, workers: 2, adaptive: false,
    ponderOptions: { coverSlice: 200, deepSlice: 250, mediumSlice: 100 } });
  const url = await app.listen();
  const get = async () => (await fetch(url + '/api/state')).json();
  const post = async (endpoint, body) => { const response = await fetch(url + '/api/' + endpoint,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { code: response.status, data: await response.json() }; };
  let foreground;
  try {
    const before = await get(); assert.equal(before.thinking, false); assert.equal(before.ponder.active, true);
    await until(async () => (await get()).ponder.ready >= 2);
    const prepared = await get(); assert.equal(prepared.revision, before.revision);
    assert.deepEqual(prepared.history, before.history); assert.deepEqual(prepared.winrate, before.winrate);
    assert.equal((await post('move', { revision: before.revision, action: 0 })).code, 409);
    assert.equal((await get()).ponder.positionRevision, before.revision);
    assert.equal((await post('move', { revision: 0, action: 67 })).code, 409);
    const started = Date.now();
    assert.equal((await post('move', { revision: before.revision, action: 67 })).code, 200);
    const after = await until(async () => { const state = await get(); return state.history.length === 2 && !state.thinking ? state : false; });
    foreground = Date.now() - started;
    assert.equal(after.lastAnalysis.resumed, true); assert.equal(after.lastAnalysis.ponderReady, true);
    assert.ok(foreground < 500); assert.equal(after.winrate.positionRevision, after.revision);
    assert.ok(new Board(opening).legalActions().includes(after.history[1].action));
    const undone = (await post('undo', { revision: after.revision })).data;
    assert.equal(undone.history.length, 0); assert.equal(undone.ponder.positionRevision, undone.revision);
    const moving = (await post('move', { revision: undone.revision, action: 67 })).data;
    const reset = (await post('new', { human: 0 })).data;
    assert.ok(reset.revision > moving.revision); await delay(1000);
    const clean = await get(); assert.equal(clean.history.length, 0); assert.equal(clean.thinking, false);
    assert.deepEqual(clean.winrate.score, before.winrate.score);
    assert.ok(clean.ponder.workers <= 2);
  } finally { await app.close(); }
  const terminal = createApp({ human: 1, initial: { ...initialState(), pendingReply: true,
    playerPos: [{ x: 4, y: 0 }, { x: 5, y: 7 }], waitFor: 1, winnerId: [0] } });
  try { await terminal.listen(); assert.equal(terminal.snapshot().ponder.phase, 'disabled'); }
  finally { await terminal.close(); }
  const report = { fullLegalPredictionRanking: true, focus: 6, deep: 2, expandsBeyondSix: true,
    sharedPoolLimit: 8, exactPositionAndHistoryRequired: true, resumedDepthMatchesReference: true,
    idleTimeExcluded: true, unchangedActualWinrateDuringPredictions: true,
    staleIllegalUndoResetClosePassed: true, cachedReplyMilliseconds: foreground };
  fs.writeFileSync(path.join(__dirname, '../reports', 'ponder-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
