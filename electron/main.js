'use strict';

const { app, Tray, Menu, shell, nativeImage, dialog, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');

// Redirect data writes to userData — the app bundle is read-only once installed
process.env.SYNTHONY_DATA_DIR = app.getPath('userData');

// Tray-only app — no dock icon
app.dock?.hide();

// Single instance guard
if (!app.requestSingleInstanceLock()) { app.quit(); }

const PORT = 3001;
let tray   = null;

function waitForServer(cb, tries = 0) {
  http.get(`http://127.0.0.1:${PORT}/`, () => cb()).on('error', () => {
    if (tries < 40) setTimeout(() => waitForServer(cb, tries + 1), 300);
    else dialog.showErrorBox('Synthony Cue', `Server failed to start on port ${PORT}.\nCheck that nothing else is using that port.`);
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
    { label: 'Check for Updates', click: () => autoUpdater.checkForUpdatesAndNotify() },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Quit Synthony Cue', click: () => app.quit() }
  ];
}

function refreshTray(updateReady = false) {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(buildMenuItems(updateReady)));
}

app.whenReady().then(() => {
  // Start the Express server in-process
  require('../server');

  const iconPath = path.join(__dirname, 'iconTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('Synthony Cue');
  tray.on('click', () => tray.popUpContextMenu());
  refreshTray();

  // Open admin in browser once the server is accepting connections
  waitForServer(() => shell.openExternal(`http://localhost:${PORT}/admin`));

  autoUpdater.checkForUpdatesAndNotify();
});

autoUpdater.on('update-downloaded', () => {
  tray?.setToolTip('Synthony Cue — Update ready');
  refreshTray(true);
  if (Notification.isSupported()) {
    new Notification({
      title: 'Synthony Cue update ready',
      body: 'Right-click the menu bar icon and choose Restart to apply.'
    }).show();
  }
});

// Keep running when all browser windows close
app.on('window-all-closed', () => {});
