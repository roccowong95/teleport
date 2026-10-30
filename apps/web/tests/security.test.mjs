import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEndpoint, canSend, retryDelay } from '../src/security.mjs';
test('pairing endpoint must be same secure origin, with no credentials/path/query', () => {
 assert.equal(validateEndpoint('https://teleport.example', 'https://teleport.example'), 'https://teleport.example');
 assert.equal(validateEndpoint('http://localhost:8787', 'http://localhost:8787'), 'http://localhost:8787');
 for (const endpoint of ['https://evil.example','http://teleport.example','https://x:y@teleport.example','https://teleport.example/api','https://teleport.example/?token=secret','javascript:alert(1)']) assert.throws(() => validateEndpoint(endpoint,'https://teleport.example'));
});
test('send is fail-closed across connection, readiness, approval, pause, pending and size', () => {
 const good={connected:true,ready:true,approved:true,paused:false,pending:false,bytes:4};
 assert.equal(canSend(good),true);
 for (const change of [{connected:false},{ready:false},{approved:false},{paused:true},{pending:true},{bytes:0},{bytes:8193}]) assert.equal(canSend({...good,...change}),false);
 assert.equal(canSend({...good,bytes:8192}),true);
});
test('backoff bounded and jittered',()=>{ assert.equal(retryDelay(0,0),1000); assert.equal(retryDelay(30,0),30000); });

import { ackMessage, sendBlockReason, unknownMessage } from '../src/diagnostics.mjs';
test('every disabled-send state has an actionable safe explanation', () => {
 const good = {hasDevice:true,enabled:true,online:true,connected:true,approved:true,ready:true,paused:false,pending:false,bytes:1};
 assert.equal(sendBlockReason(good),'');
 for (const [change, expected] of [[{hasDevice:false},/尚未配对/],[{enabled:false},/重新连接/],[{online:false},/网络离线/],[{connected:false},/连接尚未建立/],[{approved:false},/配对批准/],[{ready:false},/电脑尚未就绪/],[{paused:true},/暂停/],[{pending:true},/15 秒/],[{bytes:0},/还没有文字/],[{bytes:8193},/8192/]]) assert.match(sendBlockReason({...good,...change}),expected);
 assert.equal(sendBlockReason({...good,bytes:8192}),'');
});
test('ACK diagnostics distinguish OS submission, rejection, uncertainty, and timeout without exposing arbitrary codes',()=>{
 assert.match(ackMessage('injected'),/提交输入事件.*无法确认目标应用/);
 assert.match(ackMessage('rejected','paused'),/拒绝.*暂停/);
 assert.match(ackMessage('unknown','input_posting_unconfirmed'),/结果未知.*部分/);
 assert.match(unknownMessage('timeout'),/超过 15 秒.*结果未知/);
 for(const code of ['秘密正文 <script>alert(1)</script>','toString','__proto__',{},null]) {
  assert.equal(ackMessage('unknown',code),ackMessage('unknown'));
  assert.equal(ackMessage('rejected',code),ackMessage('rejected'));
 }
 for(const status of ['injected','rejected','unknown','unexpected']) assert.match(ackMessage(status),/草稿已保留.*不会自动重发/);
});

test('native diagnostic codes all have safe explanations and never override unknown ACK certainty', async()=>{
 const {readFile} = await import('node:fs/promises');
 const {INPUT_DIAGNOSTIC_CODES} = await import('../src/diagnostics.mjs');
 const native = await readFile(new URL('../../windows-tauri/src-tauri/src/input.rs',import.meta.url),'utf8');
 const codes = [...native.split('pub const INPUT_FAILURE_CODES')[1].split('];')[0].matchAll(/"([a-z_]+)"/g)].map(m=>m[1]);
 assert.ok(codes.length >= 32);
 for(const code of codes){
  assert.ok(INPUT_DIAGNOSTIC_CODES.includes(code),`missing safe explanation: ${code}`);
  assert.match(ackMessage('unknown',code),/^结果未知：可能已输入全部或部分文字/);
  assert.match(ackMessage('rejected',code),/^电脑拒绝/);
 }
 assert.match(ackMessage('unknown','input_focus_changed'),/焦点发生变化/);
 assert.match(ackMessage('rejected','input_unsupported_control'),/自定义输入框/);
});
