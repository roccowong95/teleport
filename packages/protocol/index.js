import nacl from 'tweetnacl';
const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });
export const MAX_TEXT_BYTES = 8192;
export const TTL_MS = 15000;
export const utf8Length = text => te.encode(text).length;
export function base64url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
export function unbase64url(s, length) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s) || s.length > 40000) throw new Error('invalid_encoding');
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  if ((length !== undefined && bytes.length !== length) || base64url(bytes) !== s) throw new Error('invalid_encoding');
  return bytes;
}
export function randomToken() { return base64url(nacl.randomBytes(32)); }
export function generateIdentity() {
  const pair = nacl.box.keyPair();
  return { publicKey: base64url(pair.publicKey), secretKey: base64url(pair.secretKey) };
}
export function validEndpoint(input) {
  const u = new URL(input);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('invalid_endpoint');
  return u.origin;
}
export function encodePairing(pair) { validatePairing(pair); return base64url(te.encode(JSON.stringify(pair))); }
export function decodePairing(encoded, now = Date.now()) {
  if (typeof encoded !== 'string' || encoded.length > 4096) throw new Error('invalid_pairing');
  const pair = JSON.parse(td.decode(unbase64url(encoded))); validatePairing(pair, now); return pair;
}
function validatePairing(p, now = Date.now()) {
  if (!p || p.v !== 1 || typeof p.roomId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(p.roomId) || typeof p.name !== 'string' || p.name.length > 80) throw new Error('invalid_pairing');
  validEndpoint(p.endpoint); unbase64url(p.pairToken, 32); unbase64url(p.ownerPublicKey, 32);
  if (!Number.isSafeInteger(p.expiresAt) || p.expiresAt <= now || p.expiresAt > now + 125000) throw new Error('pairing_expired');
}
function checkedKeys(peerPublicKey, secretKey) {
  const pk = unbase64url(peerPublicKey, 32), sk = unbase64url(secretKey, 32);
  if (!nacl.scalarMult(sk, pk).some(b => b !== 0)) throw new Error('invalid_peer_key');
  return { pk, sk };
}
function validateContext(c) {
  if (!c || typeof c.roomId !== 'string' || typeof c.sender !== 'string' || typeof c.recipient !== 'string' || !c.roomId || !c.sender || !c.recipient) throw new Error('invalid_context');
}
export function seal(payload, context, peerPublicKey, secretKey) {
  validateContext(context);
  const nonce = nacl.randomBytes(24);
  const bytes = te.encode(JSON.stringify({ v: 1, context, payload }));
  if (bytes.length > 20000) throw new Error('payload_too_large');
  const {pk,sk} = checkedKeys(peerPublicKey, secretKey);
  const ciphertext = nacl.box(bytes, nonce, pk, sk);
  return { v: 1, nonce: base64url(nonce), ciphertext: base64url(ciphertext) };
}
export function open(envelope, expected, peerPublicKey, secretKey) {
  validateContext(expected);
  if (!envelope || envelope.v !== 1) throw new Error('invalid_envelope');
  const ciphertext = unbase64url(envelope.ciphertext);
  if (ciphertext.length > 20016 || ciphertext.length < 16) throw new Error('invalid_envelope');
  const {pk,sk} = checkedKeys(peerPublicKey, secretKey);
  const bytes = nacl.box.open(ciphertext, unbase64url(envelope.nonce, 24), pk, sk);
  if (!bytes) throw new Error('authentication_failed');
  const msg = JSON.parse(td.decode(bytes));
  if (msg.v !== 1 || !msg.context || ['roomId','sender','recipient'].some(k => msg.context[k] !== expected[k])) throw new Error('context_mismatch');
  if (!msg.payload || typeof msg.payload !== 'object' || Array.isArray(msg.payload)) throw new Error('invalid_payload');
  return msg.payload;
}
export async function sas(secretKey, peerPublicKey, roomId) {
  const {pk,sk} = checkedKeys(peerPublicKey, secretKey);
  const shared = nacl.box.before(pk, sk);
  const label = te.encode('teleport-pair-v1:' + roomId + ':');
  const buf = new Uint8Array(label.length + shared.length); buf.set(label); buf.set(shared, label.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  shared.fill(0); buf.fill(0);
  return [...hash.slice(0, 6)].map(b => b.toString(16).padStart(2,'0')).join('').match(/.{4}/g).join('-').toUpperCase();
}
export class ReceiverGate {
  constructor(sessionId) { this.sessionId = sessionId; this.seen = new Map(); }
  accept(message, { now = Date.now(), paused = false, authorized = true } = {}) {
    if (!authorized) return { ok: false, code: 'unauthorized' };
    if (paused) return { ok: false, code: 'paused' };
    if (!message || message.kind !== 'text' || typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(message.id)) return { ok: false, code:'invalid_message' };
    if (message.sessionId !== this.sessionId) return { ok:false, code:'session_mismatch' };
    if (!Number.isSafeInteger(message.sentAt) || !Number.isSafeInteger(message.expiresAt) || message.sentAt > now + 5000 || message.expiresAt <= now || message.expiresAt - message.sentAt > TTL_MS || message.expiresAt <= message.sentAt) return {ok:false,code:'expired'};
    if (typeof message.text !== 'string' || message.text.length === 0 || utf8Length(message.text) > MAX_TEXT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message.text)) return {ok:false,code:'invalid_text'};
    for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
    if (this.seen.has(message.id)) return {ok:false,code:'duplicate'};
    if (this.seen.size >= 1024) return {ok:false,code:'rate_limited'};
    this.seen.set(message.id, message.expiresAt);
    return {ok:true};
  }
}
