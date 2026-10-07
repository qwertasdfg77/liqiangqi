const assert = require('node:assert/strict');
const { createApp, reusableAddress, addressPath } = require('../app/server.cjs');
const { initialState } = require('../app/game.cjs');
const { Board } = require('../app/engine.cjs');
async function run() {
  const app = createApp({ milliseconds: 180, workers: 2 });
  const url = await app.listen();
  assert.ok(await reusableAddress(url));
  assert.equal(await reusableAddress('https://example.com'), false);
  assert.equal(await reusableAddress('http://localhost:18741'), false);
  assert.notEqual(addressPath('C:\\test\\one'), addressPath('C:\\test\\two'));
  const get = async () => (await fetch(url + '/api/state')).json();
  const post = async (endpoint, body) => { const response = await fetch(url + '/api/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { code: response.status, data: await response.json() }; };
  async function wait() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { const state = await get(); if (!state.thinking) return state; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Computer did not finish');
  }
  try {
    assert.match(await (await fetch(url)).text(), /最高难度人机对弈/);
    let state = await get();
    const bad = await post('move', { revision: state.revision, action: 0 }); assert.equal(bad.code, 409); assert.equal((await get()).history.length, 0);
    const moved = await post('move', { revision: state.revision, action: 67 }); assert.equal(moved.code, 200);
    assert.equal(moved.data.thinking, true);
    const duplicate = await post('move', { revision: state.revision, action: 67 }); assert.equal(duplicate.code, 409);
    state = await wait(); assert.equal(state.history.length, 2); assert.equal(state.waitFor, state.human);
    assert.ok(state.lastAnalysis.hardBudget <= 180);
    const beforeBot = new Board({ ...initialState(), playerPos: [{ x: 4, y: 7 }, { x: 4, y: 0 }], waitFor: 1 });
    assert.ok(beforeBot.legalActions().includes(state.history[1].action));
    state = (await post('undo', { revision: state.revision })).data;
    assert.equal(state.history.length, 0); assert.deepEqual(state.playerPos, initialState().playerPos);
    state = (await post('move', { revision: state.revision, action: 67 })).data;
    state = (await post('new', { human: 0 })).data;
    await new Promise(resolve => setTimeout(resolve, 400));
    state = await get(); assert.equal(state.history.length, 0); assert.equal(state.thinking, false);
    state = (await post('new', { human: 1 })).data; assert.equal(state.thinking, true);
    state = await wait(); assert.equal(state.history.length, 1); assert.equal(state.waitFor, 1);
    assert.equal(state.lastAnalysis.retainedEntries, 0);
    const foreign = await fetch(url + '/api/new', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ human: 0 }) });
    assert.equal(foreign.status, 403);
  } finally { await app.close(); }
  const resumed = createApp({ human: 1, replay: [67], revisionStart: 100, milliseconds: 180, workers: 1 });
  try {
    await resumed.listen(); const state = resumed.snapshot();
    assert.equal(state.revision, 100); assert.equal(state.history.length, 1);
    assert.equal(state.human, 1); assert.equal(state.waitFor, 1); assert.equal(state.thinking, false);
    assert.deepEqual(state.playerPos[0], { x: 4, y: 7 });
  } finally { await resumed.close(); }
  const pending = { ...initialState(), playerPos: [{ x: 4, y: 0 }, { x: 5, y: 7 }], waitFor: 1, winnerId: [0], pendingReply: true };
  const ending = createApp({ initial: pending, human: 1, milliseconds: 50, workers: 1 });
  try {
    const endUrl = await ending.listen();
    let state = await (await fetch(endUrl + '/api/state')).json(); assert.equal(state.thinking, false);
    state = await (await fetch(endUrl + '/api/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.revision, action: 77 }) })).json();
    assert.equal(state.isOver, true); assert.deepEqual(state.winnerId, [0, 1]);
  } finally { await ending.close(); }
  console.log('PASS Automatic replies, computer opening, illegal/stale clicks, undo, cancellation, local endpoints and actual shared finish');
}
run().catch(cause => { console.error(cause); process.exitCode = 1; });
