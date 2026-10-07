const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'), release=require('../release/v1.8.0.json'), payload=require('../release/v1.8.0-payload.json');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
assert.equal(require('../package.json').version,release.version);assert.equal(release.tag,'v'+release.version);
assert.equal(payload.id,release.payloadId);assert.equal(payload.runtime,release.runtime);assert.equal(release.sourceFiles.length,15);
assert.equal(sha(Buffer.from(payload.files.map(f=>`${f.path}|${f.sha256}|${f.size}`).join('\n')+'\n')).slice(0,20),release.payloadId,'Recorded canonical payload order');
assert.deepEqual(fs.readdirSync(path.join(root,'app')).sort(),release.sourceFiles.map(f=>path.basename(f.path)).sort());
for(const file of release.sourceFiles) {
  const data=fs.readFileSync(path.join(root,file.path));assert.equal(sha(data),file.sha256,file.path);
  assert.equal(sha(data),payload.files.find(item=>item.path===file.path).sha256,file.path+' vs binary payload');
}
assert.equal(sha(fs.readFileSync(path.join(root,'third-party/Node-LICENSE.txt'))),payload.files.find(f=>f.path==='runtime/LICENSE.txt').sha256);
assert.equal(sha(fs.readFileSync(path.join(root,'launcher/使用说明.txt'))),payload.files.find(f=>f.path==='使用说明.txt').sha256);
assert.match(fs.readFileSync(path.join(root,'launcher/PortableLauncher.cs'),'utf8'),/AssemblyFileVersion\("1\.8\.0\.0"\)/);
const excluded=new Set(['.git','build','reports','dist','node_modules']);const texts=[];
function visit(dir) {for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
  if(excluded.has(item.name)) continue;const file=path.join(dir,item.name);
  if(item.isDirectory())visit(file);else {
    assert.ok(!/\.(exe|dll|rar|zip|pt|onnx|bin|log)$/i.test(item.name),'Generated or experimental file in source: '+file);
    const text=fs.readFileSync(file,'utf8'); texts.push(file);
    const personal=/[A-Z]:[\\/]+Users[\\/]+19385|[A-Z]:[\\/]+Programs[\\/]+NodeJS|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
    assert.ok(!personal.test(text),'Personal path or credential pattern: '+file);
  }
}}
visit(root);
for(const file of texts.filter(f=>f.endsWith('.md'))) {
  const text=fs.readFileSync(file,'utf8');
  for(const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target=match[1];if(/^(https?:|#|mailto:)/.test(target))continue;
    assert.ok(fs.existsSync(path.resolve(path.dirname(file),target.split('#')[0])),'Broken local documentation link: '+target+' in '+file);
  }
}
console.log('PASS stable source/payload/version/license hashes, source hygiene and documentation file links ('+texts.length+' files)');
