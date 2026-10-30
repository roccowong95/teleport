import { generateIdentity, randomToken, decodePairing, seal, open, sas, utf8Length } from '@teleport/protocol';
import { validateEndpoint, retryDelay } from './security.mjs';
import './style.css';
import { ackMessage, sendBlockReason, unknownMessage } from './diagnostics.mjs';

type Device = { roomId: string; endpoint: string; name: string; ownerPublicKey: string; deviceId: string; clientToken: string; publicKey: string; secretKey: string; approved: boolean; enabled: boolean };
type Pair = { v: number; roomId: string; endpoint: string; name: string; ownerPublicKey: string; pairToken: string; expiresAt: number };
const KEY = 'teleport.devices.v1';
let devices: Device[] = [];
let storageError = false;
try { const value = JSON.parse(localStorage.getItem(KEY) || '[]'); devices = Array.isArray(value) ? value.filter(d => d && typeof d.roomId === 'string' && typeof d.secretKey === 'string' && typeof d.ownerPublicKey === 'string' && typeof d.clientToken === 'string' && typeof d.publicKey === 'string' && typeof d.deviceId === 'string' && typeof d.name === 'string' && (() => { try { validateEndpoint(d.endpoint, location.origin); return true; } catch { return false; } })()) : []; } catch { storageError = true; }
let active: Device | undefined = devices[0];
let pair: Pair | undefined;
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pending: { id: string; timer: ReturnType<typeof setTimeout>; startedAt: number } | undefined;
let sessionId = '';
let targetLabel = '';
let paused = false;
let connected = false;
let attempts = 0;
let pairingBusy = false;
let operationEpoch = 0;
let status = '尚未连接';
let result = '文字只在你点击发送时传输，不会自动重试。';
let sasCode = '';
let sendCount = 0;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header class="topbar"><a class="brand" href="/" aria-label="Teleport 首页"><span class="brandmark">T<span>↗</span></span>teleport<span class="beta">预览版</span></a><span class="private"><span class="lock">◇</span> 端到端加密</span></header>
<main><section class="intro"><div class="eyebrow">FROM PHONE, WITH FLOW</div><h1>想到，就送到<span>电脑光标。</span></h1><p>手机上写，电脑里用。让文字跨过设备的边界。</p></section>
<div class="workspace"><section class="composer card"><div class="section-head"><div><span class="step">01</span><h2>你的文字</h2></div><span id="counter" class="counter">0 / 8192 字节</span></div>
<label class="sr-only" for="draft">要发送到电脑的文字</label><textarea id="draft" placeholder="在这里输入、粘贴，或使用手机键盘的语音输入…" maxlength="8192" spellcheck="false"></textarea>
<div class="editor-foot"><span>↵ 换行不会发送</span><button id="clear" class="text-button" type="button">清空文字</button></div>
<div class="send-zone"><button id="send" class="primary send" type="button" aria-describedby="send-hint result" disabled><span>发送到电脑</span><span aria-hidden="true">↗</span></button><p id="send-hint" role="status" aria-live="polite">先连接一台电脑，再把光标放到输入位置。</p></div>
<div id="result-label" class="result-label">最近一次发送 / 操作结果</div><div id="result" class="result" role="status" aria-live="polite"></div></section>
<aside><section class="connection card"><div class="section-head"><div><span class="step">02</span><h2>连接电脑</h2></div><span id="status-dot" class="dot"></span></div>
<div id="pair-panel" hidden><div class="pair-illustration" aria-hidden="true">▯ <span>⟷</span> ▱</div><h3 id="pair-name"></h3><p>只连接你面前的电脑。下一步将显示核对码，请与电脑端逐字核对。</p><button id="pair" class="primary" type="button">开始安全配对</button></div>
<div id="empty"><div class="pair-illustration" aria-hidden="true">▯ <span>⟷</span> ▱</div><h3>扫一下，连接起来</h3><p>在电脑上打开 Teleport，使用手机相机扫描配对二维码。</p><ol><li>电脑端创建配对二维码</li><li>手机扫码，核对安全码</li><li>在电脑端批准连接</li></ol></div>
<div id="device-panel" hidden><label for="devices" class="field-label">接收设备</label><select id="devices"></select><div class="connection-status"><span id="status"></span><span id="target"></span></div><div id="sas-panel" class="sas" hidden><span>与电脑上显示的安全码核对</span><strong id="sas"></strong><small>完全一致后，才在电脑端批准。若不一致，请断开并重新扫码。</small></div><div class="device-actions"><button id="connect" class="secondary" type="button">连接</button><button id="forget" class="text-button danger" type="button">忘记设备</button></div></div>
</section><section class="note"><span class="note-icon">↳</span><div><h3>发送前，先安放光标</h3><p>文字会输入到电脑当前焦点窗口。请先点击目标输入框，并确认没有敏感内容或命令行。</p></div></section><section class="privacy-note"><h3>只让两端读懂</h3><p>服务器只转发密文，不保存正文。此浏览器会保存配对密钥；同源脚本或能访问此设备的人可能读取它。请勿在共用设备上配对。</p><button id="reset" class="text-button" type="button">重置此浏览器的全部配对</button></section></aside></div>
<footer><span>TELEPORT / 少一点复制，多一点顺畅。</span><span>不排队 · 不自动重发 · 草稿不自动清空</span></footer></main>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const draft = $<HTMLTextAreaElement>('draft');
function save() { try { localStorage.setItem(KEY, JSON.stringify(devices)); } catch { storageError = true; result = '无法保存配对密钥。本次连接可用，关闭页面后可能需要重新配对。'; } }
function update() {
 const bytes = utf8Length(draft.value);
 $('counter').textContent = `${bytes} / 8192 字节`;
 $('counter').classList.toggle('danger', bytes > 8192);
 const blockReason = sendBlockReason({ hasDevice: !!active, enabled: active?.enabled === true, online: navigator.onLine, connected: connected && socket?.readyState === WebSocket.OPEN, approved: active?.approved === true, ready: !!sessionId, paused, pending: !!pending, bytes });
 $<HTMLButtonElement>('send').disabled = !!blockReason;
 $('send-hint').textContent = blockReason || `将输入到：${targetLabel || '电脑当前焦点窗口'}。发送前请确认光标。`;
 $('send').querySelector('span')!.textContent = pending ? `等待电脑确认 · ${Math.max(0, 15 - Math.floor((Date.now() - pending.startedAt) / 1000))} 秒` : '发送到电脑';
 $('send').setAttribute('aria-busy', String(!!pending));
 $('result').textContent = result;
 $('status').textContent = status;
 $('target').textContent = sessionId ? (paused ? '接收已暂停' : '加密通道就绪') : '';
 $('status-dot').className = 'dot' + (connected && sessionId && !paused ? ' online' : '');
 $('device-panel').hidden = !active;
 $('empty').hidden = !!active || !!pair;
 $('pair-panel').hidden = !pair;
 $('sas-panel').hidden = !sasCode || !!active?.approved;
 $('sas').textContent = sasCode;
 $('connect').textContent = active?.enabled ? '断开连接' : '重新连接';
 $<HTMLButtonElement>('pair').disabled = pairingBusy;
 $('pair-name').textContent = pair ? `连接「${pair.name}」` : '';
 const select = $<HTMLSelectElement>('devices');
 const names = devices.map(d => `${d.deviceId}:${d.name}`).join('|');
 if (select.dataset.names !== names) { select.replaceChildren(...devices.map(d => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.name; return o; })); select.dataset.names = names; }
 select.value = active?.deviceId || '';
}
function unknown(reason = 'disconnected') { if (pending) { clearTimeout(pending.timer); pending = undefined; result = unknownMessage(reason); } }
function stop() { clearTimeout(reconnectTimer); reconnectTimer = undefined; const old = socket; socket = undefined; old?.close(); connected = false; sessionId = ''; targetLabel = ''; unknown(); }
function schedule() {
 if (!active?.enabled || reconnectTimer || !navigator.onLine || document.visibilityState === 'hidden') return;
 reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, retryDelay(attempts++));
}
async function connect() {
 stop();
 const device = active;
 if (!device?.enabled) return;
 if (!device.approved) sas(device.secretKey, device.ownerPublicKey, device.roomId).then(code => { if (active === device) { sasCode = code; update(); } }).catch(() => { status = '无法校验配对密钥，请重新扫码'; update(); });
 status = navigator.onLine ? '正在建立加密连接…' : '网络离线 · 草稿仍在'; update();
 if (!navigator.onLine) return;
 try {
  const origin = validateEndpoint(device.endpoint, location.origin);
  const url = new URL(`/api/rooms/${encodeURIComponent(device.roomId)}/ws`, origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url); socket = ws;
  const authTimeout = setTimeout(() => { if (socket === ws && !connected) ws.close(); }, 10000);
  ws.onopen = () => { if (socket === ws) ws.send(JSON.stringify({ type: 'auth', role: 'sender', deviceId: device.deviceId, token: device.clientToken })); };
  ws.onmessage = event => {
   if (socket !== ws) return;
   try {
    const message = JSON.parse(event.data);
    if (message.type === 'authenticated') { clearTimeout(authTimeout); connected = true; attempts = 0; device.approved = message.status === 'approved'; save(); status = device.approved ? '已连接 · 等待电脑就绪' : '等待电脑批准'; }
    else if (message.type === 'pair-approved') { device.approved = true; save(); status = '已批准 · 等待电脑就绪'; }
    else if (message.type === 'owner-offline') { sessionId = ''; unknown(); status = '电脑已离线'; }
    else if (message.type === 'owner-online') { sessionId = ''; status = '电脑在线 · 等待加密确认'; }
    else if (message.type === 'data' && message.from === 'owner') {
     const payload = open(message.envelope, { roomId: device.roomId, sender: 'owner', recipient: device.deviceId }, device.ownerPublicKey, device.secretKey);
     if (payload.kind === 'ready' && typeof payload.sessionId === 'string' && payload.sessionId.length > 0 && typeof payload.paused === 'boolean') { if (sessionId && sessionId !== payload.sessionId) unknown(); sessionId = payload.sessionId; paused = payload.paused; targetLabel = typeof payload.targetLabel === 'string' ? payload.targetLabel.slice(0, 200) : ''; status = paused ? '电脑已暂停' : '已安全连接'; }
     else if (payload.kind === 'ack' && pending && payload.id === pending.id) { clearTimeout(pending.timer); pending = undefined; result = ackMessage(payload.status, payload.code); }
    } else if (message.type === 'pair-rejected' || message.type === 'peer-revoked') { device.enabled = false; device.approved = false; save(); stop(); status = '配对已拒绝或撤销 · 请重新扫码'; }
    else if (message.type === 'error') {
     unknown();
     if (['unauthorized', 'forbidden', 'revoked', 'pair_expired', 'not_approved', 'auth_failed', 'invalid_auth'].includes(message.code)) { device.enabled = false; save(); stop(); status = '授权失效 · 请重新扫码配对'; }
     else { sessionId = ''; status = message.code === 'peer_offline' ? '电脑离线 · 未重发' : '连接暂不可用 · 请检查电脑'; }
    }
   } catch { sessionId = ''; unknown(); status = '安全校验失败 · 已停止发送'; }
   update();
  };
  ws.onclose = event => { clearTimeout(authTimeout); if (socket !== ws) return; socket = undefined; connected = false; sessionId = ''; unknown(); if ([4001,4003,4401,4403,1008].includes(event.code)) { device.enabled = false; save(); status = '连接授权失效 · 请重新配对'; } else { status = '连接中断 · 等待恢复'; schedule(); } update(); };
  ws.onerror = () => { /* onclose handles reconnect without logging secrets. */ };
 } catch { status = '无法连接：请检查安全地址与网络'; schedule(); update(); }
}
$('pair').onclick = async () => {
 if (!pair || pairingBusy) return;
 if (pair.expiresAt <= Date.now()) { result = '二维码已过期，请在电脑端重新生成。'; pair = undefined; update(); return; }
 pairingBusy = true; const operation = ++operationEpoch; update();
 try {
  const p = pair; p.endpoint = validateEndpoint(p.endpoint, location.origin);
  const identity = generateIdentity();
  const device: Device = { roomId: p.roomId, endpoint: p.endpoint, name: p.name, ownerPublicKey: p.ownerPublicKey, ...identity, deviceId: crypto.randomUUID(), clientToken: randomToken(), approved: false, enabled: true };
  const code = await sas(device.secretKey, device.ownerPublicKey, device.roomId);
  const response = await fetch(`${p.endpoint}/api/rooms/${encodeURIComponent(p.roomId)}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairToken: p.pairToken, deviceId: device.deviceId, publicKey: device.publicKey, name: '手机浏览器', clientToken: device.clientToken }), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('pair_failed');
  if (operation !== operationEpoch) return;
  stop(); devices.push(device); active = device; sasCode = code; save(); pair = undefined;
  result = '请核对两端安全码，完全一致后在电脑上批准。'; connect();
 } catch { if (operation !== operationEpoch) return; result = '配对未完成。请确认电脑在线，并重新生成二维码；不会自动重试。'; }
 finally { pairingBusy = false; update(); }
};
$('send').onclick = () => {
 update();
 if ($<HTMLButtonElement>('send').disabled || !active || !socket || socket.readyState !== WebSocket.OPEN) { result = '本次未发送。' + $('send-hint').textContent; update(); return; }
 const id = crypto.randomUUID(); const now = Date.now();
 $('result-label').textContent = `第 ${++sendCount} 次发送 · ${new Date(now).toLocaleTimeString('zh-CN', { hour12: false })}`;
 try {
  const envelope = seal({ kind: 'text', id, sessionId, text: draft.value, sentAt: now, expiresAt: now + 15000 }, { roomId: active.roomId, sender: active.deviceId, recipient: 'owner' }, active.ownerPublicKey, active.secretKey);
  pending = { id, startedAt: now, timer: setTimeout(() => { unknown('timeout'); update(); }, 15000) };
  socket.send(JSON.stringify({ type: 'relay', to: 'owner', envelope })); result = '本次已发出密文，正在等待电脑确认（最多 15 秒）。尚不能确定目标应用是否收到文字。';
 } catch { unknown(); result = '发送结果未知，请检查电脑。草稿已保留，不会自动重试。'; }
 update();
};
// Only redraw the countdown; never resend or persist the draft.
setInterval(() => { if (pending) update(); }, 1000);
draft.oninput = update;
$('clear').onclick = () => { if (draft.value && confirm('清空当前草稿？此操作无法撤销。')) { draft.value = ''; update(); draft.focus(); } };
$('connect').onclick = () => { if (!active) return; active.enabled = !active.enabled; save(); if (active.enabled) { attempts = 0; connect(); } else { stop(); status = '已手动断开 · 不会自动重连'; update(); } };
$('devices').onchange = () => { stop(); active = devices.find(d => d.deviceId === $<HTMLSelectElement>('devices').value)!; sasCode = ''; status = '尚未连接'; if (active.enabled) connect(); update(); };
$('forget').onclick = async () => {
 const d = active; if (!d || !confirm(`忘记「${d.name}」？将尝试撤销电脑端授权，并删除此浏览器中的配对密钥。`)) return;
 stop(); d.enabled = false; status = '正在忘记设备…'; update();
 let revoked = false;
 try { const r = await fetch(`${d.endpoint}/api/rooms/${encodeURIComponent(d.roomId)}/devices/${encodeURIComponent(d.deviceId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${d.clientToken}` }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) }); revoked = r.ok || r.status === 404; } catch { /* Local forgetting remains available offline. */ }
 devices = devices.filter(item => item !== d); active = devices[0]; save(); sasCode = ''; status = '尚未连接'; result = revoked ? '已撤销授权，并删除此浏览器的配对密钥。' : '已删除本地配对密钥，但未确认服务器撤销。请在电脑端删除该设备。'; update(); if (active?.enabled) connect();
};
$('reset').onclick = () => { if (!confirm('重置全部本地配对并清空当前草稿？这不会撤销服务器授权，请另在各电脑端删除该手机。')) return; operationEpoch++; stop(); devices = []; active = undefined; pair = undefined; sasCode = ''; save(); draft.value = ''; status = '已重置'; result = '已清除本地配对与草稿。请在电脑端删除旧设备以撤销授权。'; update(); };
window.addEventListener('online', () => { if (active?.enabled && !socket) { attempts = 0; connect(); } });
window.addEventListener('offline', () => { stop(); status = '网络离线 · 草稿仍在'; update(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && active?.enabled && !socket) connect(); });
try { const encoded = new URLSearchParams(location.hash.slice(1)).get('pair'); if (encoded) { history.replaceState(null, '', location.pathname + location.search); pair = decodePairing(encoded) as Pair; validateEndpoint(pair.endpoint, location.origin); if (pair.expiresAt <= Date.now()) throw new Error('expired'); } } catch { pair = undefined; result = '配对链接无效、已过期或来自其他站点。请使用电脑端新生成的二维码。'; }
if (storageError) result = '浏览器存储不可用或数据损坏；配对可能无法保存。请勿在共用设备上使用。';
update();
if (active?.enabled && !pair) connect();
