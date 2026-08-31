/*
 * EK050 Flight Widget - Electron Main-Prozess.
 *
 * Rahmenloses, verschiebbares, frei skalierbares Always-on-Top-Fenster.
 * Die Flugdaten werden hier (und nicht im Renderer) geholt, damit die
 * oeffentlichen ADS-B-Feeds ohne CORS-Probleme erreichbar sind.
 */
const { app, BrowserWindow, ipcMain, globalShortcut, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const CONFIG = require('./config');
const { fetchFlightState } = require('./flight-source');

const DEFAULT_BOUNDS = { width: 520, height: 720 };
const MIN_SIZE = { width: 320, height: 260 };

let mainWindow = null;
let refreshTimer = null;
let lastResult = null;
let inFlightRequest = null;

function statePath() {
  return path.join(app.getPath('userData'), 'widget-state.json');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveState(patch) {
  const next = Object.assign(loadState(), patch);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('Konnte Widget-Status nicht speichern:', err.message);
  }
  return next;
}

function boundsAreVisible(bounds) {
  if (!bounds) return false;
  return screen.getAllDisplays().some((display) => {
    const a = display.workArea;
    return (
      bounds.x < a.x + a.width &&
      bounds.x + bounds.width > a.x &&
      bounds.y < a.y + a.height &&
      bounds.y + bounds.height > a.y
    );
  });
}

function createWindow() {
  const state = loadState();
  const saved = state.bounds;
  const useSaved = boundsAreVisible(saved);

  mainWindow = new BrowserWindow({
    width: useSaved ? saved.width : DEFAULT_BOUNDS.width,
    height: useSaved ? saved.height : DEFAULT_BOUNDS.height,
    x: useSaved ? saved.x : undefined,
    y: useSaved ? saved.y : undefined,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    alwaysOnTop: state.alwaysOnTop !== false,
    skipTaskbar: false,
    title: CONFIG.flightIata + ' ' + CONFIG.origin.iata + '-' + CONFIG.destination.iata,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setAlwaysOnTop(state.alwaysOnTop !== false, 'floating');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    saveState({ bounds: mainWindow.getBounds() });
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Externe Links (z. B. Kartenlizenz) im Systembrowser oeffnen
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* --- Datenabruf ------------------------------------------------------ */

async function refreshFlight(reason) {
  if (inFlightRequest) return inFlightRequest;
  inFlightRequest = (async () => {
    const result = await fetchFlightState();
    result.reason = reason || 'timer';
    result.nextRefreshAt = Date.now() + CONFIG.refreshIntervalMs;
    lastResult = result;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('flight:update', result);
    }
    return result;
  })();
  try {
    return await inFlightRequest;
  } finally {
    inFlightRequest = null;
  }
}

function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshFlight('start');
  refreshTimer = setInterval(() => refreshFlight('timer'), CONFIG.refreshIntervalMs);
}

/* --- IPC ------------------------------------------------------------- */

ipcMain.handle('flight:refresh', (_evt, reason) => refreshFlight(reason || 'manuell'));
ipcMain.handle('flight:last', () => lastResult);
ipcMain.handle('app:config', () => CONFIG);
ipcMain.handle('app:settings', () => {
  const state = loadState();
  return { theme: state.theme || 'ecam', alwaysOnTop: state.alwaysOnTop !== false, opacity: state.opacity || 1 };
});
ipcMain.handle('app:save-settings', (_evt, patch) => saveState(patch || {}));

ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:close', () => app.quit());
ipcMain.on('window:toggle-always-on-top', (evt) => {
  if (!mainWindow) return;
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next, 'floating');
  saveState({ alwaysOnTop: next });
  evt.reply('window:always-on-top-changed', next);
});
ipcMain.on('window:set-opacity', (_evt, value) => {
  if (!mainWindow) return;
  const clamped = Math.min(1, Math.max(0.25, Number(value) || 1));
  mainWindow.setOpacity(clamped);
  saveState({ opacity: clamped });
});
ipcMain.on('window:set-size', (_evt, size) => {
  if (!mainWindow || !size) return;
  mainWindow.setSize(
    Math.max(MIN_SIZE.width, Math.round(size.width)),
    Math.max(MIN_SIZE.height, Math.round(size.height)),
    true
  );
});

/* --- App-Lifecycle --------------------------------------------------- */

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    startRefreshLoop();

    // Widget ein-/ausblenden ohne es zu beenden
    globalShortcut.register('CommandOrControl+Shift+E', () => {
      if (!mainWindow) return createWindow();
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (refreshTimer) clearInterval(refreshTimer);
  });
}
