const $ = id => document.getElementById(id); let state, pending, expiryTimer;
async function action(fn) { try { $('notice').textContent = ''; await fn(); } catch { $('notice').textContent = 'Action failed. Check the relay, connection, or expired pairing and retry.'; } }
function render(value) {
 state = value; $('setup').hidden = value.configured; $('receiver').hidden = !value.configured;
 $('computer').textContent = value.name || ''; $('connection').textContent = `${value.connected ? 'Relay connected' : 'Relay offline'} · ${value.paused ? 'Input paused' : 'Input enabled'}`;
 $('connectionToggle').textContent = value.disconnected ? 'Connect to relay' : 'Disconnect';
 $('target').textContent = value.targetLabel; $('pause').textContent = value.paused ? 'Resume input' : 'Pause input'; $('newPair').disabled = !value.connected;
 $('devices').replaceChildren(); for (const device of value.devices) { const li=document.createElement('li'); li.append(document.createTextNode(`${device.name} · ${device.online?'online':'offline'} `)); const button=document.createElement('button'); button.textContent='Revoke'; button.onclick=()=>action(()=>window.teleport.revoke(device.deviceId)); li.append(button); $('devices').append(li); }
 if (!value.connected || !value.configured) { $('approval').hidden=true; pending=null; $('qr').hidden=true; }
}
$('setupForm').onsubmit = event => { event.preventDefault(); action(()=>window.teleport.setup({endpoint:$('endpoint').value,name:$('name').value})); };
$('connectionToggle').onclick = ()=>action(()=>window.teleport.connection(state.disconnected));
$('reset').onclick = ()=>action(()=>window.teleport.reset());
$('pause').onclick = ()=>action(()=>window.teleport.pause(!state.paused));
$('newPair').onclick = ()=>action(async()=>{ const pair=await window.teleport.pairing(); $('qrImage').src=pair.qr; $('pairUrl').value=pair.url; $('qr').hidden=false; $('expiry').textContent='Expires in two minutes. Keep this link private.'; clearTimeout(expiryTimer); expiryTimer=setTimeout(()=>{ $('qr').hidden=true; $('pairUrl').value=''; $('qrImage').removeAttribute('src'); },Math.max(0,pair.expiresAt-Date.now())); });
window.teleport.on('status',render); window.teleport.on('notice',message=>{ $('notice').textContent=message; });
window.teleport.on('pair-request',request=>{ pending=request; $('phoneName').textContent=request.name; $('sas').textContent=request.sas; $('approval').hidden=false; $('qr').hidden=true; });
for (const [button,confirmed] of [['approve',true],['reject',false]]) $(button).onclick=()=>action(async()=>{ if (!pending) return; await window.teleport.approve(pending.deviceId,confirmed); pending=null; $('approval').hidden=true; });
window.teleport.status().then(render);

function renderPermissions(value) {
  $('permissions').hidden = !value.supported;
  const label = status => status === 'denied' ? 'Not granted (denied)' : status;
  $('permissionStatus').textContent = `Accessibility: ${label(value.accessibility)}. Event posting: ${label(value.postEvent)}.`;
  $('permissionError').textContent = value.error || '';
}
let permissionActionPending = false;
async function permissionAction(kind) {
  if (permissionActionPending) return;
  permissionActionPending = true;
  for (const id of ['checkPermissions','requestAccessibility','requestPostEvent']) $(id).disabled = true;
  try { renderPermissions(kind ? await window.teleport.permissionsRequest(kind) : await window.teleport.permissionsCheck()); }
  catch { renderPermissions({supported:true,accessibility:'unknown',postEvent:'unknown',error:'Could not determine permissions (unknown, not a denial). Review macOS settings and recheck; input has not been enabled.'}); }
  finally { permissionActionPending = false; for (const id of ['checkPermissions','requestAccessibility','requestPostEvent']) $(id).disabled = false; }
}
$('checkPermissions').onclick = () => permissionAction();
$('requestAccessibility').onclick = () => permissionAction('accessibility');
$('requestPostEvent').onclick = () => permissionAction('postEvent');
window.teleport.on('permissions',renderPermissions);
// Read-only status check; permission requests require explicit button clicks.
const initialPermissionCheck = permissionAction();
