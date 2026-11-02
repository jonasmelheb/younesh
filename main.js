const { app, BrowserWindow, Menu, ipcMain, dialog, shell: electronShell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('@lydell/node-pty');

const isWin = process.platform === 'win32';
const storePath = () => path.join(app.getPath('userData'), 'younesh.json');
const ptys = new Map();
let win;

function createWindow() {
  const bounds = loadStore().window || {};
  win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#0e0f13',
    title: 'Younesh',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: isWin ? { color: '#0e0f13', symbolColor: '#c9ccd6', height: 38 } : undefined,
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (bounds.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Les liens cliqués dans le terminal s'ouvrent dans le navigateur.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) electronShell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', () => {
    const store = loadStore();
    store.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    saveStore(store);
  });
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(data) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

function detectShells() {
  const shells = [];
  const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  if (isWin) {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pwsh = [path.join(pf, 'PowerShell', '7', 'pwsh.exe'), path.join(pf, 'PowerShell', '7-preview', 'pwsh.exe')].find(exists);
    if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell 7', path: pwsh, args: ['-NoLogo'], family: 'powershell' });
    shells.push({ id: 'powershell', name: 'Windows PowerShell', path: path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'], family: 'powershell' });
    shells.push({ id: 'cmd', name: 'Invite de commandes', path: path.join(sys, 'System32', 'cmd.exe'), args: [], family: 'cmd' });
    const gitBash = [path.join(pf, 'Git', 'bin', 'bash.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')].find(exists);
    if (gitBash) shells.push({ id: 'gitbash', name: 'Git Bash', path: gitBash, args: ['--login', '-i'], family: 'posix' });
    const wsl = path.join(sys, 'System32', 'wsl.exe');
    if (exists(wsl)) shells.push({ id: 'wsl', name: 'WSL', path: wsl, args: [], family: 'posix' });
  } else {
    const seen = new Set();
    for (const p of [process.env.SHELL, '/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish']) {
      if (p && !seen.has(p) && exists(p)) {
        seen.add(p);
        shells.push({ id: path.basename(p), name: path.basename(p), path: p, args: ['-l'], family: 'posix' });
      }
    }
  }
  return shells;
}

ipcMain.handle('store:load', () => loadStore());
ipcMain.handle('store:save', (_e, data) => {
  const store = loadStore();
  saveStore({ ...data, window: store.window });
});
ipcMain.handle('shells:list', () => detectShells());
ipcMain.handle('app:info', () => ({ platform: process.platform, home: os.homedir(), version: app.getVersion() }));
ipcMain.handle('dialog:folder', async (_e, defaultPath) => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('pty:spawn', (e, { id, shellPath, args, cwd, cols, rows }) => {
  ptys.get(id)?.kill();
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const term = pty.spawn(shellPath, args || [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: dir,
    env: { ...process.env, TERM_PROGRAM: 'Younesh', COLORTERM: 'truecolor' },
    useConpty: isWin ? true : undefined,
  });
  ptys.set(id, term);
  term.onData((data) => !e.sender.isDestroyed() && e.sender.send('pty:data', id, data));
  term.onExit(({ exitCode }) => {
    if (ptys.get(id) === term) ptys.delete(id);
    if (!e.sender.isDestroyed()) e.sender.send('pty:exit', id, exitCode);
  });
  return { pid: term.pid, cwd: dir };
});
ipcMain.on('pty:write', (_e, id, data) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  try { ptys.get(id)?.resize(cols, rows); } catch {}
});
ipcMain.on('pty:kill', (_e, id) => {
  ptys.get(id)?.kill();
  ptys.delete(id);
});

// Pas de menu par défaut : ses raccourcis (Ctrl+W, Ctrl+R…) voleraient les touches du terminal.
app.whenReady().then(() => {
  Menu.setApplicationMenu(isWin ? null : Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
  createWindow();
});
app.on('window-all-closed', () => {
  for (const term of ptys.values()) term.kill();
  app.quit();
});
