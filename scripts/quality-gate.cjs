const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'), reports=path.join(root,'reports');
fs.mkdirSync(reports,{recursive:true});
const names=['observations','game','loop','winrate','adaptive','ponder','dynamic-ponder','strategy','server','full-games','exact-ai','difficulty','release'];
const scripts=[];
for(const dir of ['app','scripts','tests']) for(const file of fs.readdirSync(path.join(root,dir)))
  if(/\.(cjs|js)$/.test(file)) scripts.push(path.join(root,dir,file));
for(const file of scripts) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,file+'\n'+result.stderr);
}
const checks=[];
for(const name of names) {
  console.log('RUN '+name);const started=Date.now();
  const result=spawnSync(process.execPath,[path.join(root,'tests','verify-'+name+'.cjs')],{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,timeout:600000});
  checks.push({name,exitCode:result.status,milliseconds:Date.now()-started,output:result.stdout+result.stderr,error:result.error?.message});
  fs.writeFileSync(path.join(reports,'quality-gate.json'),JSON.stringify({node:process.version,syntaxChecks:scripts.length,checks},null,2)+'\n');
  assert.equal(result.status,0,name+': '+(result.error?.message||'')+'\n'+result.stderr+'\n'+result.stdout);
  console.log('PASS '+name);
}
console.log('PASS '+checks.length+' stable release checks and '+scripts.length+' syntax checks');
