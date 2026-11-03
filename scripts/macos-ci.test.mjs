import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const script=resolve('scripts/macos-release-plan.mjs');
const run=(overrides={},cwd=process.cwd())=>spawnSync(process.execPath,[script],{cwd,encoding:'utf8',env:{...process.env,EVENT_NAME:'pull_request',GITHUB_REF:'refs/pull/1/merge',BEFORE:'',...overrides}});
test('macOS releases isolate legacy and Windows tags, PRs and manual runs',()=>{
 for(const env of [{},{EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main'},...['v0.1.0-alpha.3','v0.2.0-alpha.4'].map(t=>({EVENT_NAME:'push',GITHUB_REF:'refs/tags/'+t}))]){assert.equal(run(env).status,0);assert.match(run(env).stdout,/release=false/);}
 const good=run({EVENT_NAME:'push',GITHUB_REF:'refs/tags/v0.3.0-alpha.1'});assert.equal(good.status,0);assert.match(good.stdout,/release=true/);
 assert.notEqual(run({EVENT_NAME:'push',GITHUB_REF:'refs/tags/v0.3.0'}).status,0);
});
test('one-shot request requires exact approved version and a changed file; unrelated pushes do not repeat',()=>{
 const dir=mkdtempSync(join(tmpdir(),'teleport-macos-plan-'));const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try{
  git('init');git('config','user.name','Test');git('config','user.email','test@example.invalid');writeFileSync(join(dir,'README'),'fixture');git('add','.');git('commit','-m','base');const base=git('rev-parse','HEAD');mkdirSync(join(dir,'.github'));
  const requestFile=join(dir,'.github/macos-release-request.json');writeFileSync(requestFile,JSON.stringify({release:true,version:'v0.3.0-alpha.1'}));git('add','.');git('commit','-m','request');const request=git('rev-parse','HEAD');
  const env={EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',BEFORE:base,GITHUB_SHA:request};assert.equal(run(env,dir).status,0);assert.match(run(env,dir).stdout,/release=true/);
  writeFileSync(join(dir,'README'),'unrelated');git('add','.');git('commit','-m','unrelated');assert.match(run({...env,BEFORE:request,GITHUB_SHA:git('rev-parse','HEAD')},dir).stdout,/release=false/);
  for(const invalid of [{release:false,version:'v0.3.0-alpha.1'},{release:true,version:'v0.2.0-alpha.4'}]){writeFileSync(requestFile,JSON.stringify(invalid));assert.notEqual(run(env,dir).status,0);}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('standard native runner gates release on tests, real app startup and checksums without policy bypass',()=>{
 const w=readFileSync('.github/workflows/macos-lightweight.yml','utf8');assert.match(w,/tags: \['v0.3.\*'\]/);assert.match(w,/runs-on: macos-14/);assert.match(w,/cargo test --locked/);assert.match(w,/tauri build --config src-tauri\/tauri.macos.conf.json --bundles app/);assert.match(w,/needs: \[plan, core, macos, phone\]/);
 assert.ok(w.indexOf('node scripts/macos-smoke.mjs')<w.indexOf('node scripts/macos-package.mjs'));assert.match(w,/--target "\$GITHUB_SHA"/);assert.match(w,/sha256sum \*\.zip \*\.manifest.json/);assert.equal((w.match(/contents: write/g)||[]).length,1);assert.match(w,/retention-days: 3/);assert.doesNotMatch(w,/self-hosted|xattr|spctl|disable.*sandbox|TELEPORT_TEST_RELAY|setup-dotnet|larger runner/);
 const smoke=readFileSync('scripts/macos-smoke.mjs','utf8');assert.match(smoke,/TELEPORT_CI_SMOKE_DIR:directory/);assert.match(smoke,/marker.ready!==true\|\|marker.renderer!==true/);
 const pack=readFileSync('scripts/macos-package.mjs','utf8');assert.match(pack,/codesign.*--verify/);assert.match(pack,/expandedBytes>80\*1024\*1024/);assert.match(pack,/compressedBytes>50\*1024\*1024/);
});
test('macOS native staging and smoke refuse other hosts',()=>{
 if(process.platform!=='darwin'||process.arch!=='arm64')for(const file of ['macos-package.mjs','macos-smoke.mjs']){const r=spawnSync(process.execPath,[resolve('scripts',file)],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/macOS arm64/);}
});

test('macOS generate_context has a generated RGBA PNG before Tauri build',()=>{const build=readFileSync('apps/windows-tauri/src-tauri/build.rs','utf8');const config=JSON.parse(readFileSync('apps/windows-tauri/src-tauri/tauri.macos.conf.json','utf8'));assert.ok(config.bundle.icon.includes('icons/icon.png'));assert.ok(build.indexOf('icons/icon.png')<build.indexOf('tauri_build::build()'));assert.match(build,/137u8,80,78,71,13,10,26,10/);});

test('macOS support floor includes native dialog confirmation support',()=>{const config=JSON.parse(readFileSync('apps/windows-tauri/src-tauri/tauri.macos.conf.json','utf8'));assert.equal(config.bundle.macOS.minimumSystemVersion,'13.0');assert.match(readFileSync('apps/windows-tauri/vite.config.js','utf8'),/safari16/);});
