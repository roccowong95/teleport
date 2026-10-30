const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('teleport', {
  permissionsCheck: () => ipcRenderer.invoke('permissions-check'),
  permissionsRequest: kind => ipcRenderer.invoke('permissions-request', kind),
  connection: connected => ipcRenderer.invoke('connection', connected),
  reset: () => ipcRenderer.invoke('reset'),
  status: () => ipcRenderer.invoke('status'), setup: value => ipcRenderer.invoke('setup',value), pairing: () => ipcRenderer.invoke('pairing'),
  approve: (id, confirmed) => ipcRenderer.invoke('approve',id,confirmed), pause: paused => ipcRenderer.invoke('pause',paused), revoke: id => ipcRenderer.invoke('revoke',id),
  on: (event, fn) => { if (!['status','notice','pair-request','permissions'].includes(event)) return; ipcRenderer.on(event, (_, value) => fn(value)); }
});
