const assert=require('node:assert/strict');
const data=require('./fixtures/rule-observations.json');
const game=require('../app/game.cjs'), reference=require('./reference-rules.cjs');
const fields=['playerPos','leftWalls','walls','waitFor','winnerId','isOver'];
for(const [index,item] of data.cases.entries()) {
  const state={...item.state,firstId:0,pendingReply:!item.state.isOver && item.state.winnerId.includes(0)};
  assert.deepEqual(game.legalActions(state).sort((a,b)=>a-b),item.legal,'Production legal moves at '+index);
  assert.deepEqual(reference.legalActions(state).sort((a,b)=>a-b),item.legal,'Reference legal moves at '+index);
  for(const actual of [game.applyAction(state,item.action),reference.sourceApply(state,item.action)])
    for(const field of fields) assert.deepEqual(actual[field],item.next[field],field+' at '+index);
}
console.log('PASS '+data.cases.length+' recorded rule positions and transitions (both implementations)');
