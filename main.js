'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');
const zlib  = require('zlib');

// ── Settings (plain JSON, no extra dependency) ────────────────────────────────
const DEFAULT_SETTINGS = { openaiKey: '', anthropicKey: '', port: 3000 };

function settingsPath() {
  return path.join(app.getPath('userData'), 'vikta-settings.json');
}
function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (_) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}
function persistSettings(data) {
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// ── Programmatic tray icon (16×16 white square, template image) ──────────────
function buildTrayIcon() {
  const W = 16, H = 16;

  // CRC-32 table (IEEE 802.3 polynomial)
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[n] = c;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = tbl[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    return Buffer.concat([u32(data.length), t, data, u32(crc32(Buffer.concat([t, data])))]);
  }

  // Raw rows: filter byte (0) + W*3 bytes RGB per row — all white
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3, 0xff);
    row[0] = 0x00; // filter: None
    rows.push(row);
  }

  const sig      = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const ihdrData = Buffer.concat([u32(W), u32(H), Buffer.from([8, 2, 0, 0, 0])]); // 8-bit RGB
  const idatData = zlib.deflateSync(Buffer.concat(rows));
  const png      = Buffer.concat([sig, chunk('IHDR', ihdrData), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))]);

  const img = nativeImage.createFromBuffer(png);
  img.setTemplateImage(true); // macOS: adapts to light/dark menu bar
  return img;
}

// ── Express server lifecycle ──────────────────────────────────────────────────
let expressApp  = null;   // Express app (required once, reused)
let httpServer  = null;   // raw http.Server
let running     = false;
let activePort  = 3000;

function ensureExpress(settings) {
  if (!expressApp) {
    process.env.OPENAI_API_KEY    = settings.openaiKey    || '';
    process.env.ANTHROPIC_API_KEY = settings.anthropicKey || '';
    expressApp = require('./server').app;
  }
}

function startServer(settings) {
  return new Promise((resolve, reject) => {
    ensureExpress(settings);
    // Keys are read per-request inside callAI() — update env is enough
    process.env.OPENAI_API_KEY    = settings.openaiKey    || '';
    process.env.ANTHROPIC_API_KEY = settings.anthropicKey || '';
    activePort = Number(settings.port) || 3000;

    httpServer = http.createServer(expressApp);
    httpServer.on('error', (err) => {
      running = false;
      reject(err);
    });
    httpServer.listen(activePort, '127.0.0.1', () => {
      running = true;
      resolve(activePort);
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!httpServer) { resolve(); return; }
    httpServer.close(() => {
      httpServer = null;
      running = false;
      resolve();
    });
    if (httpServer.closeAllConnections) httpServer.closeAllConnections();
  });
}

// ── Status broadcast to settings window ──────────────────────────────────────
let settingsWin = null;

function broadcast(payload) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('status-change', payload);
  }
}

// ── Tray ─────────────────────────────────────────────────────────────────────
let tray = null;

function rebuildTray() {
  const menu = Menu.buildFromTemplate([
    { label: 'Proxy VIKTA', enabled: false },
    { label: running ? `● localhost:${activePort}` : '○ Arrêté', enabled: false },
    { type: 'separator' },
    {
      label: running ? 'Arrêter' : 'Démarrer',
      click: async () => {
        if (running) {
          await stopServer();
          broadcast({ running: false, port: activePort });
        } else {
          try {
            const port = await startServer(loadSettings());
            broadcast({ running: true, port });
          } catch (e) {
            broadcast({ running: false, port: activePort, error: e.message });
          }
        }
        rebuildTray();
      },
    },
    { label: 'Paramètres…', click: openSettings },
    { type: 'separator' },
    { label: 'Quitter', click: () => stopServer().then(() => app.quit()) },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(running ? `Proxy VIKTA — localhost:${activePort}` : 'Proxy VIKTA — arrêté');
}

// ── Settings window ───────────────────────────────────────────────────────────
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }

  settingsWin = new BrowserWindow({
    width: 480, height: 500,
    resizable: false, minimizable: true, maximizable: false,
    show: false,
    title: 'Proxy VIKTA — Paramètres',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    broadcast({ running, port: activePort });
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  tray = new Tray(buildTrayIcon());
  rebuildTray();

  const settings = loadSettings();
  if (settings.openaiKey || settings.anthropicKey) {
    try {
      await startServer(settings);
    } catch (e) {
      // Port conflict or other error — let user fix in settings
    }
    rebuildTray();
  }
  openSettings(); // toujours ouvrir la fenêtre au démarrage
});

app.on('window-all-closed', () => { /* stay in tray */ });
app.on('before-quit', () => { if (running) stopServer(); });

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => loadSettings());

ipcMain.handle('save-settings', async (_, data) => {
  const prev = loadSettings();
  persistSettings(data);

  process.env.OPENAI_API_KEY    = data.openaiKey    || '';
  process.env.ANTHROPIC_API_KEY = data.anthropicKey || '';

  const portChanged = Number(data.port) !== Number(prev.port);

  if (running && portChanged) {
    await stopServer();
    try {
      const port = await startServer(data);
      rebuildTray();
      return { ok: true, running: true, port };
    } catch (e) {
      rebuildTray();
      return { ok: false, running: false, error: e.message };
    }
  }

  rebuildTray();
  return { ok: true, running, port: Number(data.port) || 3000 };
});

ipcMain.handle('toggle-server', async () => {
  if (running) {
    await stopServer();
    rebuildTray();
    return { running: false, port: activePort };
  } else {
    try {
      const port = await startServer(loadSettings());
      rebuildTray();
      return { running: true, port };
    } catch (e) {
      rebuildTray();
      return { running: false, port: activePort, error: e.message };
    }
  }
});
