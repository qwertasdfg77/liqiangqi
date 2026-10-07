const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const manifest = require(path.resolve(process.argv[3] || path.join(__dirname, '../build/payload-manifest.json')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const release = path.resolve(process.argv[2] || path.join(__dirname, '../build/release/力墙棋.exe'));
const qaRun = path.join(__dirname, '../reports/portable', 'run-' + Date.now());
const isolated = path.join(qaRun, '异地复制 中文 & spaces');
const exe = path.join(isolated, '改名也能玩.exe');
const local = path.join(qaRun, '独立用户数据');
const root = path.join(local, 'LqqPortable', manifest.id);
const app = path.join(root, 'app');
const env = { ...process.env, LOCALAPPDATA: local, PATH: path.join(process.env.SystemRoot, 'System32'), NODE_PATH: 'X:/not-installed', NODE_OPTIONS: '--invalid-option-should-be-cleared' };
function launch(environment = env) {
  return new Promise((resolve,reject)=>{
    const child = spawn(exe, ['--no-browser'], { cwd: isolated, env: environment, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout='',stderr='';
    child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    child.once('error',reject);
    const deadline = setTimeout(()=>reject(new Error('Portable launcher timed out')),25000);
    child.once('exit',code=>{clearTimeout(deadline);child.stdout.destroy();child.stderr.destroy();code===0?resolve({code,stdout,stderr}):reject(new Error(`Launcher exit ${code}: ${stderr}`));});
  });
}
function imports(filename) {
  const data = fs.readFileSync(filename), pe = data.readUInt32LE(0x3c), count = data.readUInt16LE(pe+6), optionalSize=data.readUInt16LE(pe+20);
  const optional=pe+24, directories=optional+(data.readUInt16LE(optional)===0x20b?112:96), table=optional+optionalSize;
  function offset(rva) { for(let i=0;i<count;i++){const s=table+i*40,start=data.readUInt32LE(s+12),length=Math.max(data.readUInt32LE(s+8),data.readUInt32LE(s+16));if(rva>=start&&rva<start+length)return data.readUInt32LE(s+20)+rva-start;}throw new Error('Invalid PE address'); }
  const importRva=data.readUInt32LE(directories+8);if(!importRva)return[];
  const names=[];let entry=offset(importRva);
  while(data.readUInt32LE(entry+12)){const start=offset(data.readUInt32LE(entry+12)),end=data.indexOf(0,start);names.push(data.toString('ascii',start,end));entry+=20;}
  return names;
}
async function main() {
  fs.mkdirSync(path.join(__dirname,'../reports'),{recursive:true});
  assert.ok(!fs.existsSync(local),'QA must start with empty independent user data');
  fs.mkdirSync(isolated,{recursive:true});fs.copyFileSync(release,exe);
  assert.deepEqual(fs.readdirSync(isolated),['改名也能玩.exe']);
  const startup=Date.now();await launch();const startupMs=Date.now()-startup;
  const addressFile=path.join(local,'LqqDuel',sha(Buffer.from(app)).slice(0,20)+'.json');
  const address=JSON.parse(fs.readFileSync(addressFile,'utf8'));
  const get=async()=>{const r=await fetch(address.url+'/api/state');assert.equal(r.status,200);return r.json();};
  const post=async(endpoint,body)=>{const r=await fetch(address.url+'/api/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
  const info=await(await fetch(address.url+'/api/info')).json();assert.equal(info.root,app);assert.equal(info.service,'lqq-duel-local-v2');
  for(const item of manifest.files){const data=fs.readFileSync(path.join(root,item.path));assert.equal(data.length,item.size,item.path);assert.equal(sha(data),item.sha256,item.path);}
  const dlls=imports(path.join(root,'runtime/node.exe'));
  assert.ok(!dlls.some(name=>/vcruntime|msvcp|python|cuda/i.test(name)),'Runtime must not need a separate VC/Python/GPU installation');
  let state=await get();assert.equal(state.history.length,0);assert.equal(state.human,0);
  state=await post('move',{revision:state.revision,action:67});assert.equal(state.thinking,true);
  const start=Date.now();while(state.thinking&&Date.now()-start<35000){await new Promise(r=>setTimeout(r,100));state=await get();}
  assert.equal(state.thinking,false);assert.equal(state.history.length,2);assert.equal(state.waitFor,state.human);assert.ok(state.lastAnalysis.workers>=1&&state.lastAnalysis.workers<=8);
  const actualPlay={history:state.history,analysis:state.lastAnalysis};
  assert.equal(state.difficulty.key,'highest');
  state=await post('difficulty',{revision:state.revision,difficulty:'quick'});
  assert.equal(state.difficulty.milliseconds,20000);assert.equal(state.history.length,2);
  state=await post('new',{human:1,difficulty:'quick'});assert.equal(state.ai.hardBudget,20000);
  state=await post('difficulty',{revision:state.revision,difficulty:'highest'});assert.equal(state.ai.hardBudget,30000);
  let deadline=Date.now()+35000;while(state.thinking&&Date.now()<deadline){await new Promise(r=>setTimeout(r,100));state=await get();}
  assert.equal(state.thinking,false);assert.equal(state.history.length,1);assert.equal(state.lastAnalysis.hardBudget,30000);
  const highestOpening=state.lastAnalysis;
  state=await post('new',{human:0,difficulty:'quick'});state=await post('move',{revision:state.revision,action:67});
  deadline=Date.now()+25000;while(state.thinking&&Date.now()<deadline){await new Promise(r=>setTimeout(r,100));state=await get();}
  assert.equal(state.thinking,false);assert.equal(state.history.length,2);assert.equal(state.lastAnalysis.hardBudget,20000);
  const quickReply=state.lastAnalysis;
  state=await post('difficulty',{revision:state.revision,difficulty:'highest'});assert.equal(state.history.length,2);
  const tiers={defaultHighest:true,quickReplyBudget:quickReply.hardBudget,highestOpeningBudget:highestOpening.hardBudget,midSearchSwitch:true};
  const previousUrl=address.url;
  const repeated=await Promise.all([launch(),launch()]);
  assert.equal(JSON.parse(fs.readFileSync(addressFile,'utf8')).url,previousUrl);assert.equal((await get()).history.length,2);
  // A missing extracted file is repaired directly from the sole copied executable.
  const css=path.join(root,'app/style.css');fs.writeFileSync(css,'test damaged cache');await launch();
  assert.equal(sha(fs.readFileSync(css)),manifest.files.find(x=>x.path==='app/style.css').sha256);
  state=await post('undo',{revision:(await get()).revision});assert.equal(state.history.length,0);
  const resumedLocal=path.join(qaRun,'迁移对局的用户数据');
  const resumedRoot=path.join(resumedLocal,'LqqPortable',manifest.id);
  fs.mkdirSync(resumedRoot,{recursive:true});
  const resumeFile=path.join(resumedRoot,'resume-game.json');
  fs.writeFileSync(resumeFile,JSON.stringify({human:1,history:[{action:67}],revision:100,difficulty:{key:'quick'}}));
  await launch({...env,LOCALAPPDATA:resumedLocal});
  const resumedAddressFile=path.join(resumedLocal,'LqqDuel',sha(Buffer.from(path.join(resumedRoot,'app'))).slice(0,20)+'.json');
  const resumedAddress=JSON.parse(fs.readFileSync(resumedAddressFile,'utf8'));
  const restored=await(await fetch(resumedAddress.url+'/api/state')).json();
  assert.equal(restored.difficulty.key,'quick');assert.equal(restored.human,1);assert.equal(restored.history.length,1);assert.equal(restored.history[0].action,67);assert.equal(restored.revision,101);
  assert.equal(fs.existsSync(resumeFile),false,'The one-time migration must not reopen a stale game later');
  assert.deepEqual(fs.readdirSync(isolated),['改名也能玩.exe']);
  const report={tiers,exe,exeSha256:sha(fs.readFileSync(exe)),bytes:fs.statSync(exe).size,url:address.url,cacheRoot:root,startupMs,oneFileRelocation:true,renamedChineseSpaceAndAmpersandPath:true,independentUserData:true,installedNodeExcludedFromPath:true,inheritedNodeOptionsCleared:true,allPayloadHashesVerified:true,nodeWindowsImports:dlls,actualPlay,concurrentRepeatedLaunchPreservedGame:true,damagedCacheRepaired:true,undo:true,oneTimeResume:{url:resumedAddress.url,cacheRoot:resumedRoot,restored:true,resumeFileConsumed:true},sidecarFilesCreated:false,repeated};
  fs.writeFileSync(path.join(__dirname,'../reports/portable-verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({tiers,url:address.url,cacheRoot:root,startupMs,oneFileRelocation:true,installedNodeExcludedFromPath:true,automaticReplyMs:actualPlay.analysis.milliseconds,concurrentLaunch:true,cacheRepair:true,undo:true,oneTimeResume:true,sidecarFiles:false,windowsImports:dlls}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'cleanup-portable.ps1'),'-QaRun',qaRun,'-PayloadId',manifest.id],{encoding:'utf8',windowsHide:true});
  if(result.status!==0){console.error(result.stderr);process.exitCode=1;}
});
