const { app, BrowserWindow, Menu, ipcMain, dialog, net, shell: electronShell } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
    icon: path.join(__dirname, 'build', isWin ? 'icon.ico' : 'icon.png'),
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
  // La portable tourne depuis un dossier temporaire effacé à la fermeture : sans ça, une épingle viserait ce dossier.
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (isWin && portable) {
    win.setAppDetails({
      appId: 'com.jonasmelheb.younesh',
      appIconPath: portable,
      relaunchCommand: `"${portable}"`,
      relaunchDisplayName: 'Younesh',
    });
  }
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

// Environnement relu dans le registre avant chaque terminal, comme Windows Terminal pour chaque onglet :
// un programme installé après l'ouverture de Younesh (claude, sbx…) est trouvé, et Younesh ouvert par
// l'installateur .msi, qui lui passe l'environnement du service Windows Installer, retrouve le PATH de l'utilisateur.
// PowerShell plutôt que reg.exe : il rend les accents des chemins sans dépendre de la page de code de la console.
const ENV_SCRIPT = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$keys = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU:\\Volatile Environment', 'HKCU:\\Environment'
$out = for ($i = 0; $i -lt 3; $i++) {
  $key = Get-Item -LiteralPath $keys[$i] -ErrorAction SilentlyContinue
  if ($key) { foreach ($n in $key.GetValueNames()) { [pscustomobject]@{ s = $i; n = $n; v = [string]$key.GetValue($n, '', 'DoNotExpandEnvironmentNames') } } }
}
ConvertTo-Json -Compress -InputObject @($out)`;
let envCache;

function registryEnv() {
  if (!isWin) return Promise.resolve([]);
  if (envCache && Date.now() - envCache.at < 10000) return envCache.promise;
  const promise = new Promise((resolve) => {
    const encoded = Buffer.from(ENV_SCRIPT, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      try {
        resolve(err ? [] : JSON.parse(stdout.replace(/^\uFEFF/, '')));
      } catch {
        resolve([]);
      }
    });
  });
  envCache = { at: Date.now(), promise };
  return promise;
}

// Même ordre que Windows : système, session, puis utilisateur ; le Path de l'utilisateur s'ajoute à celui du système.
// Les noms de variables ne tiennent pas compte de la casse sous Windows.
async function freshEnv() {
  const env = { ...process.env };
  const keyOf = (name) => Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  const set = (name, value) => {
    const k = keyOf(name);
    if (k) delete env[k];
    env[name] = value;
  };
  const expand = (v) => v.replace(/%([^%]+)%/g, (m, n) => (keyOf(n) ? env[keyOf(n)] : m));
  let systemPath = '';
  for (const { s, n, v } of await registryEnv()) {
    if (n.toLowerCase() !== 'path') set(n, expand(v));
    else if (s === 0) set('Path', (systemPath = expand(v)));
    else if (s === 2) set('Path', [systemPath, expand(v)].filter(Boolean).join(';'));
  }
  return cleanEnv(env);
}

// Chemin complet d'un programme d'après le Path donné : sous Windows, node-pty le chercherait sinon
// dans le PATH de Younesh, peut-être ancien.
function which(env, name) {
  if (!isWin) return name;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  for (const dir of (env[key] || '').split(';')) {
    const file = path.join(dir.trim().replace(/"/g, ''), name + '.exe');
    if (dir.trim() && fs.existsSync(file)) return file;
  }
  return name;
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

ipcMain.handle('dialog:file', async (_e, defaultPath) => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'showHiddenFiles'], defaultPath });
  return res.canceled ? null : res.filePaths[0];
});

// program : un programme lancé sans shell (ssh), cherché dans le Path relu.
// Dossier courant d'un terminal, lu sur son processus (Mac et Linux ; Windows passe par l'invite du shell).
ipcMain.handle('pty:cwd', (_e, id) => new Promise((resolve) => {
  const term = ptys.get(id);
  if (!term || isWin) return resolve(null);
  if (process.platform !== 'darwin') return fs.readlink(`/proc/${term.pid}/cwd`, (err, dir) => resolve(err ? null : dir));
  execFile('lsof', ['-a', '-p', String(term.pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }, (_err, out) => resolve(/^n(.+)$/m.exec(out || '')?.[1] || null));
}));

ipcMain.handle('pty:spawn', async (e, { id, shellPath, program, args, cwd, cols, rows, env: extraEnv }) => {
  const env = await freshEnv();
  ptys.get(id)?.kill();
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const term = pty.spawn(program ? which(env, program) : shellPath, args || [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: dir,
    env: { ...env, ...extraEnv, TERM_PROGRAM: 'Younesh', COLORTERM: 'truecolor' },
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
ipcMain.handle('sbx:list', async () => {
  const env = await freshEnv();
  return new Promise((resolve) => execFile('sbx', ['ls', '--json'], { windowsHide: true, timeout: 30000, env }, (err, stdout, stderr) => {
    if (err) return resolve({ error: err.code === 'ENOENT' ? 'sbx est introuvable sur ce PC.' : (stderr || err.message).trim() });
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
  }));
});

// Tunnels SSH : un « ssh -N » par tunnel, dans un pseudo-terminal caché pour qu'il puisse demander un mot de passe
// ou faire confirmer un nouveau serveur. La fenêtre affiche ces questions et renvoie la réponse.
const tunnels = new Map();
ipcMain.handle('tunnel:start', async (e, id, args) => {
  const env = await freshEnv();
  tunnels.get(id)?.kill();
  let term;
  try {
    term = pty.spawn(which(env, 'ssh'), args, { name: 'xterm-256color', cols: 200, rows: 24, cwd: os.homedir(), env, useConpty: isWin ? true : undefined });
  } catch (err) {
    return { error: err.message };
  }
  tunnels.set(id, term);
  term.onData((data) => !e.sender.isDestroyed() && e.sender.send('tunnel:data', id, data));
  term.onExit(({ exitCode }) => {
    if (tunnels.get(id) !== term) return;
    tunnels.delete(id);
    if (!e.sender.isDestroyed()) e.sender.send('tunnel:exit', id, exitCode);
  });
  return {};
});
ipcMain.on('tunnel:write', (_e, id, data) => tunnels.get(id)?.write(data));
ipcMain.on('tunnel:stop', (_e, id) => {
  const term = tunnels.get(id);
  tunnels.delete(id);
  term?.kill();
});
ipcMain.handle('ssh:config', () => {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return '';
  }
});

// Mises à jour depuis les versions GitHub. La version installée avec Younesh-Setup télécharge la nouvelle
// en arrière-plan et l'installe à la fermeture. La portable fait de même en remplaçant son propre .exe,
// et signale juste la sortie si elle n'y arrive pas. Celle du .msi (souvent installée par la DSI) la signale aussi.
let updater;
function nsisUpdater() {
  if (!updater) {
    updater = require('electron-updater').autoUpdater;
    updater.on('update-downloaded', ({ version }) => win && !win.isDestroyed() && win.webContents.send('update:ready', version));
    updater.on('error', () => {});
  }
  return updater;
}

// Le nouvel .exe est posé à côté de l'ancien, après contrôle de l'empreinte publiée par GitHub.
let portableUpdate = null;
async function downloadPortable(release, tag) {
  const asset = (release.assets || []).find((a) => a.name === `Younesh-Portable-${tag}.exe`);
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest || '')?.[1];
  if (!sha256) return false;
  try {
    const res = await net.fetch(asset.browser_download_url);
    if (!res.ok) return false;
    const data = Buffer.from(await res.arrayBuffer());
    if (crypto.createHash('sha256').update(data).digest('hex') !== sha256) return false;
    const target = process.env.PORTABLE_EXECUTABLE_FILE;
    const file = `${target}.download`;
    fs.writeFileSync(file, data);
    portableUpdate = { file, target, version: tag };
    return true;
  } catch {
    return false;
  }
}

// Le .exe est verrouillé tant que Younesh tourne : un petit script attend sa fermeture pour le remplacer.
function applyPortableUpdate(relaunch) {
  const { file, target } = portableUpdate;
  portableUpdate = null;
  const quote = (p) => `"${p.replace(/%/g, '%%')}"`;
  const script = path.join(os.tmpdir(), `younesh-update-${process.pid}.cmd`);
  fs.writeFileSync(script, [
    '@echo off',
    'chcp 65001 >nul',
    'set /a tries=0',
    ':retry',
    `move /y ${quote(file)} ${quote(target)} >nul 2>&1 && goto done`,
    'set /a tries+=1',
    'if %tries% geq 60 goto end',
    'ping -n 2 127.0.0.1 >nul',
    'goto retry',
    ':done',
    ...(relaunch ? [`start "" ${quote(target)}`] : []),
    ':end',
    '(goto) 2>nul & del "%~f0"',
  ].join('\r\n'));
  spawn('cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return null;
  // Seul l'installateur .exe laisse son désinstalleur à côté de Younesh.exe. Sur Mac, Younesh signale la nouvelle version.
  const fromSetup = isWin && !process.env.PORTABLE_EXECUTABLE_DIR && fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall Younesh.exe'));
  if (fromSetup) {
    nsisUpdater().checkForUpdates().catch(() => {});
    return null;
  }
  try {
    const res = await net.fetch('https://api.github.com/repos/jonasmelheb/younesh/releases/latest');
    const release = await res.json();
    const tag = String(release.tag_name || '').replace(/^v/, '');
    if (!tag || !newer(tag, app.getVersion())) return null;
    if (!process.env.PORTABLE_EXECUTABLE_FILE) return tag;
    if (portableUpdate?.version === tag) return null;
    if (!(await downloadPortable(release, tag))) return tag;
    if (win && !win.isDestroyed()) win.webContents.send('update:ready', tag);
    return null;
  } catch {
    return null;
  }
});
ipcMain.on('update:install', () => {
  if (!portableUpdate) return nsisUpdater().quitAndInstall(true, true);
  applyPortableUpdate(true);
  app.quit();
});
app.on('will-quit', () => portableUpdate && applyPortableUpdate(false));
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

// ---------- sbx et git ----------

ipcMain.handle('fs:hasGit', (_e, dir) => !!dir && fs.existsSync(path.join(dir, '.git')));

// sbx garde la description de chaque sandbox dans …\DockerSandboxes\sandboxes\state\sandboxd\runtimes\<nom>.json :
// « Spec.Template » est l'image. Seul ce champ est lu. null si le fichier est absent ou illisible.
ipcMain.handle('sbx:image', (_e, projet) => {
  if (!isWin || !/^[\w.-]+$/.test(projet || '')) return null;
  const file = path.join(process.env.LOCALAPPDATA || '', 'DockerSandboxes', 'sandboxes', 'state', 'sandboxd', 'runtimes', `${projet}.json`);
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'))?.Spec?.Template;
    return typeof t === 'string' ? t : '';
  } catch {
    return null;
  }
});

// Sur certains PC Windows, des git restent suspendus dès leur lancement quand leur parent disparaît.
// Celui de sbx garde alors .git\config.lock : le remote de la sandbox n'est pas posé et sbx attend, écran noir.
// Un git orphelin qui n'a jamais tourné (moins de 20 ms de processeur) depuis 30 s est arrêté.
const KILL_STUCK_GIT = `
$all = Get-CimInstance Win32_Process
$ids = @{}; foreach ($p in $all) { $ids[[int]$p.ProcessId] = $true }
$old = (Get-Date).AddSeconds(-30)
foreach ($p in $all) {
  if ($p.Name -ne 'git.exe' -or $ids.ContainsKey([int]$p.ParentProcessId)) { continue }
  if ($p.CreationDate -gt $old -or ($p.KernelModeTime + $p.UserModeTime) -ge 200000) { continue }
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}`;

function killStuckGit() {
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', KILL_STUCK_GIT], { windowsHide: true, timeout: 30000 }, () => resolve()));
}

if (isWin) setInterval(killStuckGit, 15000);

// « Git remote sandbox-NOM is not ready » : le remote est reposé ici, une fois le verrou parti.
// La commande affichée par sbx n'est jamais exécutée : seuls le nom et le port, vérifiés, sont repris.
ipcMain.handle('git:repairRemote', async (_e, dir, remote, port, repo) => {
  if (!isWin || !/^sandbox-[\w.-]+$/.test(remote) || !/^\d{2,5}$/.test(port) || !/^[\w.-]+$/.test(repo) || !fs.existsSync(path.join(dir, '.git'))) return false;
  const lock = path.join(dir, '.git', 'config.lock');
  for (let i = 0; i < 24 && fs.existsSync(lock); i++) {
    await killStuckGit();
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (fs.existsSync(lock)) return false;
  const env = await freshEnv();
  const git = (...args) => new Promise((resolve) => execFile('git', ['-C', dir, ...args], { windowsHide: true, timeout: 30000, env }, (err) => resolve(!err)));
  return await git('config', '--replace-all', `remote.${remote}.url`, `git://127.0.0.1:${port}/${repo}`)
    && await git('config', '--replace-all', `remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`)
    && await git('config', '--add', `remote.${remote}.fetch`, `+refs/heads/*:refs/sandboxes/${remote.slice('sandbox-'.length)}/*`);
});

// Pas de menu par défaut : ses raccourcis (Ctrl+W, Ctrl+R…) voleraient les touches du terminal.
// Nécessaire pour que les notifications Windows portent le nom de l'app.
if (isWin) app.setAppUserModelId('com.jonasmelheb.younesh');

app.whenReady().then(() => {
  Menu.setApplicationMenu(isWin ? null : Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
  createWindow();
});
app.on('window-all-closed', () => {
  for (const term of [...ptys.values(), ...tunnels.values()]) term.kill();
  app.quit();
});
