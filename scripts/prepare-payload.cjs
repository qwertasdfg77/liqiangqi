const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict'), {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'), build=path.join(root,'build'), stage=path.join(build,'payload');
const release=require('../release/v1.8.0.json');
const sha=data=>createHash('sha256').update(data).digest('hex');
assert.equal(process.platform,'win32','Build on Windows x64'); assert.equal(process.arch,'x64');
assert.equal(process.version,release.runtime,'Use the exact official Node.js runtime recorded for this release');
const runtime=fs.readFileSync(process.execPath);
const sums=fs.readFileSync(path.join(root,'third-party/node-v24.18.1-SHASUMS256.txt'),'utf8');
const expected=sums.split('\n').find(line=>line.endsWith('  win-x64/node.exe'))?.split('  ')[0];
assert.equal(sha(runtime),expected,'Runtime must match the recorded official Node.js checksum');
// A build always creates a fresh payload, never bundles previous working files.
assert.ok(stage.startsWith(root+path.sep) && path.relative(root,stage) === path.join('build','payload'));
if(fs.existsSync(stage)) fs.rmSync(stage,{recursive:true});
fs.mkdirSync(path.join(stage,'app'),{recursive:true});fs.mkdirSync(path.join(stage,'runtime'),{recursive:true});
for(const entry of release.sourceFiles) {
  const data=fs.readFileSync(path.join(root,entry.path)); assert.equal(sha(data),entry.sha256,entry.path+' differs from stable 1.8.0');
  fs.writeFileSync(path.join(stage,entry.path),data);
}
fs.writeFileSync(path.join(stage,'runtime/node.exe'),runtime);
fs.copyFileSync(path.join(root,'third-party/Node-LICENSE.txt'),path.join(stage,'runtime/LICENSE.txt'));
fs.copyFileSync(path.join(root,'launcher/使用说明.txt'),path.join(stage,'使用说明.txt'));
const files=[];
function visit(dir,prefix='') {
  for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const name=prefix+item.name, target=path.join(dir,item.name);
    if(item.isDirectory()) visit(target,name+'/');
    else {const data=fs.readFileSync(target);files.push({path:name,size:data.length,sha256:sha(data)});}
  }
}
visit(stage);
const manifest=files.map(f=>`${f.path}|${f.sha256}|${f.size}`).join('\n')+'\n', id=sha(Buffer.from(manifest)).slice(0,20);
assert.equal(id,release.payloadId,'Payload changed: update version metadata deliberately before creating a new release');
fs.writeFileSync(path.join(build,'manifest.txt'),manifest);
fs.writeFileSync(path.join(build,'PackageInfo.cs'),`internal static class PackageInfo { internal const string Id = "${id}"; }\n`);
fs.writeFileSync(path.join(build,'payload-manifest.json'),JSON.stringify({id,runtime:process.version,officialRuntimeSha256:expected,files},null,2)+'\n');
console.log(JSON.stringify({id,files:files.length,officialRuntimeVerified:true}));
