import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { generateIdentity, randomToken, encodePairing, seal, open, sas, ReceiverGate } from '@teleport/protocol';
export function normalizeEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use the relay origin only.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('HTTPS required except localhost development.');
  return url.origin;
}
export class Receiver extends EventEmitter {
  constructor({ store, adapter, fetchImpl = fetch, WebSocketImpl, now = Date.now }) {
    super(); Object.assign(this, { store, adapter, fetchImpl, WebSocketImpl, now });
    this.paused = true; this.pending = new Map(); this.online = new Set(); this.queue = Promise.resolve(); this.connected = false;
  }
  async initialize() { this.state = await this.store.load(); return this.status(); }
  status() { return { configured: !!this.state, disconnected: !!this.stopped, connected: this.connected, paused: this.paused, name: this.state?.name, endpoint: this.state?.endpoint, targetLabel: this.adapter.label, devices: Object.entries(this.state?.peers || {}).map(([deviceId, p]) => ({deviceId, name: p.name, online: this.online.has(deviceId)})) }; }
  changed() { this.emit('status', this.status()); }
  async request(path, body, method = 'POST') {
    const res = await this.fetchImpl(`${this.state.endpoint}/api/rooms${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.state.ownerToken}` }, ...(body ? {body: JSON.stringify(body)} : {}) });
    if (!res.ok) { const error = new Error(`relay_http_${res.status}`); error.status = res.status; throw error; }
    return res.status === 204 ? {} : res.json();
  }
  async setup(endpoint, name) {
    if (this.state) throw new Error('Already configured; delete the room before replacing it.');
    endpoint = normalizeEndpoint(endpoint); name = String(name).trim().slice(0, 80);
    if (!name) throw new Error('Computer name is required.');
    const identity = generateIdentity();
    this.state = { endpoint, name, ...identity, ownerToken: randomToken(), peers: {} };
    try { const result = await this.request('', {ownerToken: this.state.ownerToken, ownerPublicKey: identity.publicKey, name}); this.state.roomId = result.roomId; await this.store.save(this.state); }
    catch (error) { this.state = null; throw error; }
    this.connect(); this.changed();
  }
  connect({ retry = false } = {}) {
    if (retry && this.stopped) return;
    this.paused = true; // Every new transport session requires explicit local resume.
    if (!retry) { this.stopped = false; this.retryAttempt = 0; }
    if (!this.state) throw new Error('Not configured');
    this.socket?.close(); clearTimeout(this.retry); const generation = this.generation = (this.generation || 0) + 1;
    this.sessionId = randomUUID(); this.gate = new ReceiverGate(this.sessionId); this.connected = false; this.online.clear(); this.pending.clear();
    const url = new URL(`/api/rooms/${this.state.roomId}/ws`, this.state.endpoint); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket = new this.WebSocketImpl(url.toString());
    socket.on('open', () => { if (generation === this.generation && this.state) socket.send(JSON.stringify({type:'auth', role:'owner', token:this.state.ownerToken})); });
    socket.on('message', data => {
      this.queue = this.queue.then(async () => { if (generation !== this.generation) return; await this.receive(JSON.parse(data.toString())); }).catch(() => this.emit('notice', 'Message refused or connection error.'));
    });
    socket.on('error', () => this.emit('notice', 'Relay connection failed.'));
    socket.on('close', () => { if (generation !== this.generation) return; this.connected = false; this.online.clear(); this.pending.clear(); this.changed(); if (!this.stopped) { const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retryAttempt || 0, 5)); this.retryAttempt = (this.retryAttempt || 0) + 1; this.retry = setTimeout(() => this.connect({retry:true}), delay); } });
    this.changed();
  }
  stop() { this.paused = true; this.stopped = true; clearTimeout(this.retry); this.generation++; this.socket?.close(); this.connected = false; this.online.clear(); this.pending.clear(); this.changed(); }
  send(value) { if (this.socket?.readyState !== 1) throw new Error('relay_offline'); this.socket.send(JSON.stringify(value)); }
  async encrypted(deviceId, payload) { const peer = this.state.peers[deviceId]; if (!peer) return; const envelope = await seal(payload, {roomId:this.state.roomId,sender:'owner',recipient:deviceId}, peer.publicKey, this.state.secretKey); this.send({type:'relay',to:deviceId,envelope}); }
  ready(deviceId) { return this.encrypted(deviceId, {kind:'ready',sessionId:this.sessionId,targetLabel:this.adapter.label,paused:this.paused}); }
  async pause(value) { this.paused = !!value; for (const id of this.online) await this.ready(id); this.changed(); }
  async pairing() {
    if (!this.connected) throw new Error('Connect to relay first.');
    const pairToken = randomToken(); const {expiresAt} = await this.request(`/${this.state.roomId}/pairing`, {pairToken});
    const pairing = {v:1,endpoint:this.state.endpoint,roomId:this.state.roomId,pairToken,ownerPublicKey:this.state.publicKey,name:this.state.name,expiresAt};
    return {url:`${this.state.endpoint}/#pair=${encodePairing(pairing)}`,expiresAt};
  }
  async approve(deviceId, confirmed) {
    const pending = this.pending.get(deviceId);
    if (!pending || pending.expiresAt <= this.now()) throw new Error('pairing_expired');
    if (!confirmed) { this.pending.delete(deviceId); this.send({type:'pair-reject',deviceId}); return; }
    // Persist only after the human confirms the SAS, but BEFORE relay approval.
    // If approval succeeds and its reply is lost, a reconnect can still recognize
    // the approved phone. An unapproved relay peer cannot send application data.
    const nextState = {...this.state, peers:{...this.state.peers, [deviceId]:{publicKey:pending.publicKey,name:pending.name}}};
    await this.store.save(nextState);
    this.state = nextState; pending.confirmed = true;
    this.send({type:'pair-approve',deviceId});
  }
  async revoke(deviceId) {
    try { await this.request(`/${this.state.roomId}/devices/${encodeURIComponent(deviceId)}`, null, 'DELETE'); }
    catch (error) { if (error.status !== 404) throw error; } // Definitive absence permits clearing an orphaned local pin.
    delete this.state.peers[deviceId]; this.online.delete(deviceId); await this.store.save(this.state); this.changed();
  }
  async reset() {
    if (!this.state) return;
    await this.request(`/${this.state.roomId}`, null, 'DELETE');
    this.stop(); this.pending.clear(); this.paused = true;
    await this.store.save(null); this.state = null; this.changed();
  }
  async receive(message) {
    const id = message.deviceId;
    switch (message.type) {
      case 'authenticated': this.retryAttempt = 0; this.connected = true; this.changed(); break;
      case 'pair-request': {
        const pinned = this.state.peers[id];
        if (pinned && pinned.publicKey !== message.publicKey) { this.emit('notice','Changed public key refused. Revoke this device before pairing again.'); return; }
        // An earlier explicit approval may have been saved locally but lost in transit.
        // Re-present the same pinned key for human confirmation; never replace it.
        this.pending.set(id, {...message, confirmed:false, expiresAt:this.now()+120000});
        this.emit('pair-request', {deviceId:id,name:message.name,sas:await sas(this.state.secretKey,message.publicKey,this.state.roomId)}); break;
      }
      case 'pair-approved': {
        const p = this.pending.get(id);
        if (!p?.confirmed || p.expiresAt <= this.now()) return;
        this.pending.delete(id); this.online.add(id); await this.ready(id); this.changed(); break;
      }
      case 'peer-online': {
        const peer = this.state.peers[id];
        if (!peer || peer.publicKey !== message.publicKey) { this.emit('notice','Untrusted device or changed public key refused.'); return; }
        this.online.add(id); await this.ready(id); this.changed(); break;
      }
      case 'peer-offline': this.online.delete(id); this.changed(); break;
      case 'peer-revoked': delete this.state.peers[id]; this.online.delete(id); await this.store.save(this.state); this.changed(); break;
      case 'data': await this.receiveText(message); break;
      case 'error': this.emit('notice', `Relay: ${String(message.code).slice(0,80)}`); break;
    }
  }
  async receiveText(message) {
    const id = message.from, peer = this.state.peers[id]; if (!peer || !this.online.has(id)) return;
    const payload = await open(message.envelope, {roomId:this.state.roomId,sender:id,recipient:'owner'}, peer.publicKey, this.state.secretKey);
    const result = this.gate.accept(payload, {paused:this.paused,authorized:true,now:this.now()});
    if (!result.ok) { if (typeof payload?.id === 'string') await this.encrypted(id,{kind:'ack',id:payload.id,status:'rejected',code:result.code}); return; }
    // Legacy adapters do not implement a distinct Enter action. Never silently downgrade it.
    if (payload.pressEnter === true) { await this.encrypted(id,{kind:'ack',id:payload.id,status:'rejected',code:'unsupported_action'}); return; }
    let status = 'injected', code;
    try { await this.adapter.inject(payload.text); } catch { status = 'unknown'; code = 'injection_unconfirmed'; }
    await this.encrypted(id,{kind:'ack',id:payload.id,status,...(code ? {code} : {})});
  }
}
