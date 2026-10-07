const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { Board, Search, WIN } = require('../app/engine.cjs');
const { SearchSession } = require('../app/ai.cjs');
const { resourceValue, goalField, layoutAssessment, planLayout } = require('../app/strategy.cjs');
const { fixtures, randomStates } = require('./fixtures.cjs');
const { Worker } = require('node:worker_threads');
async function main() {
  assert.ok(resourceValue(1,8,10) > resourceValue(4,8,10)-resourceValue(3,8,10));
  assert.ok(resourceValue(1,8,10) > resourceValue(1,1,10));
  for(let opponent=0;opponent<=10;opponent++)for(let stock=0;stock<10;stock++) {
    assert.ok(resourceValue(stock+1,opponent,10)>resourceValue(stock,opponent,10),'An extra wall always has positive value');
    assert.ok(resourceValue(stock,opponent,3)-resourceValue(stock,opponent,2)<100,'Reserve alone cannot reward delaying a pawn');
  }
  let distances = 0, keys = 0; const identities = new Map();
  for (const state of [...fixtures.map(item=>item.state), ...randomStates(40)]) {
    const board = new Board(state), signature = board.signature();
    for (const player of [0,1]) {
      const field = goalField(board,player), pawn = board.pawns[player];
      for (let cell=0;cell<81;cell++) { board.pawns[player]=cell; assert.equal(board.distance(player),field[cell]<0?Infinity:field[cell]); distances++; }
      board.pawns[player]=pawn;
    }
    const key = board.canonicalState().key;
    for (const action of board.legalActions()) {
      const transition = board.apply(action), compact = board.canonicalState().key, ordinary = board.canonicalState(false).key;
      if (identities.has(compact)) assert.equal(identities.get(compact),ordinary,'Exact compact identity has no false collisions');
      identities.set(compact,ordinary); keys++; board.undo(transition.undo);
      assert.equal(board.signature(),signature); assert.equal(board.canonicalState().key,key);
    }
  }
  const contact = new Board(fixtures[1].state), signature = contact.signature();
  const assessment = layoutAssessment(contact); assert.equal(contact.signature(),signature);
  const planned = planLayout(contact,{milliseconds:200,maxNodes:800});
  assert.deepEqual([...planned.order].sort((a,b)=>a-b),contact.legalActions().sort((a,b)=>a-b));
  assert.equal(contact.signature(),signature); assert.ok(planned.plans.length>0);
  let combinations = 0;
  for (const plan of planned.plans) {
    const undos=[];
    try {
      for (const action of plan.line) { assert.ok(contact.legalActions().includes(action)); undos.push(contact.apply(action).undo); }
      if(plan.line.filter((action,index)=>index%2===0&&action>=81).length>=2) combinations++;
    } finally { for(const undo of undos.reverse())contact.undo(undo); }
  }
  assert.ok(combinations>0,'Evaluate actual alternating multi-wall plans');
  planLayout(contact,{milliseconds:0,maxNodes:1}); assert.equal(contact.signature(),signature);
  let comparisons=0,researches=0;
  // Force both aspiration failures through the real worker protocol, rather
  // than relying on a particular fixture to happen to miss its window.
  const worker = new Worker(path.join(__dirname, '../app/ai-worker.cjs'),{workerData:{maxEntries:350000}});
  let nextMessage;
  const waitMessage = () => new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Worker verification timed out')),10000);
    nextMessage=value=>{clearTimeout(timer);nextMessage=null;resolve(value);};
  });
  worker.on('message',value=>nextMessage?.(value));
  try {
    const ready=await waitMessage();assert.equal(ready.type,'ready');
    const started=waitMessage();worker.postMessage({type:'start',runId:1,state:fixtures[1].state,deadline:Date.now()+20000,abort:new SharedArrayBuffer(4)});
    assert.equal((await started).type,'started');
    const action=new Board(fixtures[1].state).pawnMoves()[0],board=new Board(fixtures[1].state),transition=board.apply(action);
    const expected=transition.terminal===null?new Search({milliseconds:15000}).minimax(board,2):transition.terminal*WIN;
    for(const center of [-500000,500000]) {
      const response=waitMessage();worker.postMessage({type:'search',runId:1,depth:3,action,alpha:-2*WIN,beta:2*WIN,aspiration:center});
      const value=await response;assert.equal(value.score,expected);assert.equal(value.bound,'exact');assert.equal(value.aspirationResearches,1);researches++;
    }
  } finally { await worker.terminate(); }
  for(const config of [ {}, {aspiration:false,dynamicOrdering:false,compactKeys:false,strategyPlanning:false} ]) {
    const session=new SearchSession({workers:2,...config});
    try {
      for(const fixture of fixtures) {
        const result=await session.choose(fixture.state,{milliseconds:20000,maxDepth:4,adaptive:false,exact:false}).promise;
        const board=new Board(fixture.state),reference=new Search({milliseconds:60000,pvs:false}).minimax(board,4);
        assert.equal(result.score,reference,fixture.name);
        const transition=board.apply(result.action);
        const actual=transition.terminal===null?new Search({milliseconds:60000,pvs:false}).minimax(board,3):transition.terminal*WIN;
        assert.equal(actual,reference); comparisons++;researches+=result.aspirationResearches||0;
      }
    } finally { await session.close(); }
  }
  const report={distanceValues:distances,exactKeyTransitions:keys,referenceSearches:comparisons,
    aspirationResearches:researches,reserveRespondsToOpponent:true,alternatingWallCombinations:combinations,
    allLegalMovesRetained:true,plannerCancellationRestoresBoard:true,rootAssessment:assessment};
  fs.writeFileSync(path.join(__dirname, '../reports', 'strategy-verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,rootAssessment:undefined}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
