const { app, BrowserWindow, Menu, ipcMain, dialog, net, shell: electronShell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('@lydell/node-pty');

const isWin = process.platform === 'win32';
const storePath = () => path.join(app.getPath('userData'), 'younesh.json');
const buffersPath = () => path.join(app.getPath('userData'), 'buffers.json');
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

  win.on('focus', () => win.flashFrame(false));
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

// Variables qu'une session Claude Code pose pour ses propres commandes. Si Younesh a été lancé depuis Claude,
// les terminaux en héritent et le Claude qu'on y lance se croit « enfant » : il n'enregistre plus la
// conversation (plus de reprise) et peut couper les couleurs. Les réglages de l'utilisateur (CLAUDE_CODE_GIT_BASH_PATH…) restent.
const CLAUDE_MARKERS = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_BRIDGE_SESSION_ID'];

function cleanEnv(parent) {
  const env = { ...parent };
  const fromClaude = 'CLAUDECODE' in env || 'CLAUDE_CODE_CHILD_SESSION' in env;
  for (const k of CLAUDE_MARKERS) delete env[k];
  // Posées par l'outil de commandes de Claude, pas par l'utilisateur : un vrai terminal a des couleurs.
  if (fromClaude) {
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
  }
  return env;
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

// Branche git lue directement dans .git/HEAD : pas de processus git lancé.
function gitBranch(dir) {
  for (let d = dir, i = 0; d && i < 40; i++) {
    const dotGit = path.join(d, '.git');
    try {
      let gitDir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!m) return null;
        gitDir = path.resolve(d, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
      return ref ? ref[1] : head.slice(0, 7);
    } catch {}
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

ipcMain.handle('store:load', () => loadStore());
// Contenu des terminaux, gardé à part pour ne pas alourdir le fichier de réglages.
ipcMain.handle('buffers:load', () => {
  try {
    return JSON.parse(fs.readFileSync(buffersPath(), 'utf8'));
  } catch {
    return {};
  }
});
ipcMain.on('buffers:save', (e, data) => {
  try {
    fs.writeFileSync(buffersPath(), JSON.stringify(data));
  } catch {}
  e.returnValue = true;
});
ipcMain.handle('git:branches', (_e, dirs) => Object.fromEntries(dirs.map((d) => [d, gitBranch(d)])));
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
    env: { ...cleanEnv(process.env), TERM_PROGRAM: 'Younesh', COLORTERM: 'truecolor' },
    useConpty: isWin ? true : undefined,
  });
  ptys.set(id, term);
  term.onData((data) => !e.sender.isDestroyed() && e.sender.send('pty:data', id, data));
  // Seule la fin du processus actuel compte : un redémarrage remplace l'ancien sans le signaler.
  term.onExit(({ exitCode }) => {
    if (ptys.get(id) !== term) return;
    ptys.delete(id);
    if (!e.sender.isDestroyed()) e.sender.send('pty:exit', id, exitCode);
  });
  return { pid: term.pid, cwd: dir };
});
// Sandboxes déjà créées avec sbx. « sbx ls --json » renvoie une liste ; les anciennes versions l'emballent dans { sandboxes }.
ipcMain.handle('sbx:list', () => new Promise((resolve) => {
  execFile('sbx', ['ls', '--json'], { windowsHide: true, timeout: 30000, env: cleanEnv(process.env) }, (err, stdout, stderr) => {
    if (err) return resolve({ error: err.code === 'ENOENT' ? 'sbx est introuvable sur ce PC (ou Younesh a été ouvert avant son installation).' : (stderr || err.message).trim() });
    try {
      const data = JSON.parse(stdout);
      const text = (v) => (typeof v === 'string' ? v : '');
      const sandboxes = (Array.isArray(data) ? data : data.sandboxes || []).filter((x) => x && x.name).map((x) => ({
        name: x.name,
        status: text(x.status),
        agent: text(x.agent),
        workspace: text((x.workspaces || [])[0] || x.workspace).replace(/:ro$/, ''),
      }));
      resolve({ sandboxes });
    } catch {
      resolve({ error: 'Réponse de « sbx ls » illisible.' });
    }
  });
}));

// Mises à jour depuis les versions GitHub. La version installée avec Younesh-Setup télécharge la nouvelle
// en arrière-plan et l'installe à la fermeture. La portable et celle installée par le .msi (souvent par la DSI)
// ne peuvent pas relancer cet installateur : on signale juste la sortie.
let updater;
function nsisUpdater() {
  if (!updater) {
    updater = require('electron-updater').autoUpdater;
    updater.on('update-downloaded', ({ version }) => win && !win.isDestroyed() && win.webContents.send('update:ready', version));
    updater.on('error', () => {});
  }
  return updater;
}

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

ipcMain.handle('update:check', async () => {
  if (!isWin || !app.isPackaged) return null;
  // Seul l'installateur .exe laisse son désinstalleur à côté de Younesh.exe.
  const fromSetup = !process.env.PORTABLE_EXECUTABLE_DIR && fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall Younesh.exe'));
  if (fromSetup) {
    nsisUpdater().checkForUpdates().catch(() => {});
    return null;
  }
  try {
    const res = await net.fetch('https://api.github.com/repos/jonasmelheb/younesh/releases/latest');
    const tag = String((await res.json()).tag_name || '').replace(/^v/, '');
    return tag && newer(tag, app.getVersion()) ? tag : null;
  } catch {
    return null;
  }
});
ipcMain.on('update:install', () => nsisUpdater().quitAndInstall(true, true));
ipcMain.handle('file:openJson', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  return res.canceled ? null : fs.readFileSync(res.filePaths[0], 'utf8');
});
ipcMain.handle('file:saveJson', async (_e, name, text) => {
  const res = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!res.canceled) fs.writeFileSync(res.filePath, text);
  return !res.canceled;
});
// Couleurs de la fenêtre selon le thème, et effet Mica (Windows 11) ou vibrance (macOS).
ipcMain.on('win:chrome', (_e, { bg, fg, material }) => {
  if (!win) return;
  win.setBackgroundColor(material ? '#00000000' : bg);
  if (isWin) {
    win.setTitleBarOverlay?.({ color: bg, symbolColor: fg });
    win.setBackgroundMaterial?.(material ? 'mica' : 'none');
  } else if (process.platform === 'darwin') {
    win.setVibrancy(material ? 'sidebar' : null);
  }
});
ipcMain.on('win:flash', () => win && !win.isFocused() && win.flashFrame(true));
ipcMain.on('win:focus', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
ipcMain.on('pty:write', (_e, id, data) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  try { ptys.get(id)?.resize(cols, rows); } catch {}
});
ipcMain.on('pty:kill', (_e, id) => ptys.get(id)?.kill());

// Pas de menu par défaut : ses raccourcis (Ctrl+W, Ctrl+R…) voleraient les touches du terminal.
// Nécessaire pour que les notifications Windows portent le nom de l'app.
if (isWin) app.setAppUserModelId('com.jonasmelheb.younesh');

app.whenReady().then(() => {
  Menu.setApplicationMenu(isWin ? null : Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
  createWindow();
});
app.on('window-all-closed', () => {
  for (const term of ptys.values()) term.kill();
  app.quit();
});
