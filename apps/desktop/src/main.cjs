const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, safeStorage, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isTrustedSender } = require('./ipc-guard.cjs');
let window, tray, receiver;
function show() { if (window && !window.isDestroyed()) { window.show(); window.focus(); } }
app.on('second-instance', show);
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
else app.whenReady().then(async () => {
  const { Receiver } = await import('./controller.mjs');
  const { EncryptedStore } = await import('./store.mjs');
  const { MacAdapter, WindowsAdapter, DryRunAdapter, UnsupportedAdapter } = await import('./adapters.mjs');
  const { default: WebSocket } = await import('ws');
  const QRCode = require('qrcode');
  receiver = new Receiver({store:new EncryptedStore(path.join(app.getPath('userData'),'identity.enc'),safeStorage),adapter:process.env.TELEPORT_DRY_RUN === '1' ? new DryRunAdapter() : process.platform === 'darwin' ? new MacAdapter() : process.platform === 'win32' ? new WindowsAdapter() : new UnsupportedAdapter(),WebSocketImpl:WebSocket});
  window = new BrowserWindow({width:520,height:730,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (!app.isQuitting) { event.preventDefault(); window.hide(); } });
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVR42mNk+P+/HgMlgImBQjAAAJ0IAxX+pRWnAAAAAElFTkSuQmCC');
  tray = new Tray(icon); tray.setTitle('⇥'); tray.setToolTip('Teleport — paused');
  const updateMenu = () => { tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Teleport',click:show},{label:receiver.paused?'Resume input':'Pause input',click:() => receiver.pause(!receiver.paused).catch(() => {})},{label:receiver.stopped?'Connect to relay':'Disconnect from relay',enabled:!!receiver.state,click:() => receiver.stopped ? receiver.connect() : receiver.stop()},{type:'separator'},{label:'Quit',click:() => app.quit()}])); tray.setToolTip(`Teleport — ${receiver.paused?'paused':'ready'}`); };
  tray.on('click',show); updateMenu();
  receiver.on('status', state => { window.webContents.send('status',state); updateMenu(); });
  receiver.on('notice', message => window.webContents.send('notice',message));
  receiver.on('pair-request', request => { show(); window.webContents.send('pair-request',request); });
  // Narrow trusted renderer API. Reject subframes and all other renderers.
  const expectedURL = pathToFileURL(path.join(__dirname,'index.html')).href;
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event, window, expectedURL)) throw new Error('Untrusted IPC sender');
    return callback(event, ...args);
  });
  handle('status', () => receiver.status());
  handle('setup', (_, value) => receiver.setup(value.endpoint,value.name));
  handle('pairing', async () => { const result = await receiver.pairing(); return {...result, qr:await QRCode.toDataURL(result.url)}; });
  handle('approve', (_, id, confirmed) => receiver.approve(String(id),confirmed === true));
  handle('connection', (_, connected) => { if (connected === true) receiver.connect(); else receiver.stop(); });
  handle('pause', (_, paused) => receiver.pause(paused === true));
  handle('revoke', (_, id) => receiver.revoke(String(id)));
  handle('reset', async () => { const result = await dialog.showMessageBox(window, {type:'warning',buttons:['Cancel','Delete room and reset'],defaultId:0,cancelId:0,message:'Delete this room and all paired phones?',detail:'This removes this computer’s saved identity. You must pair again after setup.'}); if (result.response === 1) await receiver.reset(); });
  await window.loadFile(path.join(__dirname,'index.html'));
  try { await receiver.initialize(); if (receiver.state) receiver.connect(); } catch { await dialog.showMessageBox(window,{type:'error',message:'Secure credential storage unavailable or unreadable. Teleport is stopped. Enable your OS keychain and relaunch.'}); app.quit(); return; }
  show();
});
app.on('before-quit', () => { app.isQuitting = true; receiver?.stop(); });
app.on('window-all-closed', () => {});
