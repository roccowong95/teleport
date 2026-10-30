import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Room} from '../src/index.js';
import {randomBytes, randomUUID} from 'node:crypto';
const token = () => randomBytes(32).toString('base64url');
function context(initial) {
 const data = new Map(initial ? [['room', initial]] : []); const sockets = [];
 return {data, sockets, alarmTime: null, blockConcurrencyWhile: fn => fn(), getWebSockets: () => sockets,
 storage: {get: async k => structuredClone(data.get(k)), put: async (k, v) => data.set(k, structuredClone(v)), deleteAll: async () => data.clear(), setAlarm: async t => {}, deleteAlarm: async () => {} }};
}
function socket(a) { return {a, messages: [], deserializeAttachment() {return this.a;}, serializeAttachment(a) {this.a = a;}, send(s) {this.messages.push(JSON.parse(s));}, close() {this.closed = true;}}; }
test('room storage contains hashes, not authentication secrets', async () => {
 const ctx = context(); const room = new Room(ctx, {}); const ownerToken = token();
 const res = await room.fetch(new Request('https://localhost/api/rooms', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ownerToken, ownerPublicKey: token(), name: 'Desk'})}));
 assert.equal(res.status, 201); const stored = JSON.stringify(ctx.data.get('room')); assert.equal(stored.includes(ownerToken), false); assert.equal(ctx.data.get('room').ownerHash.length, 64);
});
test('alarm removes expired pending/pairing data and closes expired unauthenticated sockets', async () => {
 const deviceId = randomUUID(); const ctx = context({ownerHash: 'hashed', devices: {}, pending: {deviceId, expiresAt: Date.now() - 1}, pairing: {expiresAt: Date.now() - 1}});
 const pending = socket({role: 'sender', deviceId}); const unauth = socket({deadline: Date.now() - 1}); ctx.sockets.push(pending, unauth);
 await new Room(ctx, {}).alarm();
 assert.equal(pending.closed, true); assert.equal(unauth.closed, true); assert.equal(ctx.data.get('room').pending, undefined); assert.equal(ctx.data.get('room').pairing, undefined);
});
test('reconstructed room uses socket attachments; stale sender cannot relay after revocation', async () => {
 const deviceId = randomUUID(); const ctx = context({ownerHash: 'hashed', devices: {}}); const sender = socket({role: 'sender', deviceId}); ctx.sockets.push(sender);
 await new Room(ctx, {}).webSocketMessage(sender, JSON.stringify({type: 'relay', to: 'owner', envelope: {}}));
 assert.equal(sender.closed, true); assert.equal(sender.messages.at(-1).code, 'revoked');
});
test('invalid first frame and oversize frames close sockets', async () => {
 for (const frame of ['null', '{', JSON.stringify({type: 'relay'}), 'x'.repeat(28001)]) {
 const ctx = context({ownerHash: 'hashed', devices: {}}); const ws = socket({deadline: Date.now() + 1000}); ctx.sockets.push(ws);
 await new Room(ctx, {}).webSocketMessage(ws, frame); assert.equal(ws.closed, true);
 }
});
