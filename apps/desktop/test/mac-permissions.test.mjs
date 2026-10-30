import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MacAdapter } from '../src/adapters.mjs';
function mock({output='{"accessibility":"denied","postEvent":"granted"}',code=0,error=false,hang=false}={}) {
 const calls=[]; let killed=false;
 const spawnImpl=(command,args,options)=>{
  calls.push({command,args,options}); const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();
  c.kill=()=>{killed=true;};c.stdin.end=input=>{calls.at(-1).input=input;if(!hang)queueMicrotask(()=>{if(error)c.emit('error',Error('sensitive helper path'));else{c.stdout.emit('data',Buffer.from(output));c.emit('close',code);}});};return c;
 };
 return {calls,spawnImpl,get killed(){return killed;}};
}
test('permission check uses read-only mode, no input or shell, and preserves individual statuses',async()=>{
 const f=mock(),a=new MacAdapter('/mock/helper',{spawnImpl:f.spawnImpl});assert.deepEqual(await a.checkPermissions(),{accessibility:'denied',postEvent:'granted'});assert.deepEqual(f.calls[0].args,['--permissions']);assert.equal(f.calls[0].input,'');assert.equal(f.calls[0].options.shell,false);
});
test('only explicit valid request methods invoke prompt modes and do not assume permission granted',async()=>{
 const f=mock({output:'{"accessibility":"denied","postEvent":"denied"}'}),a=new MacAdapter('/mock/helper',{spawnImpl:f.spawnImpl});
 assert.equal((await a.requestPermission('accessibility')).accessibility,'denied');await a.requestPermission('postEvent');assert.deepEqual(f.calls.map(c=>c.args),[['--request-accessibility'],['--request-post-event']]);for(const kind of ['all','__proto__','toString',null])assert.equal((await a.requestPermission(kind)).error,'invalid_permission_kind');assert.equal(f.calls.length,2);
});
test('helper errors, nonzero exit, malformed/oversized output become unknown, not denied or leaked diagnostics',async()=>{
 for(const params of [{error:true},{code:2},{output:'not JSON'},{output:'{"accessibility":true,"postEvent":"denied"}'},{output:'x'.repeat(4097)}]){
 const f=mock(params),a=new MacAdapter('/mock/helper',{spawnImpl:f.spawnImpl});const r=await a.checkPermissions();assert.equal(r.accessibility,'unknown');assert.equal(r.postEvent,'unknown');assert.ok(r.error);assert.equal(JSON.stringify(r).includes('sensitive'),false);
 }
 const a=new MacAdapter('/mock/helper',{spawnImpl:()=>{throw Error('private path');}});assert.equal((await a.checkPermissions()).error,'permission_helper_unavailable');
});
test('timed out permission request is unknown and bounded, not a denial',async()=>{
 const f=mock({hang:true}),a=new MacAdapter('/mock/helper',{spawnImpl:f.spawnImpl,permissionRequestTimeoutMs:10});assert.deepEqual(await a.requestPermission('postEvent'),{accessibility:'unknown',postEvent:'unknown',error:'permission_check_timeout'});assert.equal(f.killed,true);
});
