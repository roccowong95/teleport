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
