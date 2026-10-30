import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { generateIdentity, randomToken, seal, open, encodePairing } from '@teleport/protocol';
const origin = 'http://localhost:5187';
const roomId = 'e4e44654-d9ce-42a5-94d9-f80af6f4d157';
const deviceId = 'f446f387-62d9-42ab-a93b-50e9be3a8e83';
const owner = generateIdentity(), phone = generateIdentity();
const saved = { roomId, endpoint: origin, name: '我的 Mac', ownerPublicKey: owner.publicKey, deviceId, clientToken: randomToken(), ...phone, approved: true, enabled: true };
let server, browser;
before(async()=>{
 server=spawn(process.execPath, ['../../node_modules/vite/bin/vite.js','--host','localhost','--port','5187','--strictPort'], {cwd:new URL('..',import.meta.url),stdio:'ignore'});
 for(let i=0;i<80;i++){try{if((await fetch(origin)).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,chromiumSandbox:true});
});
after(async()=>{await browser?.close();server?.kill();});
async function setup({ready=true}={}){
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.addInitScript(d=>localStorage.setItem('teleport.devices.v1',JSON.stringify([d])), saved);
 const relays=[];let wire;
 await context.routeWebSocket('**/ws',ws=>{wire=ws;ws.onMessage(raw=>{const msg=JSON.parse(raw);if(msg.type==='auth'){ws.send(JSON.stringify({type:'authenticated',status:'approved',role:'sender'}));if(ready)sendReady(ws);}else if(msg.type==='relay')relays.push(msg);});});
 const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已'));
 return {context,page,relays,get wire(){return wire;}};
}
function encrypted(payload){return {type:'data',from:'owner',envelope:seal(payload,{roomId,sender:'owner',recipient:deviceId},phone.publicKey,owner.secretKey)};}
function sendReady(ws){ws.send(JSON.stringify(encrypted({kind:'ready',sessionId:'session-test',targetLabel:'当前焦点窗口',paused:false})));}
test('mobile layout and encrypted send preserve draft; Enter never sends; disconnect disables reconnect',async()=>{
 const t=await setup();try{
 await t.page.locator('#draft').fill('你好，Teleport');await t.page.locator('#draft').press('Enter');assert.equal(t.relays.length,0);
 await t.page.locator('#send').click();await t.page.waitForTimeout(80);assert.equal(t.relays.length,1);
 const payload=open(t.relays[0].envelope,{roomId,sender:deviceId,recipient:'owner'},phone.publicKey,owner.secretKey);
 assert.equal(payload.text,'你好，Teleport\n');assert.equal(payload.sessionId,'session-test');assert.equal(JSON.stringify(t.relays[0]).includes('你好'),false);
 t.wire.send(JSON.stringify(encrypted({kind:'ack',id:payload.id,status:'injected'})));
 await t.page.waitForFunction(()=>document.querySelector('#result').textContent.includes('已输入'));
 assert.equal(await t.page.locator('#draft').inputValue(),'你好，Teleport\n');
 await t.page.locator('#connect').click();assert.equal(await t.page.locator('#send').isDisabled(),true);
 await t.page.evaluate(()=>window.dispatchEvent(new Event('online')));await t.page.waitForTimeout(100);assert.match(await t.page.locator('#status').textContent(),/手动断开/);
 assert.equal(await t.page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
 await t.page.screenshot({path:'artifacts/phone-mobile.png',fullPage:true});
 }finally{await t.context.close();}
});
test('ready is required; interrupted delivery becomes unknown without replay',async()=>{
 const t=await setup({ready:false});try{
 await t.page.locator('#draft').fill('不要自动重发');assert.equal(await t.page.locator('#send').isDisabled(),true);
 sendReady(t.wire);await t.page.waitForFunction(()=>!document.querySelector('#send').disabled);await t.page.locator('#send').click();
 t.wire.send(JSON.stringify({type:'owner-offline'}));await t.page.waitForFunction(()=>document.querySelector('#result').textContent.includes('结果未知'));
 sendReady(t.wire);await t.page.waitForTimeout(100);assert.equal(t.relays.length,1);assert.equal(await t.page.locator('#draft').inputValue(),'不要自动重发');
 }finally{await t.context.close();}
});
test('clear/reset confirmation cancellation is non-destructive',async()=>{
 const t=await setup();try{await t.page.locator('#draft').fill('保留草稿');t.page.on('dialog',d=>d.dismiss());await t.page.locator('#clear').click();await t.page.locator('#reset').click();assert.equal(await t.page.locator('#draft').inputValue(),'保留草稿');assert.equal(await t.page.evaluate(()=>JSON.parse(localStorage.getItem('teleport.devices.v1')).length),1);}finally{await t.context.close();}
});
test('QR fragment is removed immediately, pairing is explicit, pending cannot send',async()=>{
 const context=await browser.newContext({viewport:{width:1280,height:900}});try{
 let posts=0;
 await context.route('**/api/rooms/*/pair',route=>{posts++;return route.fulfill({json:{status:'pending'}});});
 await context.routeWebSocket('**/ws',ws=>ws.onMessage(()=>ws.send(JSON.stringify({type:'authenticated',role:'sender',status:'pending'}))));
 const p={v:1,endpoint:origin,roomId,pairToken:randomToken(),ownerPublicKey:owner.publicKey,name:'Studio Mac',expiresAt:Date.now()+120000};
 const page=await context.newPage();await page.goto(`${origin}/#pair=${encodePairing(p)}`);await page.locator('#pair').waitFor();assert.equal(posts,0);assert.equal(new URL(page.url()).hash,'');
 await page.locator('#pair').click();await page.locator('#sas-panel').waitFor();assert.equal(posts,1);assert.match(await page.locator('#sas').textContent(),/[0-9a-f]/i);await page.locator('#draft').fill('pending');assert.equal(await page.locator('#send').isDisabled(),true);
 await page.screenshot({path:'artifacts/phone-desktop.png',fullPage:true});
 }finally{await context.close();}
});

test('forget disables sending immediately while server revocation is still pending',async()=>{
 const t=await setup();let finish;
 const response=new Promise(resolve=>{finish=resolve;});
 try {
  await t.page.route('**/api/rooms/*/devices/*',async route=>{await response;await route.fulfill({json:{ok:true}});});
  await t.page.locator('#draft').fill('不要在撤销中发送');
  await t.page.waitForFunction(()=>!document.querySelector('#send').disabled);
  t.page.on('dialog',d=>d.accept());
  await t.page.locator('#forget').click();
  await t.page.waitForFunction(()=>document.querySelector('#send').disabled);
  assert.equal(t.relays.length,0);
  finish();
  await t.page.waitForFunction(()=>document.querySelector('#device-panel').hidden);
 }finally{finish();await t.context.close();}
});
