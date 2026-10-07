const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../app/server.cjs');
const { SearchSession } = require('../app/ai.cjs');
const { PonderSession } = require('../app/ponder.cjs');
const { difficultyProfile } = require('../app/difficulty.cjs');
const { initialState } = require('../app/game.cjs');
const calls = [], ponderBudgets = [];
const choose = SearchSession.prototype.choose, ponderStart = PonderSession.prototype.start;
SearchSession.prototype.choose = function(state, options) { calls.push({ budget: options.milliseconds, foreground: Boolean(options.onProgress) }); return choose.call(this, state, options); };
PonderSession.prototype.start = function(...args) { ponderBudgets.push(this.milliseconds); return ponderStart.apply(this, args); };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function run() {
  assert.equal(difficultyProfile('quick').milliseconds, 20000);
  assert.equal(difficultyProfile('highest').milliseconds, 30000);
  for (const key of ['easy', '__proto__', 'constructor', null, 20000]) assert.throws(() => difficultyProfile(key));
  const app = createApp({ workers: 2, ponderOptions: { maxMilliseconds: 1000 } });
  try {
    const url = await app.listen();
    const get = async () => (await fetch(url + '/api/state')).json();
    const post = async (endpoint, body) => {
      const response = await fetch(url + '/api/' + endpoint, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
      const data = await response.json();
      return { status:response.status, state:response.ok ? data : data.state };
    };
    const wait = async () => {
      const end = Date.now() + 35000;
      while (Date.now() < end) { const state = await get(); if (!state.thinking) { assert.equal(state.error, ''); return state; } await sleep(50); }
      throw new Error('Automatic reply did not finish');
    };
    let state = await get();
    assert.equal(state.difficulty.key, 'highest'); assert.equal(ponderBudgets.at(-1), 30000);
    const initial = state, callStart = calls.length;
    state = (await post('difficulty', { revision:state.revision, difficulty:'quick' })).state;
    assert.equal(state.difficulty.key, 'quick'); assert.deepEqual(state.history, initial.history);
    assert.deepEqual(state.playerPos, initial.playerPos); assert.equal(state.revision, initial.revision + 1);
    assert.equal(state.winrate.positionRevision, state.revision); assert.equal(ponderBudgets.at(-1), 20000);
    assert.ok(calls.slice(callStart).every(call => call.budget === 20000));
    const bad = await post('difficulty', { revision:state.revision, difficulty:'invalid' });
    assert.equal(bad.status, 409); assert.equal(bad.state.revision, state.revision);
    const stale = await post('difficulty', { revision:initial.revision, difficulty:'highest' });
    assert.equal(stale.status, 409); assert.equal(stale.state.difficulty.key, 'quick');
    const same = await post('difficulty', { revision:state.revision, difficulty:'quick' });
    assert.equal(same.state.revision, state.revision);
    state = (await post('move', { revision:state.revision, action:67 })).state;
    assert.equal(state.thinking, true); assert.ok(state.ai.hardBudget <= 20000);
    state = await wait(); assert.equal(state.history.length, 2);
    assert.equal(state.lastAnalysis.hardBudget, 20000);
    assert.equal(state.waitFor, state.human); assert.notEqual(state.lastAnalysis.reason, 'worker-fallback');
    const assessment = state.winrate;
    state = (await post('difficulty', { revision:state.revision, difficulty:'highest' })).state;
    for (const field of ['human', 'computer', 'source', 'depth', 'score', 'detail'])
      assert.deepEqual(state.winrate[field], assessment[field], 'Changing difficulty must preserve the current-position assessment');
    state = (await post('difficulty', { revision:state.revision, difficulty:'quick' })).state;
    state = (await post('undo', { revision:state.revision })).state;
    assert.equal(state.history.length, 0); assert.equal(state.difficulty.key, 'quick');
    state = (await post('new', { human:1, difficulty:'highest' })).state;
    assert.equal(state.thinking, true); assert.equal(state.ai.hardBudget, 30000);
    const thinking = state;
    state = (await post('difficulty', { revision:state.revision, difficulty:'quick' })).state;
    assert.equal(state.thinking, true); assert.equal(state.ai.hardBudget, 20000);
    assert.deepEqual(state.history, thinking.history); assert.deepEqual(state.playerPos, thinking.playerPos);
    state = await wait(); await sleep(150); state = await get();
    assert.equal(state.history.length, 1, 'The cancelled old job must never add a second computer move');
    assert.equal(state.waitFor, 1); assert.equal(state.difficulty.key, 'quick');
    assert.equal(state.lastAnalysis.hardBudget, 20000);
    const invalidNew = await post('new', { human:0, difficulty:'invalid' });
    assert.equal(invalidNew.status, 409); assert.deepEqual(invalidNew.state.history, state.history);
    state = (await post('new', { human:0 })).state;
    assert.equal(state.difficulty.key, 'quick', 'New games retain the selected tier');
    assert.deepEqual(state.playerPos, initialState().playerPos);
    state = (await post('difficulty', { revision:state.revision, difficulty:'highest' })).state;
    assert.equal(state.difficulty.milliseconds, 30000); assert.equal(ponderBudgets.at(-1), 30000);
    const foreground = calls.filter(call => call.foreground);
    assert.ok(foreground.some(call => call.budget === 20000)); assert.ok(foreground.some(call => call.budget === 30000));
    const report = { passed:true, defaultHighest:true, quickHardBudget:20000, highestHardBudget:30000,
      foregroundAndPonderUpdated:true, noBoardChangesOnSwitch:true, midSearchCancellation:true,
      noDuplicateComputerMove:true, staleAndInvalidRejected:true, undo:true, newGameRetainsTier:true,
      winratePreservedOnSwitch:true };
    fs.writeFileSync(path.join(__dirname, '../reports', 'difficulty-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await app.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
