const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {SearchSession,rootPreferences}=require('../app/ai.cjs');
const {Board,Search,WIN}=require('../app/engine.cjs');
const {Game,initialState,applyAction}=require('../app/game.cjs');
const history=require('./fixtures/loop-history.json');
const {fixtures,randomStates}=require('./fixtures.cjs');
const options={milliseconds:20000,adaptive:false,maxDepth:4,exact:false};
function exactRoots(state,depth){
 const board=new Board(state),rows=[];
 for(const action of board.legalActions()){
  const move=board.apply(action);
  const score=move.terminal===null?new Search({milliseconds:20000}).minimax(board,depth-1):move.terminal*WIN;
  board.undo(move.undo);rows.push({action,score});
 }
 return rows;
}
function expectedUtility(state,rows,seen){
 const pref=rootPreferences(new Board(state),seen),sign=state.waitFor===0?1:-1;
 return Math.max(...rows.map(row=>sign*row.score-(row.action<81&&Math.abs(row.score)<WIN
  ?Math.min(1800,pref(row.action).pawnVisits*600):0)));
}
async function main(){
 const session=new SearchSession({workers:3}),reports=[];
 try{
  for(const plies of [36,38,48,54,62]){
   const game=new Game(1);for(const entry of history.slice(0,plies))game.play(entry.action);
   const result=await session.choose(game.state,{...options,maxDepth:6,seen:game.seen}).promise;
   const rows=exactRoots(game.state,6),actual=rows.find(row=>row.action===result.action);
   assert.equal(result.depth,6);assert.equal(result.score,actual.score);
   assert.equal(result.selectionScore,expectedUtility(game.state,rows,game.seen));
   if(plies===36||plies===48)assert.equal(result.action,21,'Advance to D7 instead of returning to D5');
   reports.push({plies,previous:history[plies].action,action:result.action,score:result.score,
    selectionScore:result.selectionScore,pawnVisits:result.pawnVisits,tieVerifications:result.tieVerifications});
  }
  // Compare selected moves with fully opened root searches on both sides, with
  // history penalties and without them. A bound must never masquerade as a tie.
  let comparisons=0,verifications=0;
  for(const state of [fixtures[0].state,fixtures[1].state,...randomStates(10)]){
   const depth=2,board=new Board(state),seen=new Map();
   for(const action of board.pawnMoves()){
    const transition=board.apply(action);seen.set(board.signature(),3);board.undo(transition.undo);
   }
   const rows=exactRoots(state,depth);
   for(const historyMap of [new Map(),seen]){
    const result=await session.choose(state,{...options,maxDepth:depth,seen:historyMap}).promise;
    if(result.source==='immediate-win')continue;
    assert.equal(result.depth,depth);assert.equal(result.score,rows.find(row=>row.action===result.action).score);
    assert.equal(result.selectionScore,expectedUtility(state,rows,historyMap));
    comparisons++;verifications+=result.tieVerifications;
   }
  }
  assert.ok(verifications>0,'Exercise full-window confirmation of optimistic root bounds');
  const symmetry={...initialState(),leftWalls:[0,0]};
  const board=new Board(symmetry),seen=new Map();
  for(const action of [75,67]){const transition=board.apply(action);seen.set(board.signature(),3);board.undo(transition.undo);}
  assert.equal(board.symmetric(),true);
  const right=await session.choose(symmetry,{...options,maxDepth:2,seen}).promise;
  assert.equal(right.action,77,'Asymmetric history keeps the unvisited mirror move');
  const keyBoard=new Board(symmetry),info=rootPreferences(keyBoard,seen),original=keyBoard.signature();
  assert.equal(info(75).pawnVisits,3);assert.equal(info(77).pawnVisits,0);assert.equal(keyBoard.signature(),original);
  const changed={...symmetry,walls:[...symmetry.walls,{x:0,y:3,d:0,p:1}]};
  assert.equal(rootPreferences(new Board(changed),seen)(75).pawnVisits,0,'New walls reset route visits');
  const game=new Game(0,symmetry);for(const action of [75,13,76,22,75,31,76,40])game.play(action);
  const before=rootPreferences(new Board(game.state),game.seen)(76).pawnVisits;
  game.undo();assert.ok(rootPreferences(new Board(game.state),game.seen)(76).pawnVisits<before,'Undo rebuilds route history');
  const tactical={...initialState(),leftWalls:[0,0],playerPos:[{x:3,y:2},{x:6,y:0}]};
  const tacticalBoard=new Board(tactical),tacticalSeen=new Map();
  for(const action of tacticalBoard.pawnMoves()){
   const move=tacticalBoard.apply(action);tacticalSeen.set(tacticalBoard.signature(),20);tacticalBoard.undo(move.undo);
  }
  const win=await session.choose(tactical,{...options,maxDepth:5,seen:tacticalSeen}).promise;
  assert.equal(win.score,WIN);assert.equal(win.repetitionPenalty,0,'Proven outcomes are never discounted');
  const opponentPath=history.slice(34).filter(entry=>entry.player===1).map(entry=>entry.action);
  const gamePlay=new Game(1);for(const entry of history.slice(0,34))gamePlay.play(entry.action);
  const route=[];let cursor=0;
  for(let turn=0;turn<50&&!gamePlay.state.isOver;turn++){
   if(gamePlay.state.waitFor===0){
    const result=await session.choose(gamePlay.state,{...options,maxDepth:6,seen:gamePlay.seen}).promise;
    gamePlay.play(result.action);route.push(result.action);
   }else{
    const board=new Board(gamePlay.state),scripted=opponentPath[cursor++];
    let action=board.pawnMoves().includes(scripted)?scripted:null;
    if(action===null){
     const scores=board.pawnMoves().map(action=>{
      const move=board.apply(action),distance=board.distance(1);board.undo(move.undo);return{action,distance};
     }).sort((a,b)=>a.distance-b.distance);action=scores[0].action;
    }
    gamePlay.play(action);
   }
  }
  console.log(JSON.stringify({mazeRoute:route,winners:gamePlay.state.winnerId,plies:gamePlay.history.length}));
  assert.equal(gamePlay.state.isOver,true,'The reproduced maze game must finish');
  assert.ok(gamePlay.state.winnerId.includes(0));assert.ok(route.length<20);
  const interrupted=session.choose(fixtures[1].state,{...options,maxDepth:32});
  await new Promise(resolve=>setTimeout(resolve,100));interrupted.cancel();assert.equal(await interrupted.promise,null);
  const resumed=await session.choose(symmetry,{...options,maxDepth:2,seen}).promise;assert.equal(resumed.action,77);
  const report={replayedPositions:reports,rootUtilityComparisons:comparisons,fullWindowVerifications:verifications,
   asymmetricHistory:true,wallEpochReset:true,undoHistoryRebuilt:true,provenWinProtected:true,
   repeatedMovesRemainLegal:true,mazeGame:{computerActions:route,winners:gamePlay.state.winnerId},cancellationAndReuse:true};
  fs.writeFileSync(path.join(__dirname, '../reports', 'loop-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await session.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
