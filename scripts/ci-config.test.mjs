import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const run=overrides=>spawnSync(process.execPath,['scripts/release-plan.mjs'],{encoding:'utf8',env:{...process.env,EVENT_NAME:'pull_request',GITHUB_REF:'refs/pull/1/merge',BEFORE:'',...overrides}});
test('PR and ordinary main runs never publish',()=>{assert.match(run({}).stdout,/release=false/);assert.match(run({EVENT_NAME:'push',GITHUB_REF:'refs/heads/main'}).stdout,/release=false/);});
test('only prerelease version tags can activate release',()=>{const good=run({EVENT_NAME:'push',GITHUB_REF:'refs/tags/v0.1.0-alpha.1'});assert.equal(good.status,0);assert.match(good.stdout,/release=true/);for(const tag of ['v0.1.0','vbad;echo','v../../bad'])assert.notEqual(run({EVENT_NAME:'push',GITHUB_REF:'refs/tags/'+tag}).status,0);});
test('native packaging refuses unsupported host without producing artifacts',()=>{if(process.platform==='linux'){const r=spawnSync(process.execPath,['scripts/package-desktop.mjs'],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/only on native/);}});
test('workflow uses standard runners and limited release privilege',()=>{const source=readFileSync('.github/workflows/ci.yml','utf8');assert.doesNotMatch(source,/macos-\S*(?:large|xlarge)|self-hosted/);assert.equal((source.match(/contents: write/g)||[]).length,1);assert.match(source,/retention-days: 3/);});

test('macOS signing is ad-hoc only and preserves standard Electron per-helper defaults',async()=>{const {macSigningOptions}=await import('./macos-signing.mjs');assert.equal(macSigningOptions.identity,'-');assert.equal(macSigningOptions.identityValidation,false);assert.equal(macSigningOptions.continueOnError,false);assert.deepEqual(macSigningOptions.optionsForFile('helper'),{timestamp:'none'});assert.equal(macSigningOptions.entitlements,undefined);assert.equal(macSigningOptions.additionalArguments,undefined);});
