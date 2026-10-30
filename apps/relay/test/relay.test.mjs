import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {generateIdentity, seal, open} from '@teleport/protocol';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const token = () => randomBytes(32).toString('base64url');
let mf;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({workers: [{name: 'relay', modules: true, script: await readFile(new URL('../src/index.js', import.meta.url), 'utf8'), compatibilityDate: '2026-10-01', durableObjects: {ROOMS: {className: 'Room', useSQLite: true}}, bindings: {}}]}));
});
after(async () => { await mf?.dispose(); });
async function http(path, method = 'GET', data, bearer) {
  return mf.dispatchFetch(`https://localhost/api/rooms${path}`, {method, headers: {'Content-Type': 'application/json', ...(bearer ? {Authorization: `Bearer ${bearer}`} : {})}, ...(data ? {body: JSON.stringify(data)} : {})});
}
async function room() {
 const ownerToken = token(), ownerPublicKey = token();
 const res = await http('', 'POST', {ownerToken, ownerPublicKey, name: 'Desktop'}); assert.equal(res.status, 201);
 return {roomId: (await res.json()).roomId, ownerToken};
}
async function socket(id) {
 const res = await mf.dispatchFetch(`https://localhost/api/rooms/${id}/ws`, {headers: {Upgrade: 'websocket'}});
 assert.equal(res.status, 101); const ws = res.webSocket; ws.accept();
 const queue = []; let wake;
 ws.addEventListener('message', e => { queue.push(JSON.parse(e.data)); wake?.(); });
 return {ws, send: x => ws.send(JSON.stringify(x)), async next(type) {
   const deadline = Date.now() + 3000;
   for (;;) { const i = queue.findIndex(m => !type || m.type === type); if (i >= 0) return queue.splice(i, 1)[0];
     if (Date.now() > deadline) throw new Error(`Timeout awaiting ${type}; messages: ${JSON.stringify(queue)}`);
     await new Promise(r => { const timer = setTimeout(r, 50); wake = () => {clearTimeout(timer); r();}; });
   }
 }};
}
async function pair(r, owner) {
 const pairToken = token(); assert.equal((await http(`/${r.roomId}/pairing`, 'POST', {pairToken}, r.ownerToken)).status, 200);
 const device = {deviceId: randomUUID(), publicKey: token(), clientToken: token(), name: 'Phone'};
 const res = await http(`/${r.roomId}/pair`, 'POST', {pairToken, ...device}); assert.equal(res.status, 200); assert.equal((await res.json()).status, 'pending');
 assert.equal((await owner.next('pair-request')).deviceId, device.deviceId);
 const sender = await socket(r.roomId); sender.send({type: 'auth', role: 'sender', deviceId: device.deviceId, token: device.clientToken});
 assert.equal((await sender.next('authenticated')).status, 'pending');
 return {...device, sender, pairToken};
}
const envelope = {v: 1, nonce: randomBytes(24).toString('base64url'), ciphertext: randomBytes(48).toString('base64url')};
test('create, approve, opaque live relay, no offline queue, and self-revoke', async () => {
 const r = await room(); const owner = await socket(r.roomId);
 owner.send({type: 'auth', role: 'owner', token: r.ownerToken}); assert.equal((await owner.next('authenticated')).role, 'owner');
 const d = await pair(r, owner);
 d.sender.send({type: 'relay', to: 'owner', envelope}); assert.equal((await d.sender.next('error')).code, 'forbidden');
 owner.send({type: 'pair-approve', deviceId: d.deviceId}); await owner.next('pair-approved'); await d.sender.next('pair-approved');
 d.sender.send({type: 'relay', to: 'owner', envelope}); assert.deepEqual(await owner.next('data'), {type: 'data', from: d.deviceId, envelope});
 owner.send({type: 'relay', to: d.deviceId, envelope}); assert.deepEqual((await d.sender.next('data')).envelope, envelope);
 const devices = await (await http(`/${r.roomId}/devices`, 'GET', null, r.ownerToken)).json(); assert.equal(devices.devices.length, 1); assert.equal(devices.devices[0].tokenHash, undefined);
 owner.ws.close(); await d.sender.next('owner-offline');
 d.sender.send({type: 'relay', to: 'owner', envelope}); assert.equal((await d.sender.next('error')).code, 'peer_offline');
 assert.equal((await http(`/${r.roomId}/devices/${d.deviceId}`, 'DELETE', null, d.clientToken)).status, 200);
 const revoked = await socket(r.roomId); revoked.send({type: 'auth', role: 'sender', deviceId: d.deviceId, token: d.clientToken}); assert.equal((await revoked.next('error')).code, 'unauthorized');
});
test('authentication fails closed and origin/query secrets are rejected', async () => {
 const r = await room(); const ws = await socket(r.roomId);
 ws.send({type: 'auth', role: 'owner'}); assert.equal((await ws.next('error')).code, 'unauthorized');
 assert.equal((await http(`/${r.roomId}/devices`)).status, 401);
 const cross = await mf.dispatchFetch(`https://localhost/api/rooms/${r.roomId}/ws`, {headers: {Upgrade: 'websocket', Origin: 'https://evil.example'}}); assert.equal(cross.status, 403);
 assert.equal((await http(`/${r.roomId}/ws?token=secret`)).status, 400);
});
test('requires owner online, single-use pairing, reject and deletion', async () => {
 const r = await room(); const pairToken = token(); await http(`/${r.roomId}/pairing`, 'POST', {pairToken}, r.ownerToken);
 assert.equal((await http(`/${r.roomId}/pair`, 'POST', {pairToken, deviceId: randomUUID(), publicKey: token(), clientToken: token(), name: 'P'})).status, 409);
 const owner = await socket(r.roomId); owner.send({type: 'auth', role: 'owner', token: r.ownerToken}); await owner.next('authenticated');
 const d = await pair(r, owner); owner.send({type: 'pair-reject', deviceId: d.deviceId}); await owner.next('pair-rejected'); assert.equal((await d.sender.next('error')).code, 'pair_rejected');
 assert.equal((await http(`/${r.roomId}/pair`, 'POST', {pairToken: d.pairToken, deviceId: randomUUID(), publicKey: token(), clientToken: token(), name: 'P'})).status, 401);
 assert.equal((await http(`/${r.roomId}`, 'DELETE', null, r.ownerToken)).status, 200); assert.equal((await http(`/${r.roomId}/devices`, 'GET', null, r.ownerToken)).status, 404);
});
test('unauthenticated connections are capped and expire at the authentication deadline', {timeout: 15000}, async () => {
 const r = await room(); const sockets = [];
 for (let i = 0; i < 4; i++) sockets.push(await socket(r.roomId));
 const response = await mf.dispatchFetch(`https://localhost/api/rooms/${r.roomId}/ws`, {headers: {Upgrade: 'websocket'}}); assert.equal(response.status, 429);
 await new Promise(resolve => setTimeout(resolve, 10_100));
 assert.equal((await sockets[0].next('error')).code, 'auth_timeout');
 const fresh = await socket(r.roomId); fresh.ws.close();
});
test('owner replacement, sender isolation, and owner-authorized revocation', async () => {
 const r = await room(); const first = await socket(r.roomId); first.send({type: 'auth', role: 'owner', token: r.ownerToken}); await first.next('authenticated');
 const owner = await socket(r.roomId); owner.send({type: 'auth', role: 'owner', token: r.ownerToken}); await owner.next('authenticated'); assert.equal((await first.next('error')).code, 'replaced');
 const d = await pair(r, owner); owner.send({type: 'pair-approve', deviceId: d.deviceId}); await d.sender.next('pair-approved');
 const malformed = await socket(r.roomId); malformed.send({type:'auth',role:'sender',deviceId:[d.deviceId],token:d.clientToken}); assert.equal((await malformed.next('error')).code,'unauthorized');
 d.sender.send({type: 'relay', to: d.deviceId, envelope}); assert.equal((await d.sender.next('error')).code, 'forbidden');
 d.sender.send({type: 'relay', to: 'owner', envelope: {...envelope, nonce: 'bad'}}); assert.equal((await d.sender.next('error')).code, 'invalid_envelope');
 assert.equal((await http(`/${r.roomId}/devices/${d.deviceId}`, 'DELETE', null, token())).status, 401);
 assert.equal((await http(`/${r.roomId}/devices/${d.deviceId}`, 'DELETE', null, r.ownerToken)).status, 200);
 assert.equal((await owner.next('peer-revoked')).deviceId, d.deviceId); owner.ws.close();
});

test('maximum-size text with JSON escaping survives encrypted relay', async () => {
 const r = await room(); const owner = await socket(r.roomId); owner.send({type: 'auth', role: 'owner', token: r.ownerToken}); await owner.next('authenticated');
 const d = await pair(r, owner); owner.send({type: 'pair-approve', deviceId: d.deviceId}); await d.sender.next('pair-approved');
 const senderKey = generateIdentity(), ownerKey = generateIdentity();
 const context = {roomId:r.roomId,sender:d.deviceId,recipient:'owner'};
 const payload = {kind:'text',id:randomUUID(),sessionId:randomUUID(),text:'"'.repeat(8192),sentAt:Date.now(),expiresAt:Date.now()+15000};
 const encrypted = seal(payload, context, ownerKey.publicKey, senderKey.secretKey);
 assert.ok(encrypted.ciphertext.length > 16384);
 d.sender.send({type:'relay',to:'owner',envelope:encrypted});
 const forwarded = await owner.next('data'); assert.deepEqual(open(forwarded.envelope,context,senderKey.publicKey,ownerKey.secretKey),payload);
 owner.ws.close(); d.sender.ws.close();
});
