const assert = require('node:assert/strict');
const { estimateWinrate } = require('../app/winrate.cjs');
const { initialState, applyAction } = require('../app/game.cjs');
const { choose } = require('../app/ai.cjs');
const { createApp } = require('../app/server.cjs');
const { WIN } = require('../app/engine.cjs');

async function main() {
  const initial = initialState();
  assert.equal(estimateWinrate(initial, 0).human, 50);
  let previous = 0;
  for (const score of [-5000, -200, -100, 0, 100, 200, 5000]) {
    const analysis = { score, depth: 5 };
    const first = estimateWinrate(initial, 0, analysis), second = estimateWinrate(initial, 1, analysis);
    assert.ok(first.human >= 1 && first.human <= 99 && first.human >= previous);
    assert.ok(Math.abs(first.human + first.computer - 100) < 0.0001);
    assert.equal(first.human, second.computer); assert.equal(first.computer, second.human);
    assert.equal(estimateWinrate(initial, 0, analysis, 1).depth, 4);
    previous = first.human;
  }
  assert.equal(estimateWinrate(initial, 0, { score: WIN }).human, 100);
  assert.equal(estimateWinrate(initial, 1, { source: 'exact-endgame', value: -1 }).human, 100);
  const unforced = estimateWinrate(initial, 0, { source: 'exact-endgame', value: 0 });
  assert.equal(unforced.kind, 'no-forced-winner'); assert.equal(unforced.human, null);
  const pending = applyAction({ ...initial, playerPos: [{ x: 4, y: 1 }, { x: 5, y: 7 }] }, 4);
  assert.equal(estimateWinrate(pending, 0).kind, 'pending');
  const shared = applyAction(pending, 77);
  assert.deepEqual([estimateWinrate(shared, 0).human, estimateWinrate(shared, 0).computer], [100, 100]);
  const sole = applyAction(pending, 91);
  assert.deepEqual([estimateWinrate(sole, 1).human, estimateWinrate(sole, 1).computer], [0, 100]);

  const opening = applyAction(initial, 67), updates = [];
  const result = await choose(opening, { workers: 2, milliseconds: 15000, maxDepth: 4,
    adaptive: false, exact: false, onProgress: update => updates.push(update) }).promise;
  assert.equal(result.depth, 4);
  assert.ok(updates.some(update => update.depth >= 2 && Number.isFinite(update.score)));
  for (const update of updates) {
    if (!update.depth) { assert.equal(update.score, null); continue; }
    assert.equal(update.score, result.iterations.find(iteration => iteration.depth === update.depth).score,
      'A displayed score must come from an entirely completed root depth');
  }

  const app = createApp({ workers: 1, milliseconds: 1000, adaptive: false });
  try {
    const url = await app.listen();
    const get = async () => (await fetch(url + '/api/state')).json();
    const post = async (endpoint, body) => {
      const response = await fetch(url + '/api/' + endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200); return response.json();
    };
    let state = await get(); assert.equal(state.winrate.human, 50);
    state = await post('move', { revision: state.revision, action: 67 });
    assert.equal(state.winrate.positionRevision, state.revision);
    assert.equal(state.winrate.source, 'position');
    assert.ok(state.winrate.human > 50);
    const deadline = Date.now() + 8000; let liveSearchSeen = false;
    while (state.thinking && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20)); state = await get();
      assert.equal(state.winrate.positionRevision, state.revision);
      if (state.thinking && state.winrate.source === 'search') liveSearchSeen = true;
    }
    assert.equal(state.thinking, false); assert.ok(liveSearchSeen);
    assert.equal(state.winrate.depth, Math.max(0, state.lastAnalysis.depth - 1));
    state = await post('undo', { revision: state.revision });
    assert.equal(state.winrate.human, 50); assert.equal(state.winrate.source, 'position');
    state = await post('move', { revision: state.revision, action: 67 });
    state = await post('undo', { revision: state.revision });
    await new Promise(resolve => setTimeout(resolve, 1200)); state = await get();
    assert.equal(state.winrate.human, 50); assert.equal(state.history.length, 0);
    assert.equal(state.winrate.positionRevision, state.revision);
  } finally { await app.close(); }
  const ending = createApp({ initial: pending, human: 1 });
  try {
    const url = await ending.listen(); const before = ending.snapshot();
    const response = await fetch(url + '/api/move', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: before.revision, action: 77 }) });
    const finished = await response.json();
    assert.equal(finished.winrate.kind, 'finished');
    assert.deepEqual([finished.winrate.human, finished.winrate.computer], [100, 100]);
  } finally { await ending.close(); }
  console.log('PASS winner perspective, bounded estimates, completed-depth live updates, shared wins, exact unresolved endings and cancellation without stale estimates');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
