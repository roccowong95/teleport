import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { Receiver } from '../apps/desktop/src/controller.mjs';
import { DryRunAdapter } from '../apps/desktop/src/adapters.mjs';
const endpoint = process.env.TELEPORT_TEST_ENDPOINT || 'http://127.0.0.1:8787';
async function until(check) { const end=Date.now()+15000; while(!check()) { if(Date.now()>end) throw Error('Condition timeout'); await new Promise(r=>setTimeout(r,30)); } }
test('real browser → local Cloudflare DO → encrypted desktop mock, persistence and no replay', {timeout:60000}, async () => {
 const texts=[]; let state; const receiver=new Receiver({store:{load:async()=>state,save:async x=>{state=x;}},adapter:new DryRunAdapter(x=>texts.push(x)),WebSocketImpl:WebSocket});
 let pairing; receiver.on('pair-request', x=>{pairing=x;});
 const browser=await chromium.launch({headless:true,chromiumSandbox:true}); const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true}); const page=await context.newPage();
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 try {
  await receiver.initialize(); await receiver.setup(endpoint,'Cloud test desktop'); await until(()=>receiver.connected);
  const qr=await receiver.pairing(); await page.goto(qr.url); await page.locator('#pair').click(); await until(()=>pairing);
  await page.locator('#sas').waitFor({state:'visible'}); assert.equal(await page.locator('#sas').innerText(),pairing.sas);
  await receiver.approve(pairing.deviceId,true); await until(()=>!!receiver.state.peers[pairing.deviceId]);
  await page.locator('#draft').fill('你好，Teleport 👩🏽‍💻\n第二行 — café');
  assert.equal(await page.locator('#send').isDisabled(),true); await receiver.pause(false);
  await page.locator('#send').click(); await page.getByText('已输入到电脑。',{exact:false}).waitFor();
  assert.deepEqual(texts,['你好，Teleport 👩🏽‍💻\n第二行 — café']); assert.equal(await page.locator('#draft').inputValue(),texts[0]);
  await page.screenshot({path:'test-results/phone-connected.png',fullPage:true});
  await page.reload(); await page.locator('#status').filter({hasText:'已安全连接'}).waitFor(); assert.equal(texts.length,1);
  await page.locator('#draft').fill('重连以后，手动发送'); await page.locator('#send').click(); await until(()=>texts.length===2);
  await page.locator('#connect').click(); assert.equal(await page.locator('#send').isDisabled(),true);
  await page.locator('#connect').click(); await page.locator('#status').filter({hasText:'已安全连接'}).waitFor(); assert.equal(texts.length,2);
  page.on('dialog', d=>d.accept()); await page.locator('#forget').click(); await until(()=>Object.keys(receiver.state.peers).length===0);
  assert.equal(await page.locator('#send').isDisabled(),true); assert.deepEqual(errors,[]);
 } finally { receiver.stop(); if(receiver.state) await receiver.request(`/${receiver.state.roomId}`,null,'DELETE').catch(()=>{}); await browser.close(); }
});
