import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import * as url from 'node:url';

// Execute the actual main-process bootstrap with Electron/native/transport mocks.
// No native permission prompt, credentials, network, or OS input is involved.
async function boot() {
  const handlers=new Map(), notices=[], requested=[], pauses=[];
  let permissions={accessibility:'unknown',postEvent:'unknown'}, instance, menu;
  const app=new EventEmitter(); Object.assign(app,{requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),getPath:()=>'/test-profile',quit:()=>{},exit:()=>{},setPath:()=>{}});
  class Window extends EventEmitter {
    constructor(){super();this.webContents=new EventEmitter();Object.assign(this.webContents,{setWindowOpenHandler:()=>{},send:(name,value)=>notices.push({name,value})});}
    async loadFile(){} show(){} focus(){} isDestroyed(){return false;}
  }
  class Tray extends EventEmitter {setTitle(){} setToolTip(){} setContextMenu(value){menu=value;}}
  class MacAdapter {async checkPermissions(){return {...permissions};} async requestPermission(kind){requested.push(kind);return {...permissions};}}
  class Receiver extends EventEmitter {
    constructor(options){super();Object.assign(this,options);this.state={};this.paused=true;this.connected=false;this.sessionId='initial';instance=this;}
    status(){return {configured:true,paused:this.paused,connected:this.connected,devices:[]};}
    async initialize(){} async pause(value){pauses.push(value);this.paused=value;}
    connect(){this.connected=true;this.sessionId='connected';} stop(){this.connected=false;}
  }
  const modules={'./controller.mjs':{Receiver},'./store.mjs':{EncryptedStore:class{}},'./adapters.mjs':{MacAdapter,WindowsAdapter:class{},DryRunAdapter:class{},UnsupportedAdapter:class{}},ws:{default:class{}}};
  const electron={app,BrowserWindow:Window,Tray,Menu:{buildFromTemplate:value=>value},nativeImage:{createFromDataURL:()=>({isEmpty:()=>false,setTemplateImage:()=>{}})},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},safeStorage:{},dialog:{showMessageBox:async()=>({response:0})}};
  const source=(await readFile(new URL('../src/main.cjs',import.meta.url),'utf8')).replaceAll('await import(', 'await loadModule(');
  vm.runInNewContext(source,{require:name=>name==='electron'?electron:name==='node:path'?path:name==='node:url'?url:name==='./ipc-guard.cjs'?{isTrustedSender:event=>event.trusted}:name==='qrcode'?{}:(()=>{throw Error(name);})(),loadModule:async name=>modules[name],__dirname:'/desktop/src',process:{platform:'darwin',env:{}},console});
  for(let i=0;i<10;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.ok(handlers.has('pause'));pauses.length=0;notices.length=0;
  return {invoke:(name,...args)=>handlers.get(name)({trusted:true},...args),untrusted:(name,...args)=>handlers.get(name)({trusted:false},...args),permissions:value=>{permissions=value;},requested,pauses,notices,receiver:instance,menu:()=>menu};
}
test('permission checks and startup never request access; unknown/denied cannot resume',async()=>{
  const f=await boot();assert.deepEqual(f.requested,[]);
  const status=await f.invoke('permissions-check');assert.equal(status.accessibility,'unknown');assert.deepEqual(f.requested,[]);
  assert.equal(await f.invoke('pause',false),false);assert.equal(f.receiver.paused,true);
  f.permissions({accessibility:'granted',postEvent:'denied'});
  assert.equal(await f.invoke('pause',false),false);assert.equal(f.receiver.paused,true);
  assert.ok(f.notices.some(entry=>entry.name==='notice'&&entry.value.includes('remains paused')));
  assert.deepEqual(f.requested,[]);
});
test('both granted permits explicit resume, but request success alone never resumes',async()=>{
  const f=await boot();f.permissions({accessibility:'granted',postEvent:'granted'});
  await f.invoke('permissions-request','accessibility');assert.deepEqual(f.requested,['accessibility']);assert.equal(f.receiver.paused,true);assert.deepEqual(f.pauses,[]);
  assert.equal(await f.invoke('pause',false),true);assert.equal(f.receiver.paused,false);
});
test('permission request kind and trusted sender are validated before native call',async()=>{
  const f=await boot();await assert.rejects(f.invoke('permissions-request','all'),/Invalid permission kind/);
  assert.throws(()=>f.untrusted('permissions-request','accessibility'),/Untrusted/);assert.deepEqual(f.requested,[]);
  await f.invoke('permissions-request','postEvent');assert.deepEqual(f.requested,['postEvent']);
});
test('permission helper error remains unknown, not denied or granted, and blocks resume',async()=>{
  const f=await boot();f.permissions({error:'Helper unavailable'});
  const result=await f.invoke('permissions-check');assert.equal(result.accessibility,'unknown');assert.equal(result.postEvent,'unknown');assert.equal(result.error,'Helper unavailable');
  assert.equal(await f.invoke('pause',false),false);assert.equal(f.receiver.paused,true);
});
test('renderer read-only startup and failed recheck render unknown rather than stale grants',async()=>{
  const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',replaceChildren(){},append(){},removeAttribute(){}});return elements.get(id);};
  let response={supported:true,accessibility:'granted',postEvent:'granted'},fail=false;const requests=[];
  const context=vm.createContext({document:{getElementById:element},window:{teleport:{status:async()=>({configured:false,paused:true,connected:false,devices:[]}),permissionsCheck:async()=>{if(fail)throw Error('IPC down');return response;},permissionsRequest:async kind=>{requests.push(kind);return response;},on:()=>{}}},setTimeout,clearTimeout});
  vm.runInContext(await readFile(new URL('../src/renderer.js',import.meta.url),'utf8'),context);
  await vm.runInContext('initialPermissionCheck',context);assert.deepEqual(requests,[]);assert.match(element('permissionStatus').textContent,/granted/);
  fail=true;await element('checkPermissions').onclick();assert.match(element('permissionStatus').textContent,/unknown/);assert.doesNotMatch(element('permissionStatus').textContent,/granted/);assert.match(element('permissionError').textContent,/not a denial/);
  fail=false;response={supported:true,accessibility:'denied',postEvent:'unknown'};await element('checkPermissions').onclick();assert.match(element('permissionStatus').textContent,/Not granted \(denied\)/);assert.equal(element('permissions').hidden,false);assert.deepEqual(requests,[]);
  await element('requestAccessibility').onclick();assert.deepEqual(requests,['accessibility']);
});
