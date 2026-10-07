const assert = require('node:assert/strict');
const { choose } = require('../app/ai.cjs');
const { solveFixedWalls } = require('../app/fixed-wall-oracle.cjs');
const fixtures = require('./fixtures/search-states.json').filter(item => item.domain === 'exact-endgame');
async function main() {
  for (const fixture of fixtures) {
    const expected = solveFixedWalls(fixture.state.walls).query(fixture.state);
    const result = await choose(fixture.state).promise;
    assert.ok(expected.preferredActions.includes(result.action));
    if (result.source === 'exact-endgame') {
      assert.equal(result.value, expected.value); assert.equal(result.rank, expected.rank);
    } else assert.equal(result.source, 'immediate-win');
  }
  const state = fixtures[0].state;
  const calculation = choose(state); calculation.cancel();
  assert.equal(await calculation.promise, null);
  console.log(JSON.stringify({ exactEndgames: fixtures.length, preferredMovesVerified: true, exactWorkerCancellation: true }));
}
main().catch(cause => { console.error(cause); process.exitCode = 1; });
