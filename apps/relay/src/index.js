const TTL = 120_000;
const AUTH_TTL = 10_000;
const MAX_DEVICES = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64 = /^[A-Za-z0-9_-]+$/;
const json = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
const error = (code, status = 400) => json({type: 'error', code}, status);
function bytes(value, length) {
  if (typeof value !== 'string' || !B64.test(value) || value.length !== Math.ceil(length * 4 / 3)) return false;
  try { return atob(value.replace(/-/g, '+').replace(/_/g, '/')).length === length; } catch { return false; }
}
const nameOK = name => typeof name === 'string' && name.trim().length > 0 && new TextEncoder().encode(name).length <= 120 && !/[\u0000-\u001f\u007f]/.test(name);
async function hash(token) {
  if (!bytes(token, 32)) return null;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
}
async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('invalid_json');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_json');
  let size = 0; const chunks = [];
  for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > 2048) { await reader.cancel(); throw new Error('too_large'); } chunks.push(value); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  const result = JSON.parse(new TextDecoder().decode(all));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid_json');
  return result;
}
function originOK(request) { const origin = request.headers.get('Origin'); return !origin || origin === new URL(request.url).origin; }
function secure(request) { const u = new URL(request.url); return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!secure(request)) return error('https_required', 400);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!originOK(request)) return error('invalid_origin', 403);
    if (url.search) return error('query_not_allowed');
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const roomId = crypto.randomUUID();
      const response = await env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
      if (!response.ok) return response;
      return json({roomId}, 201);
    }
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/.*)?$/);
    if (!match || !UUID.test(match[1])) return error('not_found', 404);
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  }
};

