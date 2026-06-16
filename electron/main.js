'use strict';

const { app, Tray, Menu, shell, nativeImage, dialog, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');
const fs   = require('fs');

// ── Logging ───────────────────────────────────────────────────────────────────
const LOG_PATH = path.join(app.getPath('userData'), 'synthony-cue.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}

log('Starting Synthony Cue', app.getVersion());
log('Log file:', LOG_PATH);
log('userData:', app.getPath('userData'));

process.on('uncaughtException',  (err) => log('[uncaughtException]', err.message, err.stack));
process.on('unhandledRejection', (err) => log('[unhandledRejection]', err?.message ?? err));

// Redirect data writes to userData — the app bundle is read-only once installed
process.env.SYNTHONY_DATA_DIR = app.getPath('userData');

// Single instance guard
if (!app.requestSingleInstanceLock()) { app.quit(); }

const PORT = 3001;
let tray = null;

function quit() {
  log('Quitting');
  process.exit(0);
}

function waitForServer(cb, tries = 0) {
  http.get(`http://127.0.0.1:${PORT}/`, () => { log('Server ready on port', PORT); cb(); }).on('error', () => {
    if (tries < 40) setTimeout(() => waitForServer(cb, tries + 1), 300);
    else {
      log('Server failed to start after 40 tries');
      dialog.showErrorBox('Synthony Cue', `Server failed to start on port ${PORT}.\nCheck that nothing else is using that port.`);
    }
  });
}

function buildMenuItems(updateReady = false) {
  return [
    { label: 'Open Admin',      click: () => shell.openExternal(`http://localhost:${PORT}/admin`) },
    { label: 'Open Kiosk View', click: () => shell.openExternal(`http://localhost:${PORT}/`) },
    { type: 'separator' },
    ...(updateReady ? [
      { label: '⬆  Restart to apply update', click: () => autoUpdater.quitAndInstall() },
      { type: 'separator' }
    ] : []),
    { label: 'Check for Updates', click: () => { try { autoUpdater.checkForUpdatesAndNotify(); } catch {} } },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Quit Synthony Cue', click: quit }
  ];
}

function refreshTray(updateReady = false) {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(buildMenuItems(updateReady)));
}

app.whenReady().then(() => {
  log('App ready, starting server...');

  try {
    require('../server');
    log('Server module loaded');
  } catch (e) {
    log('Server failed to load:', e.message);
    dialog.showErrorBox('Synthony Cue', 'Server failed to load:\n' + e.message);
  }

  const icon = nativeImage.createFromPath(path.join(__dirname, 'iconTemplate.png'));
  tray = new Tray(icon);
  tray.setToolTip('Synthony Cue');
  tray.on('click', () => tray.popUpContextMenu());
  refreshTray();
  log('Tray created');

  waitForServer(() => shell.openExternal(`http://localhost:${PORT}/admin`));

  try { autoUpdater.checkForUpdatesAndNotify(); } catch (e) { log('Updater error:', e.message); }
});

autoUpdater.on('error', (err) => log('[updater error]', err.message));
autoUpdater.on('checking-for-update',  () => log('[updater] checking...'));
autoUpdater.on('update-available',     (i) => log('[updater] update available:', i.version));
autoUpdater.on('update-not-available', ()  => log('[updater] up to date'));
autoUpdater.on('update-downloaded', () => {
  log('[updater] update downloaded');
  tray?.setToolTip('Synthony Cue — Update ready');
  refreshTray(true);
  if (Notification.isSupported()) {
    new Notification({
      title: 'Synthony Cue update ready',
      body: 'Right-click the menu bar icon and choose Restart to apply.'
    }).show();
  }
});

app.on('window-all-closed', () => {});
app.on('before-quit', quit);
