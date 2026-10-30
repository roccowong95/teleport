import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const run=overrides=>spawnSync(process.execPath,['scripts/release-plan.mjs'],{encoding:'utf8',env:{...process.env,EVENT_NAME:'pull_request',GITHUB_REF:'refs/pull/1/merge',BEFORE:'',...overrides}});
test('PR and ordinary main runs never publish',()=>{assert.match(run({}).stdout,/release=false/);assert.match(run({EVENT_NAME:'push',GITHUB_REF:'refs/heads/main'}).stdout,/release=false/);});
test('only prerelease version tags can activate release',()=>{const good=run({EVENT_NAME:'push',GITHUB_REF:'refs/tags/v0.1.0-alpha.1'});assert.equal(good.status,0);assert.match(good.stdout,/release=true/);for(const tag of ['v0.1.0','vbad;echo','v../../bad'])assert.notEqual(run({EVENT_NAME:'push',GITHUB_REF:'refs/tags/'+tag}).status,0);});
test('native packaging refuses unsupported host without producing artifacts',()=>{if(process.platform==='linux'){const r=spawnSync(process.execPath,['scripts/package-desktop.mjs'],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/only on native/);}});
test('workflow uses standard runners and limited release privilege',()=>{const source=readFileSync('.github/workflows/ci.yml','utf8');assert.doesNotMatch(source,/macos-\S*(?:large|xlarge)|self-hosted/);assert.equal((source.match(/contents: write/g)||[]).length,1);assert.match(source,/retention-days: 3/);});

test('ad-hoc app bundles retain role-specific JIT and narrowly allow their bundled framework',async()=>{
 const {createMacSigningOptions}=await import('./macos-signing.mjs');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'teleport-entitlements-'));
 try{const options=createMacSigningOptions(dir);assert.equal(options.identity,'-');assert.equal(options.identityValidation,false);assert.equal(options.continueOnError,false);for(const role of ['',' (Plugin)',' (GPU)',' (Renderer)']){const result=options.optionsForFile('/Test/Teleport'+role+'.app');const plist=readFileSync(result.entitlements,'utf8');assert.match(plist,/com.apple.security.cs.allow-jit/);assert.match(plist,/<key>com.apple.security.cs.disable-library-validation<\/key>\s*<true\/>/);const keys=[...plist.matchAll(/<key>([^<]+)<\/key>/g)].map(m=>m[1]);assert.equal(new Set(keys).size,keys.length);assert.equal(result.timestamp,'none');assert.equal(result.hardenedRuntime,undefined);}for(const path of ['/Test/teleport-input','/Test/Electron Framework.framework'])assert.deepEqual(options.optionsForFile(path),{timestamp:'none'});assert.equal(options.additionalArguments,undefined);}finally{await rm(dir,{recursive:true,force:true});}
});

test('staged package supplies required Windows publisher metadata',()=>{assert.match(readFileSync('scripts/package-desktop.mjs','utf8'),/author:'Teleport contributors'/);});
test('packaged Mac launch gate precedes archive and does not disable sandbox',()=>{const workflow=readFileSync('.github/workflows/ci.yml','utf8');assert.ok(workflow.indexOf('node scripts/smoke-packaged-mac.mjs')<workflow.indexOf('Archive macOS'));assert.doesNotMatch(readFileSync('scripts/smoke-packaged-mac.mjs','utf8'),/--no-sandbox|disable-gpu-sandbox/);});