export class Room {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  sockets() { return this.ctx.getWebSockets().filter(ws => !ws.deserializeAttachment()?.closed); }
  attachment(ws) { return ws.deserializeAttachment() || {}; }
  owner() { return this.sockets().find(ws => this.attachment(ws).role === 'owner'); }
  sender(id) { return this.sockets().find(ws => this.attachment(ws).role === 'sender' && this.attachment(ws).deviceId === id); }
  send(ws, data) { if (!ws) return false; try { ws.send(JSON.stringify(data)); return true; } catch { return false; } }
  close(ws, code = 'unauthorized') { this.send(ws, {type: 'error', code}); this.webSocketClose(ws); try { ws.close(1008, code); } catch {} }
  async schedule(state) {
    const times = this.sockets().map(ws => this.attachment(ws)).filter(a => !a.role).map(a => a.deadline);
    if (state?.pairing) times.push(state.pairing.expiresAt);
    if (state?.pending) times.push(state.pending.expiresAt);
    if (times.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }
  async expire(state) {
    const now = Date.now(); let changed = false;
    for (const ws of this.sockets()) { const a = this.attachment(ws); if (!a.role && a.deadline <= now) this.close(ws, 'auth_timeout'); }
    if (state?.pairing?.expiresAt <= now) { delete state.pairing; changed = true; }
    if (state?.pending?.expiresAt <= now) {
      const id = state.pending.deviceId; this.closeSender(id, 'pair_expired');
      this.send(this.owner(), {type: 'error', code: 'pair_expired'}); delete state.pending; changed = true;
    }
    if (changed) await this.ctx.storage.put('room', state);
    return state;
  }
  closeSender(id, code) { for (const ws of this.sockets()) if (this.attachment(ws).deviceId === id) this.close(ws, code); }
  fetch(request) { return this.ctx.blockConcurrencyWhile(async () => {
    try { return await this.handleFetch(request); } catch { return error('invalid_request'); }
  }); }
  async handleFetch(request) {
    if (!originOK(request) || !secure(request)) return error('forbidden', 403);
    const url = new URL(request.url);
    let state = await this.expire(await this.ctx.storage.get('room'));
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      if (state) return error('room_exists', 409);
      const b = await body(request);
      const ownerHash = await hash(b.ownerToken);
      if (!ownerHash || !bytes(b.ownerPublicKey, 32) || !nameOK(b.name)) return error('invalid_request');
      await this.ctx.storage.put('room', {ownerHash, ownerPublicKey: b.ownerPublicKey, name: b.name, devices: {}});
      return json({ok: true}, 201);
    }
    if (!state) return error('not_found', 404);
    const suffix = url.pathname.replace(/^\/api\/rooms\/[^/]+/, '');
    if (suffix === '/ws' && request.method === 'GET') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error('upgrade_required', 426);
      if (this.sockets().length >= 20 || this.sockets().filter(ws => !this.attachment(ws).role).length >= 4) return error('connection_limit', 429);
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({deadline: Date.now() + AUTH_TTL});
      await this.schedule(state);
      return new Response(null, {status: 101, webSocket: client});
    }
    const auth = request.headers.get('Authorization') || '';
    const tokenHash = auth.startsWith('Bearer ') ? await hash(auth.slice(7)) : null;
    const isOwner = !!tokenHash && tokenHash === state.ownerHash;
    const deviceMatch = suffix.match(/^\/devices\/([^/]+)$/);
    if (deviceMatch && request.method === 'DELETE') {
      const id = deviceMatch[1]; const device = state.devices[id] || (state.pending?.deviceId === id ? state.pending : null);
      if (!isOwner && !(tokenHash && device?.tokenHash === tokenHash)) return error('unauthorized', 401);
      if (!device) return error('not_found', 404);
      delete state.devices[id]; if (state.pending?.deviceId === id) delete state.pending;
      await this.ctx.storage.put('room', state); this.closeSender(id, 'revoked');
      this.send(this.owner(), {type: 'peer-revoked', deviceId: id});
      await this.schedule(state); return json({ok: true});
    }
    if (suffix === '/pair' && request.method === 'POST') {
      const b = await body(request);
      if (!this.owner()) return error('owner_offline', 409);
      if (state.pending) return error('pair_pending', 409);
      if (Object.keys(state.devices).length >= MAX_DEVICES) return error('device_limit', 429);
      const pairingHash = await hash(b.pairToken); const tokenHash = await hash(b.clientToken);
      if (!state.pairing || !pairingHash || state.pairing.tokenHash !== pairingHash) return error('unauthorized', 401);
      if (!(typeof b.deviceId === 'string' && UUID.test(b.deviceId)) || !bytes(b.publicKey, 32) || !nameOK(b.name) || !tokenHash || state.devices[b.deviceId]) return error('invalid_request');
      state.pending = {deviceId: b.deviceId, publicKey: b.publicKey, name: b.name, tokenHash, expiresAt: Date.now() + TTL};
      delete state.pairing;
      await this.ctx.storage.put('room', state); await this.schedule(state);
      this.send(this.owner(), {type: 'pair-request', deviceId: b.deviceId, publicKey: b.publicKey, name: b.name});
      return json({status: 'pending'});
    }
    if (!isOwner) return error('unauthorized', 401);
    if (suffix === '/pairing' && request.method === 'POST') {
      const b = await body(request); const tokenHash = await hash(b.pairToken);
      if (!tokenHash) return error('invalid_request');
      if (state.pending) return error('pair_pending', 409);
      state.pairing = {tokenHash, expiresAt: Date.now() + TTL};
      await this.ctx.storage.put('room', state); await this.schedule(state);
      return json({expiresAt: state.pairing.expiresAt});
    }
    if (suffix === '/devices' && request.method === 'GET') return json({devices: Object.values(state.devices).map(({deviceId, publicKey, name}) => ({deviceId, publicKey, name}))});
    if (suffix === '' && request.method === 'DELETE') {
      for (const ws of this.sockets()) this.close(ws, 'room_deleted');
      await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); return json({ok: true});
    }
    return error('not_found', 404);
  }
  webSocketMessage(ws, message) { return this.ctx.blockConcurrencyWhile(async () => {
    const state = await this.expire(await this.ctx.storage.get('room'));
    const a = this.attachment(ws);
    if (a.closed) return;
    if (!state) return this.close(ws, 'room_deleted');
    if (typeof message !== 'string' || new TextEncoder().encode(message).length > 28_000) return this.close(ws, 'invalid_message');
    let m; try { m = JSON.parse(message); } catch { return this.close(ws, 'invalid_message'); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return this.close(ws, 'invalid_message');
    const now = Date.now();
    const rate = now - (a.window || 0) >= 1000 ? {window: now, count: 1} : {window: a.window, count: (a.count || 0) + 1};
    if (rate.count > 30) return this.close(ws, 'rate_limited');
    ws.serializeAttachment({...a, ...rate});
    if (!a.role) {
      if (m.type !== 'auth') return this.close(ws, 'unauthorized');
      const tokenHash = await hash(m.token);
      if (!tokenHash) return this.close(ws, 'unauthorized');
      if (m.role === 'owner' && tokenHash === state.ownerHash) {
        const old = this.owner(); if (old) this.close(old, 'replaced');
        ws.serializeAttachment({...rate, role: 'owner'});
        this.send(ws, {type: 'authenticated', role: 'owner', status: 'approved'});
        if (state.pending) { const {deviceId, publicKey, name} = state.pending; this.send(ws, {type: 'pair-request', deviceId, publicKey, name}); }
        for (const s of this.sockets()) if (this.attachment(s).role === 'sender') {
          const device = state.devices[this.attachment(s).deviceId];
          this.send(s, {type: 'owner-online'});
          if (device) this.send(ws, {type: 'peer-online', deviceId: device.deviceId, publicKey: device.publicKey, name: device.name});
        }
      } else if (m.role === 'sender' && typeof m.deviceId === 'string' && UUID.test(m.deviceId)) {
        const device = state.devices[m.deviceId] || (state.pending?.deviceId === m.deviceId ? state.pending : null);
        if (!device || device.tokenHash !== tokenHash) return this.close(ws, 'unauthorized');
        const old = this.sender(m.deviceId); if (old) this.close(old, 'replaced');
        ws.serializeAttachment({...rate, role: 'sender', deviceId: m.deviceId});
        this.send(ws, {type: 'authenticated', role: 'sender', status: state.devices[m.deviceId] ? 'approved' : 'pending'});
        if (this.owner()) {
          this.send(ws, {type: 'owner-online'});
          if (state.devices[m.deviceId]) this.send(this.owner(), {type: 'peer-online', deviceId: device.deviceId, publicKey: device.publicKey, name: device.name});
        } else this.send(ws, {type: 'owner-offline'});
      } else return this.close(ws, 'unauthorized');
      await this.schedule(state); return;
    }
    if (a.role === 'sender' && !state.devices[a.deviceId] && state.pending?.deviceId !== a.deviceId) return this.close(ws, 'revoked');
    if (a.role === 'owner' && ['pair-approve', 'pair-reject'].includes(m.type)) {
      if (!state.pending || state.pending.deviceId !== m.deviceId) return this.send(ws, {type: 'error', code: 'no_pending_pair'});
      const device = state.pending; delete state.pending;
      if (m.type === 'pair-approve') {
        const {expiresAt, ...approved} = device; state.devices[device.deviceId] = approved;
        await this.ctx.storage.put('room', state);
        const event = {type: 'pair-approved', deviceId: device.deviceId};
        this.send(ws, event); this.send(this.sender(device.deviceId), event);
        if (this.sender(device.deviceId)) this.send(ws, {type: 'peer-online', deviceId: device.deviceId, publicKey: device.publicKey, name: device.name});
      } else { await this.ctx.storage.put('room', state); this.closeSender(device.deviceId, 'pair_rejected'); this.send(ws, {type: 'pair-rejected', deviceId: device.deviceId}); }
      await this.schedule(state); return;
    }
    if (m.type !== 'relay') return this.send(ws, {type: 'error', code: 'invalid_message'});
    const e = m.envelope;
    if (!e || e.v !== 1 || !bytes(e.nonce, 24) || typeof e.ciphertext !== 'string' || !B64.test(e.ciphertext) || e.ciphertext.length < 22 || e.ciphertext.length > 26_688) return this.send(ws, {type: 'error', code: 'invalid_envelope'});
    let peer;
    if (a.role === 'owner' && typeof m.to === 'string' && state.devices[m.to]) peer = this.sender(m.to);
    else if (a.role === 'sender' && state.devices[a.deviceId] && m.to === 'owner') peer = this.owner();
    else return this.send(ws, {type: 'error', code: 'forbidden'});
    // Explicitly project the opaque envelope: no attacker-supplied extra fields are forwarded or stored.
    if (!this.send(peer, {type: 'data', from: a.role === 'owner' ? 'owner' : a.deviceId, envelope: {v: 1, nonce: e.nonce, ciphertext: e.ciphertext}})) this.send(ws, {type: 'error', code: 'peer_offline'});
  }); }
  webSocketClose(ws) {
    const a = this.attachment(ws); if (a.closed) return;
    ws.serializeAttachment({...a, closed: true});
    if (a.role === 'owner') { for (const s of this.sockets()) if (this.attachment(s).role === 'sender') this.send(s, {type: 'owner-offline'}); }
    if (a.role === 'sender') this.send(this.owner(), {type: 'peer-offline', deviceId: a.deviceId});
  }
  webSocketError(ws) { this.webSocketClose(ws); try { ws.close(1011, 'socket_error'); } catch {} }
  alarm() { return this.ctx.blockConcurrencyWhile(async () => { const state = await this.expire(await this.ctx.storage.get('room')); await this.schedule(state); }); }
}
