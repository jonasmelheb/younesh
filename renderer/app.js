'use strict';

const api = window.younesh;
const $ = (sel) => document.querySelector(sel);

const COLORS = ['#ff6b6b', '#ff9f43', '#feca57', '#4ade80', '#2dd4bf', '#38bdf8', '#7c9cff', '#a78bfa', '#f472b6', '#e8a87c', '#94a3b8'];
let info = { platform: 'win32', home: '' };
let shells = [];
let state = { folders: [], sessions: [], activeId: null, settings: {} };
const runtime = new Map(); // id -> { term, fit, el, running, unread, exited, busy, attention }
// Claude anime son indicateur tant qu'il travaille : un silence de cette durée veut dire qu'il attend.
const CLAUDE_QUIET_MS = 3000;
let saveTimer = null;
let branches = {}; // dossier -> branche git
let savedBuffers = {}; // id -> contenu du terminal à la fermeture précédente
let split = null; // { left, right } quand deux discussions sont côte à côte
const RESTORE_LINES = 1000;
let search = '';

const isMac = () => info.platform === 'darwin';
const uid = () => crypto.randomUUID();
const sessionById = (id) => state.sessions.find((s) => s.id === id);
const folderById = (id) => state.folders.find((f) => f.id === id);
const basename = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
const shortPath = (p) => (p && info.home && p.startsWith(info.home) ? '~' + p.slice(info.home.length) : p || '~');
const colorOf = (s) => s.color || folderById(s.folderId)?.color || null;
// Dossier courant : celui annoncé par le shell (OSC 7 ou 9;9) s'il le fait, sinon celui de départ.
const cwdOf = (s) => runtime.get(s.id)?.cwd || s.cwd;

function settings() {
  return {
    fontSize: 14,
    fontFamily: isMac() ? 'Menlo, monospace' : '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    defaultShell: shells[0]?.id,
    defaultCwd: info.home,
    sidebarWidth: 280,
    gpu: true,
    notify: true,
    restore: true,
    theme: 'sombre',
    cursorStyle: 'block',
    cursorBlink: true,
    material: false,
    scrollback: 10000,
    ...state.settings,
  };
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveStore(state), 250);
}

// ---------- Démarrage ----------

async function init() {
  [info, shells] = await Promise.all([api.info(), api.listShells()]);
  document.body.classList.toggle('mac', isMac());
  const stored = await api.loadStore();
  state = {
    folders: stored.folders || [],
    sessions: stored.sessions || [],
    activeId: stored.activeId || null,
    settings: stored.settings || {},
  };
  document.documentElement.style.setProperty('--sidebar-w', settings().sidebarWidth + 'px');
  applyAppearance();
  darkQuery.addEventListener('change', () => settings().theme === 'auto' && applyAppearance());
  if (settings().restore) savedBuffers = await api.loadBuffers();
  window.addEventListener('beforeunload', () => api.saveBuffers(collectBuffers()));
  setInterval(() => api.saveBuffers(collectBuffers()), 60000);

  api.onData((id, data) => {
    const rt = runtime.get(id);
    if (!rt) return;
    rt.term.write(data);
    const now = Date.now();
    rt.lastOutput = now;
    // L'écho des touches et le redessin après un redimensionnement ne comptent pas comme du travail.
    if (sessionById(id)?.kind === 'claude' && now - (rt.lastInput || 0) > 400 && now - (rt.lastResize || 0) > 800) rt.busy = true;
    if (id !== state.activeId && !rt.unread) {
      rt.unread = true;
      updateDot(id);
    }
  });
  api.onExit((id, code) => {
    const rt = runtime.get(id);
    if (!rt) return;
    rt.running = false;
    rt.exited = true;
    showExitBar(id, code);
    updateDot(id);
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, rt] of runtime) {
      if (rt.busy && now - rt.lastOutput > CLAUDE_QUIET_MS) {
        rt.busy = false;
        attention(id, 'Claude attend ta réponse');
      }
    }
  }, 1000);
  setInterval(refreshBranches, 4000);
  window.addEventListener('focus', () => clearAttention(state.activeId));

  bindUI();
  render();
  refreshBranches();
  if (state.activeId && sessionById(state.activeId)) activate(state.activeId);
  else if (state.sessions[0]) activate(state.sessions[0].id);
  else showEmpty();
}

// ---------- Terminaux ----------

function ensureTerminal(s) {
  let rt = runtime.get(s.id);
  if (rt) return rt;
  const st = settings();
  const term = new Terminal({
    fontFamily: st.fontFamily,
    fontSize: st.fontSize,
    lineHeight: 1.15,
    cursorBlink: st.cursorBlink,
    cursorStyle: st.cursorStyle,
    allowProposedApi: true,
    scrollback: st.scrollback,
    theme: themeOf(st.theme).term,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(search);
  const serialize = new SerializeAddon.SerializeAddon();
  term.loadAddon(serialize);
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (s.id === state.activeId) $('#find-count').textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : 'Aucun';
  });
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, url) => window.open(url)));
  const el = document.createElement('div');
  el.className = 'term';
  el.innerHTML = '<div class="pane-head"><span class="pane-name"></span><button class="pane-close" title="Fermer le panneau (Ctrl+Maj+E)">✕</button></div>';
  el.querySelector('.pane-close').addEventListener('click', (e) => {
    e.stopPropagation();
    const keep = split && (split.left === s.id ? split.right : split.left);
    split = null;
    if (keep) activate(keep);
  });
  el.addEventListener('mousedown', () => split && state.activeId !== s.id && activate(s.id));
  $('#terminals').appendChild(el);
  term.open(el);
  if (st.gpu) enableGpu(term);
  if (savedBuffers[s.id]) {
    term.write(savedBuffers[s.id]);
    term.write('\r\n\x1b[2m──── session précédente ────\x1b[0m\r\n');
    delete savedBuffers[s.id];
  }
  // Un fichier ou dossier glissé dans le terminal y colle son chemin.
  el.addEventListener('dragover', (e) => e.dataTransfer.types.includes('Files') && e.preventDefault());
  el.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const shell = shells.find((x) => x.id === s.shell) || shells[0];
    const quote = (p) => (!/[\s'"()&;$`]/.test(p) ? p : shell?.family === 'posix' ? quotePosix(p) : `"${p}"`);
    api.write(s.id, [...e.dataTransfer.files].map((f) => quote(api.pathForFile(f))).join(' ') + ' ');
    term.focus();
  });
  term.attachCustomKeyEventHandler((e) => terminalKey(e, s.id));
  term.onData((data) => {
    rt.lastInput = Date.now();
    clearAttention(s.id);
    api.write(s.id, data);
  });
  term.onResize(({ cols, rows }) => {
    rt.lastResize = Date.now();
    api.resize(s.id, cols, rows);
  });
  // Sonnerie et notifications envoyées par les programmes (OSC 9 iTerm2, OSC 777 Ghostty, OSC 99 kitty).
  term.onBell(() => attention(s.id, 'Le terminal te signale quelque chose'));
  term.parser.registerOscHandler(7, (uri) => {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(uri);
    if (m) setLiveCwd(s.id, decodeURIComponent(m[1]).replace(/^\/([A-Za-z]:)/, '$1'));
    return true;
  });
  term.parser.registerOscHandler(9, (text) => {
    if (text.startsWith('9;')) return setLiveCwd(s.id, text.slice(2).replace(/^"|"$/g, '')), true;
    if (/^\d+;/.test(text)) return false;
    attention(s.id, text);
    return true;
  });
  term.parser.registerOscHandler(777, (text) => {
    const [kind, title, body] = text.split(';');
    if (kind === 'notify') attention(s.id, body || title);
    return true;
  });
  term.parser.registerOscHandler(99, (text) => (attention(s.id, text.split(';').pop()), true));
  rt = { term, fit, search, serialize, el, running: false, unread: false, exited: false, busy: false, attention: false };
  runtime.set(s.id, rt);
  new ResizeObserver(() => el.classList.contains('visible') && safeFit(rt)).observe(el);
  return rt;
}

// Rendu par la carte graphique ; si le contexte WebGL est perdu, xterm repasse au rendu normal.
function enableGpu(term) {
  try {
    const gpu = new WebglAddon.WebglAddon();
    gpu.onContextLoss(() => gpu.dispose());
    term.loadAddon(gpu);
  } catch {}
}

function setLiveCwd(id, dir) {
  const rt = runtime.get(id);
  if (!rt || !dir || rt.cwd === dir) return;
  rt.cwd = dir;
  refreshBranches();
  if (id === state.activeId) updateTopbar();
}

async function refreshBranches() {
  const dirs = [...new Set(state.sessions.map(cwdOf).filter(Boolean))];
  if (!dirs.length) return;
  const next = await api.gitBranches(dirs);
  if (dirs.every((d) => next[d] === branches[d]) && Object.keys(next).length === Object.keys(branches).length) return;
  branches = next;
  render();
  updateTopbar();
}

function attention(id, message) {
  const rt = runtime.get(id);
  const s = sessionById(id);
  if (!rt || !s || (id === state.activeId && document.hasFocus())) return;
  rt.attentionAt = Date.now();
  if (rt.attention) return;
  rt.attention = true;
  updateDot(id);
  render();
  api.flash();
  if (settings().notify) {
    const n = new Notification(s.name, { body: message || 'Nouvelle activité' });
    n.onclick = () => {
      api.focusWindow();
      activate(id);
    };
  }
}

function clearAttention(id) {
  const rt = runtime.get(id);
  if (!rt?.attention) return;
  rt.attention = false;
  updateDot(id);
  render();
}

function jumpToAttention() {
  let best = null;
  for (const [id, rt] of runtime) if (rt.attention && (!best || rt.attentionAt > best.at)) best = { id, at: rt.attentionAt };
  if (best) activate(best.id);
}

// ---------- Sélecteur rapide ----------

const lastUsed = new Map(); // id -> date de dernière ouverture
let paletteItems = [];
let paletteIndex = 0;

function paletteActions() {
  return [
    { label: 'Nouvelle discussion', hint: 'Ctrl+Maj+T', run: () => openNewDialog() },
    { label: 'Nouvelle discussion Claude', hint: 'Ctrl+Maj+N', run: () => openNewDialog({ kind: 'claude' }) },
    { label: 'Nouvelle sandbox', run: () => openSbxNew() },
    { label: 'Préparer le poste pour sbx', run: openSbxSetup },
    { label: 'Configurer sbx', run: openSbxConfig },
    { label: 'Nouveau dossier', hint: 'Ctrl+Maj+D', run: () => createFolder() },
    { label: 'Chercher dans le terminal', hint: 'Ctrl+Maj+F', run: openFind },
    { label: 'Deux discussions côte à côte', hint: 'Ctrl+Maj+E', run: toggleSplit },
    { label: 'Discussion qui attend', hint: 'Ctrl+Maj+U', run: jumpToAttention },
    { label: 'Renommer la discussion', hint: 'F2', run: () => state.activeId && startRename('session', state.activeId) },
    { label: 'Fermer la discussion', hint: 'Ctrl+Maj+W', run: () => state.activeId && closeSession(state.activeId) },
    { label: 'Afficher ou masquer la barre latérale', hint: 'Ctrl+Maj+B', run: toggleSidebar },
    { label: 'Réglages', run: openSettings },
    { label: 'Exporter mes dossiers et réglages', run: exportBackup },
    { label: 'Importer une sauvegarde', run: importBackup },
  ];
}

// Score de correspondance floue : les lettres de la recherche dans l'ordre, bonus si consécutives ou en début de mot.
function fuzzy(query, text) {
  if (!query) return 1;
  const plain = (str) => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const q = plain(query);
  const t = plain(text);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return 0;
    score += 1 + (i === prev + 1 ? 3 : 0) + (i === 0 || /[\s·/\\_-]/.test(t[i - 1]) ? 2 : 0);
    prev = i;
    ti = i + 1;
  }
  return score;
}

function openPalette() {
  closeMenu();
  $('#palette').hidden = false;
  $('#palette-input').value = '';
  renderPalette();
  $('#palette-input').focus();
}

function closePalette(refocus = true) {
  $('#palette').hidden = true;
  if (refocus) runtime.get(state.activeId)?.term.focus();
}

function renderPalette() {
  const q = $('#palette-input').value.trim();
  const sessions = state.sessions.map((s) => {
    const folder = folderById(s.folderId)?.name;
    const branch = branches[cwdOf(s)];
    const text = [s.name, folder, branch, shortPath(cwdOf(s))].filter(Boolean).join(' · ');
    const rt = runtime.get(s.id);
    return { session: s, label: s.name, sub: [folder, branch && '⎇ ' + branch, shortPath(cwdOf(s))].filter(Boolean).join('  ·  '), score: fuzzy(q, text) + (rt?.attention ? 50 : 0), recent: lastUsed.get(s.id) || 0, run: () => activate(s.id) };
  });
  const actions = paletteActions().map((a) => ({ ...a, action: true, score: fuzzy(q, a.label) }));
  paletteItems = [
    ...sessions.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.recent - a.recent),
    ...actions.filter((x) => x.score > 0 && (q || x.label.startsWith('Nouvelle'))).sort((a, b) => b.score - a.score),
  ].slice(0, 30);
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  if (!q) paletteIndex = paletteItems[0]?.session?.id === state.activeId && paletteItems.length > 1 ? 1 : 0;
  const list = $('#palette-list');
  list.innerHTML = '';
  paletteItems.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'palette-item' + (i === paletteIndex ? ' selected' : '');
    const s = item.session;
    const rt = s && runtime.get(s.id);
    row.innerHTML = `<span class="kind">${s ? KIND_ICON[s.kind] || '›_' : '⌘'}</span><div class="info"><div class="name"></div>${item.sub ? '<div class="sub"></div>' : ''}</div>${item.hint ? `<kbd>${item.hint}</kbd>` : ''}${rt?.attention ? '<span class="dot attention"></span>' : ''}`;
    row.querySelector('.name').textContent = item.label;
    if (item.sub) row.querySelector('.sub').textContent = item.sub;
    if (s && colorOf(s)) row.querySelector('.kind').style.color = colorOf(s);
    row.addEventListener('mousemove', () => {
      if (paletteIndex === i) return;
      paletteIndex = i;
      list.querySelectorAll('.palette-item').forEach((r, j) => r.classList.toggle('selected', j === i));
    });
    row.addEventListener('click', () => runPalette(i));
    list.appendChild(row);
  });
  if (!paletteItems.length) list.innerHTML = '<div class="palette-empty">Aucun résultat</div>';
}

function runPalette(i) {
  const item = paletteItems[i];
  if (!item) return;
  closePalette(!item.action);
  item.run();
}

function movePalette(delta) {
  if (!paletteItems.length) return;
  paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length;
  const rows = $('#palette-list').querySelectorAll('.palette-item');
  rows.forEach((r, j) => r.classList.toggle('selected', j === paletteIndex));
  rows[paletteIndex]?.scrollIntoView({ block: 'nearest' });
}

// ---------- Recherche dans le terminal ----------

const FIND_DECORATIONS = { matchBackground: '#3a4a7a', activeMatchBackground: '#ff9f43', matchOverviewRuler: '#7c9cff', activeMatchColorOverviewRuler: '#ff9f43' };
let findCase = false;

function openFind() {
  const rt = runtime.get(state.activeId);
  if (!rt) return;
  $('#findbar').hidden = false;
  const selection = rt.term.getSelection();
  if (selection && !selection.includes('\n')) $('#find-input').value = selection;
  $('#find-input').focus();
  $('#find-input').select();
  find(1, true);
}

function closeFind() {
  $('#findbar').hidden = true;
  const rt = runtime.get(state.activeId);
  rt?.search.clearDecorations();
  rt?.term.focus();
}

function find(dir, incremental = false) {
  const rt = runtime.get(state.activeId);
  const q = $('#find-input').value;
  if (!rt) return;
  if (!q) {
    rt.search.clearDecorations();
    $('#find-count').textContent = '';
    return;
  }
  const opts = { caseSensitive: findCase, incremental, decorations: FIND_DECORATIONS };
  if (dir > 0) rt.search.findNext(q, opts);
  else rt.search.findPrevious(q, opts);
}

// Seuls les terminaux classiques sont gardés : Claude et la sandbox réaffichent déjà leur conversation.
function collectBuffers() {
  if (!settings().restore) return {};
  const out = { ...savedBuffers };
  for (const [id, rt] of runtime) {
    const s = sessionById(id);
    if (s?.kind === 'shell') out[id] = rt.serialize.serialize({ scrollback: RESTORE_LINES });
  }
  for (const id of Object.keys(out)) if (!sessionById(id)) delete out[id];
  return out;
}

function safeFit(rt) {
  try { rt.fit.fit(); } catch {}
}

function quotePosix(str) {
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

// Commande lancée à l'ouverture de la discussion, ou null pour un shell nu.
function startupCommand(s, shell) {
  if (s.kind === 'claude') {
    const extra = s.claudeArgs ? ' ' + s.claudeArgs : '';
    if (!s.claudeStarted) return `claude --session-id ${s.claudeId}${extra}`;
    const resume = `claude --resume ${s.claudeId}${extra}`;
    const fresh = `claude --session-id ${s.claudeId}${extra}`;
    return shell.family === 'powershell' ? `${resume}; if (-not $?) { ${fresh} }` : `${resume} || ${fresh}`;
  }
  if (s.kind === 'sandbox' && s.sbx) return sbxStartup(s);
  if (s.kind === 'sandbox') {
    const tpl = settings().sandboxCommand?.trim();
    return tpl ? tpl.replaceAll('{dossier}', `"${s.cwd}"`) : null;
  }
  return s.command?.trim() || null;
}

function shellArgs(shell, cmd) {
  if (!cmd) return shell.args;
  if (shell.family === 'powershell') return [...shell.args, '-NoExit', '-Command', cmd];
  if (shell.family === 'cmd') return ['/K', cmd];
  if (shell.id === 'wsl') return ['-e', 'bash', '-lic', `${cmd}; exec bash -li`];
  return [...shell.args, '-i', '-c', `${cmd}; exec ${quotePosix(shell.path)} ${shell.args.join(' ')}`];
}

async function startSession(s) {
  const rt = ensureTerminal(s);
  rt.el.querySelector('.exit-bar')?.remove();
  const shell = shells.find((x) => x.id === s.shell) || shells[0];
  if (!shell) {
    rt.term.writeln('\x1b[31mAucun shell trouvé sur ce PC.\x1b[0m');
    return;
  }
  const cmd = startupCommand(s, shell);
  safeFit(rt);
  rt.running = true;
  rt.exited = false;
  updateDot(s.id);
  try {
    await api.spawn({ id: s.id, shellPath: shell.path, args: shellArgs(shell, cmd), cwd: s.cwd, cols: rt.term.cols, rows: rt.term.rows });
    if (s.kind === 'claude' && !s.claudeStarted) {
      s.claudeStarted = true;
      save();
    }
    if (s.sbx && !s.sbx.created) {
      s.sbx.created = true;
      save();
    }
    // Commande tapée pour l'utilisateur (sans Entrée quand il doit d'abord attendre quelque chose).
    if (s.prefill) {
      const { text, enter } = s.prefill;
      delete s.prefill;
      save();
      setTimeout(() => api.write(s.id, text + (enter ? '\r' : '')), 1500);
    }
  } catch (err) {
    rt.running = false;
    rt.term.writeln(`\x1b[31mImpossible de lancer ${shell.name} : ${err.message}\x1b[0m`);
    updateDot(s.id);
  }
}

function showExitBar(id, code) {
  const rt = runtime.get(id);
  if (!rt) return;
  rt.el.querySelector('.exit-bar')?.remove();
  const bar = document.createElement('div');
  bar.className = 'exit-bar';
  bar.innerHTML = `<span>Processus terminé${code ? ` (code ${code})` : ''}</span>`;
  const restart = button('Relancer', 'primary', () => startSession(sessionById(id)));
  const close = button('Fermer', '', () => closeSession(id, true));
  bar.append(restart, close);
  rt.el.appendChild(bar);
}

function terminalKey(e, id) {
  if (e.type !== 'keydown') return true;
  const term = runtime.get(id)?.term;
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  // Copier / coller façon Windows Terminal.
  if (mod && !e.altKey && key === 'c' && (e.shiftKey || isMac() || term.hasSelection())) {
    if (term.hasSelection()) {
      api.copy(term.getSelection());
      term.clearSelection();
    }
    return false;
  }
  if (mod && !e.altKey && key === 'v') {
    e.preventDefault();
    term.paste(api.paste());
    return false;
  }
  // Maj+Entrée = retour à la ligne dans Claude Code.
  if (e.key === 'Enter' && e.shiftKey && sessionById(id)?.kind === 'claude') {
    api.write(id, '\x1b\r');
    return false;
  }
  if (isShortcut(e)) return false;
  return true;
}

// ---------- Discussions ----------

function activate(id) {
  const s = sessionById(id);
  if (!s) return;
  // Côte à côte, la discussion choisie prend la place de celle du panneau actif.
  if (split && split.left !== id && split.right !== id) {
    if (split.left === state.activeId) split.left = id;
    else split.right = id;
  }
  state.activeId = id;
  if (!$('#findbar').hidden) closeFind();
  const rt = ensureTerminal(s);
  layout();
  rt.unread = false;
  rt.attention = false;
  lastUsed.set(id, Date.now());
  $('#empty').hidden = true;
  if (!rt.running && !rt.exited) startSession(s);
  requestAnimationFrame(() => {
    safeFit(rt);
    rt.term.focus();
  });
  updateTopbar();
  render();
  save();
}

function layout() {
  const visible = split ? [split.left, split.right] : [state.activeId];
  $('#terminals').classList.toggle('split', !!split);
  for (const [id, rt] of runtime) {
    rt.el.classList.toggle('visible', visible.includes(id));
    rt.el.classList.toggle('pane-left', !!split && id === split.left);
    rt.el.classList.toggle('pane-right', !!split && id === split.right);
    rt.el.classList.toggle('pane-focus', !!split && id === state.activeId);
    rt.el.querySelector('.pane-name').textContent = sessionById(id)?.name || '';
  }
  requestAnimationFrame(() => visible.forEach((id) => runtime.get(id) && safeFit(runtime.get(id))));
}

function openSplit(id) {
  const s = sessionById(id);
  if (!s || id === state.activeId) return;
  if (!split) split = { left: state.activeId, right: id };
  else if (split.left !== id && split.right !== id) {
    if (split.left === state.activeId) split.right = id;
    else split.left = id;
  }
  activate(id);
}

function closeSplit() {
  split = null;
  layout();
  render();
  runtime.get(state.activeId)?.term.focus();
}

// Ctrl+Maj+E : ouvre à côté la dernière discussion utilisée, ou referme le panneau.
function toggleSplit() {
  if (split) return closeSplit();
  const other = [...lastUsed.entries()].filter(([id]) => id !== state.activeId && sessionById(id)).sort((a, b) => b[1] - a[1])[0]?.[0] || visibleOrder().find((id) => id !== state.activeId);
  if (other) openSplit(other);
}

function showEmpty() {
  state.activeId = null;
  $('#empty').hidden = false;
  updateTopbar();
}

function createSession(opts) {
  const st = settings();
  const s = {
    id: uid(),
    kind: opts.kind || 'shell',
    name: opts.name,
    shell: opts.shell || st.defaultShell,
    cwd: opts.cwd || st.defaultCwd,
    folderId: opts.folderId ?? null,
    command: opts.command || '',
    claudeArgs: opts.claudeArgs || '',
    color: null,
  };
  if (opts.sbx) s.sbx = { ...opts.sbx };
  if (s.kind === 'claude') {
    s.claudeId = uid();
    s.claudeStarted = false;
  }
  if (!s.name) {
    const shellName = shells.find((x) => x.id === s.shell)?.name || 'Terminal';
    const label = { claude: 'Claude', sandbox: 'Sandbox' }[s.kind] || shellName;
    s.name = `${label} · ${basename(s.cwd)}`;
  }
  state.sessions.push(s);
  if (s.folderId) {
    const f = folderById(s.folderId);
    if (f) f.collapsed = false;
  }
  activate(s.id);
  refreshBranches();
  return s;
}

function duplicateSession(id) {
  const s = sessionById(id);
  if (!s) return;
  const copy = createSession({ ...s, name: s.name + ' (copie)' });
  moveSession(copy.id, s.folderId, state.sessions.indexOf(s) + 1);
}

function closeSession(id, force) {
  const s = sessionById(id);
  if (!s) return;
  const rt = runtime.get(id);
  if (!force && rt?.running && !confirm(`Fermer « ${s.name} » ? Le processus en cours sera arrêté.`)) return;
  api.kill(id);
  if (rt) {
    rt.term.dispose();
    rt.el.remove();
    runtime.delete(id);
  }
  const visible = visibleOrder();
  const idx = visible.indexOf(id);
  state.sessions = state.sessions.filter((x) => x.id !== id);
  if (split && (split.left === id || split.right === id)) {
    const other = split.left === id ? split.right : split.left;
    split = null;
    if (state.activeId === id) {
      activate(other);
      save();
      return;
    }
    layout();
  }
  if (state.activeId === id) {
    const next = visible[idx + 1] || visible[idx - 1];
    if (next && next !== id) activate(next);
    else showEmpty();
  }
  render();
  save();
}

function moveSession(id, folderId, index) {
  const s = sessionById(id);
  if (!s) return;
  const from = state.sessions.indexOf(s);
  state.sessions.splice(from, 1);
  if (index == null) index = state.sessions.length;
  else if (index > from) index -= 1;
  s.folderId = folderId;
  state.sessions.splice(Math.max(0, Math.min(index, state.sessions.length)), 0, s);
  render();
  save();
}

// Ordre d'affichage dans la barre latérale (dossiers puis sans dossier).
function visibleOrder() {
  const ids = [];
  for (const f of state.folders) {
    if (f.collapsed && !search) continue;
    for (const s of state.sessions) if (s.folderId === f.id && matches(s)) ids.push(s.id);
  }
  for (const s of state.sessions) if (!folderById(s.folderId) && matches(s)) ids.push(s.id);
  return ids;
}

function cycle(dir) {
  const ids = visibleOrder();
  if (!ids.length) return;
  const i = ids.indexOf(state.activeId);
  activate(ids[(i + dir + ids.length) % ids.length]);
}

// ---------- Dossiers ----------

// Démarre toutes les discussions d'un dossier sans changer de discussion active.
function launchFolder(f) {
  const items = state.sessions.filter((s) => s.folderId === f.id && !runtime.get(s.id)?.running);
  for (const s of items) {
    ensureTerminal(s);
    startSession(s);
  }
  toast(items.length ? `${items.length} discussion${items.length > 1 ? 's' : ''} lancée${items.length > 1 ? 's' : ''} dans « ${f.name} ».` : `Tout tourne déjà dans « ${f.name} ».`, 3000);
}

function stopFolder(f) {
  const items = state.sessions.filter((s) => s.folderId === f.id && runtime.get(s.id)?.running);
  if (items.length && confirm(`Arrêter les ${items.length} discussion(s) en cours dans « ${f.name} » ?`)) items.forEach((s) => api.kill(s.id));
}

function createFolder(rename = true) {
  const f = { id: uid(), name: 'Nouveau dossier', color: COLORS[(state.folders.length * 3) % COLORS.length], collapsed: false };
  state.folders.push(f);
  render();
  save();
  if (rename) startRename('folder', f.id);
  return f;
}

function deleteFolder(id) {
  const f = folderById(id);
  if (!f) return;
  const count = state.sessions.filter((s) => s.folderId === id).length;
  if (count && !confirm(`Supprimer le dossier « ${f.name} » ? Ses ${count} discussion(s) passeront dans « Sans dossier ».`)) return;
  for (const s of state.sessions) if (s.folderId === id) s.folderId = null;
  state.folders = state.folders.filter((x) => x.id !== id);
  render();
  save();
}

function moveFolder(id, index) {
  const from = state.folders.findIndex((f) => f.id === id);
  const [f] = state.folders.splice(from, 1);
  if (index > from) index -= 1;
  state.folders.splice(index, 0, f);
  render();
  save();
}

// ---------- Barre latérale ----------

function matches(s) {
  if (!search) return true;
  const q = search.toLowerCase();
  return s.name.toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q) || (folderById(s.folderId)?.name || '').toLowerCase().includes(q);
}

const FOLDER_SVG = (color) => `<svg class="folder-icon" viewBox="0 0 16 16"><path d="M1.5 3.2c0-.4.3-.7.7-.7h3.6l1.5 1.5h6.5c.4 0 .7.3.7.7v8.1c0 .4-.3.7-.7.7H2.2c-.4 0-.7-.3-.7-.7z" style="fill:${color || 'var(--muted-2)'}" fill-opacity=".9"/></svg>`;
const CHEV_SVG = '<svg class="chev" viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function render() {
  const tree = $('#tree');
  const scroll = tree.scrollTop;
  tree.innerHTML = '';
  for (const f of state.folders) {
    const items = state.sessions.filter((s) => s.folderId === f.id && matches(s));
    if (search && !items.length && !f.name.toLowerCase().includes(search.toLowerCase())) continue;
    const el = document.createElement('div');
    el.className = 'folder' + (f.collapsed && !search ? ' collapsed' : '');
    el.dataset.folder = f.id;
    if (f.color) el.style.setProperty('--folder-color', f.color);
    const head = document.createElement('div');
    head.className = 'folder-head';
    head.draggable = true;
    const waiting = items.some((s) => runtime.get(s.id)?.attention);
    head.innerHTML = `${CHEV_SVG}${FOLDER_SVG(f.color)}<span class="name"></span>${waiting ? '<span class="dot attention" title="Une discussion attend ta réponse"></span>' : ''}<span class="count">${items.length}</span>`;
    head.querySelector('.name').textContent = f.name;
    const launch = button('▶', 'add', (e) => {
      e.stopPropagation();
      launchFolder(f);
    });
    launch.title = 'Tout lancer';
    head.appendChild(launch);
    const add = button('+', 'add', (e) => {
      e.stopPropagation();
      openNewDialog({ folderId: f.id });
    });
    add.title = 'Nouvelle discussion dans ce dossier';
    head.appendChild(add);
    head.addEventListener('click', () => {
      f.collapsed = !f.collapsed;
      render();
      save();
    });
    head.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename('folder', f.id);
    });
    head.addEventListener('contextmenu', (e) => folderMenu(e, f));
    dragSource(head, { type: 'folder', id: f.id });
    dropFolderHead(head, f);
    el.appendChild(head);
    const body = document.createElement('div');
    body.className = 'folder-body';
    for (const s of items) body.appendChild(sessionEl(s));
    el.appendChild(body);
    tree.appendChild(el);
  }
  const unfiled = state.sessions.filter((s) => !folderById(s.folderId) && matches(s));
  const zone = document.createElement('div');
  zone.className = 'unfiled-zone';
  if (state.folders.length) {
    const label = document.createElement('div');
    label.className = 'unfiled-label';
    label.textContent = 'Sans dossier';
    zone.appendChild(label);
  }
  for (const s of unfiled) zone.appendChild(sessionEl(s));
  zone.style.minHeight = '48px';
  dropUnfiled(zone);
  tree.appendChild(zone);
  tree.scrollTop = scroll;
}

const KIND_ICON = { shell: '›_', claude: '✳', sandbox: '⧉' };

function sessionEl(s) {
  const el = document.createElement('div');
  el.className = `session ${s.kind}` + (s.id === state.activeId ? ' active' : split && (split.left === s.id || split.right === s.id) ? ' in-split' : '');
  el.dataset.session = s.id;
  el.draggable = true;
  const color = colorOf(s);
  if (color) el.style.setProperty('--folder-color', color);
  el.innerHTML = `<span class="kind">${KIND_ICON[s.kind] || '›_'}</span><div class="info"><div class="name"></div><div class="sub"></div></div><span class="dot"></span>`;
  el.querySelector('.name').textContent = s.name;
  const branch = branches[cwdOf(s)];
  if (branch) el.querySelector('.sub').append(Object.assign(document.createElement('span'), { className: 'branch', textContent: '⎇ ' + branch }));
  el.querySelector('.sub').append(shortPath(cwdOf(s)));
  if (s.color) el.querySelector('.kind').style.color = s.color;
  el.title = `${s.name}\n${cwdOf(s) || ''}${branch ? `\nBranche : ${branch}` : ''}`;
  el.addEventListener('click', () => activate(s.id));
  el.addEventListener('dblclick', () => startRename('session', s.id));
  el.addEventListener('contextmenu', (e) => sessionMenu(e, s));
  el.addEventListener('auxclick', (e) => e.button === 1 && closeSession(s.id));
  dragSource(el, { type: 'session', id: s.id });
  dropSession(el, s);
  setDot(el.querySelector('.dot'), s.id);
  return el;
}

function setDot(dot, id) {
  const rt = runtime.get(id);
  dot.className = 'dot' + (rt?.attention ? ' attention' : rt?.unread ? ' unread' : rt?.running ? ' running' : rt?.exited ? ' exited' : '');
  dot.title = rt?.attention ? 'Attend ta réponse' : rt?.unread ? 'Nouvelle activité' : rt?.running ? 'En cours' : rt?.exited ? 'Terminé' : 'En veille — démarre au clic';
  dot.closest('.session')?.classList.toggle('attention', !!rt?.attention);
}

function updateDot(id) {
  const dot = document.querySelector(`.session[data-session="${id}"] .dot`);
  if (dot) setDot(dot, id);
  if (id === state.activeId) setDot($('#active-dot'), id);
}

function updateTopbar() {
  const s = sessionById(state.activeId);
  $('#active-title').textContent = s ? s.name : '';
  const branch = s && branches[cwdOf(s)];
  $('#active-path').textContent = s ? shortPath(cwdOf(s)) + (branch ? `  ⎇ ${branch}` : '') : '';
  $('#active-dot').style.visibility = s ? 'visible' : 'hidden';
  if (s) setDot($('#active-dot'), s.id);
  document.title = s ? `${s.name} — Younesh` : 'Younesh';
}

function startRename(type, id) {
  const sel = type === 'folder' ? `.folder[data-folder="${id}"] > .folder-head .name` : `.session[data-session="${id}"] .name`;
  const span = document.querySelector(sel);
  if (!span) return;
  const obj = type === 'folder' ? folderById(id) : sessionById(id);
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = obj.name;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit && input.value.trim()) obj.name = input.value.trim();
    render();
    updateTopbar();
    save();
    if (type === 'session' && id === state.activeId) runtime.get(id)?.term.focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// ---------- Glisser-déposer ----------

let dragData = null;

function dragSource(el, data) {
  el.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    dragData = data;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', data.id);
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  el.addEventListener('dragend', () => {
    dragData = null;
    el.classList.remove('dragging');
    clearDropMarks();
  });
}

function clearDropMarks() {
  document.querySelectorAll('.drop-into, .drop-before, .drop-after').forEach((x) => x.classList.remove('drop-into', 'drop-before', 'drop-after'));
}

function half(e, el) {
  const r = el.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
}

function onDrop(el, over, drop) {
  el.addEventListener('dragover', (e) => {
    if (!dragData) return;
    const mark = over(e);
    if (!mark) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    mark.el.classList.add('drop-' + mark.kind);
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) clearDropMarks();
  });
  el.addEventListener('drop', (e) => {
    if (!dragData) return;
    e.preventDefault();
    e.stopPropagation();
    const data = dragData;
    clearDropMarks();
    drop(e, data);
  });
}

function dropSession(el, target) {
  onDrop(
    el,
    (e) => (dragData.type === 'session' && dragData.id !== target.id ? { el, kind: half(e, el) } : null),
    (e, data) => {
      const idx = state.sessions.indexOf(target) + (half(e, el) === 'after' ? 1 : 0);
      moveSession(data.id, target.folderId ?? null, idx);
    },
  );
}

function dropFolderHead(head, f) {
  const folderEl = () => head.parentElement;
  onDrop(
    head,
    (e) => {
      if (dragData.type === 'session') return { el: folderEl(), kind: 'into' };
      if (dragData.type === 'folder' && dragData.id !== f.id) return { el: folderEl(), kind: half(e, head) };
      return null;
    },
    (e, data) => {
      if (data.type === 'session') {
        moveSession(data.id, f.id, null);
        f.collapsed = false;
        render();
      } else {
        const idx = state.folders.indexOf(f) + (half(e, head) === 'after' ? 1 : 0);
        moveFolder(data.id, idx);
      }
    },
  );
}

function dropUnfiled(zone) {
  onDrop(
    zone,
    () => (dragData.type === 'session' ? { el: zone, kind: 'into' } : dragData.type === 'folder' ? { el: zone, kind: 'into' } : null),
    (_e, data) => {
      if (data.type === 'session') moveSession(data.id, null, null);
      else moveFolder(data.id, state.folders.length);
    },
  );
}

// ---------- Menus contextuels ----------

function openMenu(e, build) {
  e.preventDefault();
  e.stopPropagation();
  const menu = $('#menu');
  menu.innerHTML = '';
  build(menu);
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
}

function closeMenu() {
  $('#menu').hidden = true;
}

function menuItem(menu, label, fn, cls = '') {
  const el = document.createElement('div');
  el.className = 'menu-item ' + cls;
  el.innerHTML = label;
  el.addEventListener('click', () => {
    closeMenu();
    fn();
  });
  menu.appendChild(el);
}

function menuSep(menu) {
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
}

function swatches(menu, current, pick, allowNone) {
  const label = Object.assign(document.createElement('div'), { className: 'menu-label', textContent: 'Couleur' });
  const grid = Object.assign(document.createElement('div'), { className: 'swatches' });
  const list = allowNone ? [null, ...COLORS] : COLORS;
  for (const c of list) {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (c === current ? ' selected' : '') + (c ? '' : ' none');
    if (c) sw.style.background = c;
    sw.title = c ? c : 'Aucune';
    sw.addEventListener('click', () => {
      closeMenu();
      pick(c);
    });
    grid.appendChild(sw);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.value = current || '#7c9cff';
  custom.title = 'Couleur personnalisée';
  custom.className = 'swatch';
  custom.style.padding = '0';
  custom.addEventListener('change', () => {
    closeMenu();
    pick(custom.value);
  });
  grid.appendChild(custom);
  menu.append(label, grid);
}

function folderMenu(e, f) {
  openMenu(e, (m) => {
    menuItem(m, '+ Nouvelle discussion ici', () => openNewDialog({ folderId: f.id }));
    menuItem(m, '✳ Nouvelle discussion Claude ici', () => openNewDialog({ folderId: f.id, kind: 'claude' }));
    menuItem(m, '⧉ Nouvelle sandbox ici', () => openSbxNew({ folderId: f.id }));
    menuSep(m);
    menuItem(m, '▶ Tout lancer', () => launchFolder(f));
    menuItem(m, '■ Tout arrêter', () => stopFolder(f));
    menuSep(m);
    menuItem(m, 'Renommer', () => startRename('folder', f.id));
    menuItem(m, f.collapsed ? 'Déplier' : 'Replier', () => {
      f.collapsed = !f.collapsed;
      render();
      save();
    });
    swatches(m, f.color, (c) => {
      f.color = c;
      render();
      save();
    }, true);
    menuSep(m);
    menuItem(m, 'Supprimer le dossier', () => deleteFolder(f.id), 'danger');
  });
}

function sessionMenu(e, s) {
  const rt = runtime.get(s.id);
  openMenu(e, (m) => {
    if (s.sbx) sbxSessionMenu(m, s);
    menuItem(m, 'Renommer', () => startRename('session', s.id));
    menuItem(m, 'Dupliquer', () => duplicateSession(s.id));
    if (s.id !== state.activeId) menuItem(m, '◫ Ouvrir à côté', () => openSplit(s.id));
    if (split && (split.left === s.id || split.right === s.id)) menuItem(m, '◫ Fermer le panneau', closeSplit);
    menuItem(m, rt?.running ? 'Redémarrer' : 'Démarrer', () => {
      activate(s.id);
      startSession(s);
    });
    menuItem(m, 'Modifier…', () => openEditDialog(s));
    menuItem(m, 'Copier le chemin', () => api.copy(s.cwd || ''));
    menuSep(m);
    m.appendChild(Object.assign(document.createElement('div'), { className: 'menu-label', textContent: 'Ranger dans' }));
    for (const f of state.folders) {
      if (f.id === s.folderId) continue;
      const item = document.createElement('span');
      item.innerHTML = `<span class="sw" style="background:${f.color || 'var(--muted-2)'}"></span>`;
      item.append(document.createTextNode(f.name));
      menuItem(m, item.innerHTML, () => moveSession(s.id, f.id, null));
    }
    if (s.folderId) menuItem(m, '<span class="sw" style="border:1px solid var(--muted-2)"></span>Sans dossier', () => moveSession(s.id, null, null));
    menuItem(m, '+ Nouveau dossier…', () => {
      const f = createFolder(false);
      moveSession(s.id, f.id, null);
      startRename('folder', f.id);
    });
    swatches(m, s.color, (c) => {
      s.color = c;
      render();
      save();
    }, true);
    menuSep(m);
    menuItem(m, 'Fermer la discussion', () => closeSession(s.id), 'danger');
  });
}

// ---------- Fenêtres ----------

function button(label, cls, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

function openModal(html, onReady) {
  const modal = $('#modal');
  modal.classList.remove('wide');
  modal.innerHTML = html;
  $('#modal-backdrop').hidden = false;
  onReady(modal);
  modal.querySelector('input, select')?.focus();
}

function closeModal() {
  $('#modal-backdrop').hidden = true;
  $('#modal').innerHTML = '';
  runtime.get(state.activeId)?.term.focus();
}

const esc = (str) => String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function sessionForm(s, title, submitLabel) {
  const shellOptions = shells.map((x) => `<option value="${x.id}" ${x.id === s.shell ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const folderOptions = ['<option value="">Sans dossier</option>', ...state.folders.map((f) => `<option value="${f.id}" ${f.id === s.folderId ? 'selected' : ''}>${esc(f.name)}</option>`)].join('');
  return `
    <h2>${title}</h2>
    <form id="session-form">
      <label class="field"><span>Type</span>
        <div class="segmented" id="kind">
          <button type="button" data-kind="shell">›_ Terminal</button>
          <button type="button" data-kind="claude">✳ Claude Code</button>
          ${s.kind === 'sandbox' ? '<button type="button" data-kind="sandbox">⧉ Sandbox</button>' : ''}
        </div>
      </label>
      <label class="field"><span>Nom</span><input name="name" value="${esc(s.name)}" placeholder="Automatique" spellcheck="false"></label>
      <div class="field"><span>Dossier de travail</span>
        <div class="row"><input name="cwd" value="${esc(s.cwd)}" spellcheck="false"><button type="button" id="browse">Parcourir…</button></div>
      </div>
      <label class="field"><span>Shell</span><select name="shell">${shellOptions}</select></label>
      <label class="field"><span>Ranger dans</span><select name="folderId">${folderOptions}</select></label>
      <label class="field" data-for="shell"><span>Commande au démarrage (facultatif)</span><input name="command" value="${esc(s.command)}" placeholder="ex. npm run dev" spellcheck="false"></label>
      <label class="field" data-for="claude"><span>Options Claude (facultatif)</span><input name="claudeArgs" value="${esc(s.claudeArgs)}" placeholder="ex. --model opus" spellcheck="false">
        <small>La conversation Claude est liée à cette discussion : elle reprend là où tu t'étais arrêté, même après avoir fermé Younesh.</small></label>
      <div class="field" data-for="sandbox"><span>Sandbox</span>
        <small>${s.sbx ? `Sandbox sbx « ${esc(s.sbx.projet)} ». Clic droit sur la discussion pour la rouvrir, y installer des outils ou la supprimer.` : 'Ancienne discussion sandbox : utilise le bouton ⧉ pour en créer une nouvelle.'}</small></div>
      <div class="modal-actions"><button type="button" id="cancel">Annuler</button><button type="submit" class="primary">${submitLabel}</button></div>
    </form>`;
}

function bindSessionForm(modal, s, onSubmit, lockKind) {
  let kind = s.kind || 'shell';
  const setKind = (k) => {
    kind = k;
    modal.querySelectorAll('#kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === k));
    modal.querySelectorAll('[data-for]').forEach((el) => (el.hidden = el.dataset.for !== k));
  };
  modal.querySelectorAll('#kind button').forEach((b) => {
    b.disabled = lockKind && b.dataset.kind !== kind;
    b.addEventListener('click', () => setKind(b.dataset.kind));
  });
  setKind(kind);
  const form = modal.querySelector('form');
  modal.querySelector('#browse').addEventListener('click', async () => {
    const dir = await api.pickFolder(form.cwd.value || info.home);
    if (dir) form.cwd.value = dir;
  });
  modal.querySelector('#cancel').addEventListener('click', closeModal);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.kind = kind;
    data.folderId = data.folderId || null;
    closeModal();
    onSubmit(data);
  });
}

function openNewDialog(preset = {}) {
  const st = settings();
  const active = sessionById(state.activeId);
  const s = {
    kind: preset.kind || 'shell',
    name: '',
    shell: st.defaultShell,
    cwd: preset.cwd || st.defaultCwd,
    folderId: preset.folderId !== undefined ? preset.folderId : active?.folderId ?? null,
    command: '',
    claudeArgs: '',
  };
  openModal(sessionForm(s, 'Nouvelle discussion', 'Créer'), (modal) => {
    bindSessionForm(modal, s, (data) => createSession(data));
    modal.querySelector('[name=name]').focus();
  });
}

function openEditDialog(s) {
  openModal(sessionForm(s, 'Modifier la discussion', 'Enregistrer'), (modal) => {
    bindSessionForm(modal, s, (data) => {
      const relaunch = data.shell !== s.shell || data.cwd !== s.cwd || data.command !== (s.command || '') || data.claudeArgs !== (s.claudeArgs || '');
      Object.assign(s, { name: data.name.trim() || s.name, shell: data.shell, cwd: data.cwd, folderId: data.folderId, command: data.command, claudeArgs: data.claudeArgs });
      render();
      updateTopbar();
      refreshBranches();
      save();
      if (relaunch && runtime.get(s.id)?.running && confirm('Relancer la discussion avec ces réglages ?')) startSession(s);
    }, true);
  });
}

function openSettings() {
  const st = settings();
  const shellOptions = shells.map((x) => `<option value="${x.id}" ${x.id === st.defaultShell ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  openModal(`
    <h2>Réglages</h2>
    <form id="settings-form">
      <label class="field"><span>Shell par défaut</span><select name="defaultShell">${shellOptions}</select></label>
      <div class="field"><span>Dossier de travail par défaut</span>
        <div class="row"><input name="defaultCwd" value="${esc(st.defaultCwd)}" spellcheck="false"><button type="button" id="browse">Parcourir…</button></div>
      </div>
      <div class="field"><span>Sandbox sbx</span><div class="row"><button type="button" id="sbx-setup">Préparer le poste…</button><button type="button" id="sbx-config">Configurer sbx…</button></div></div>
      <div class="field"><span>Apparence</span>
        <div class="row">
          <select name="theme">${[['auto', 'Automatique (comme Windows)'], ...Object.entries(THEMES).map(([id, t]) => [id, t.name])].map(([id, n]) => `<option value="${id}" ${id === st.theme ? 'selected' : ''}>${n}</option>`).join('')}</select>
          <select name="cursorStyle">${[['block', 'Curseur bloc'], ['bar', 'Curseur barre'], ['underline', 'Curseur souligné']].map(([id, n]) => `<option value="${id}" ${id === st.cursorStyle ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </div>
      </div>
      <label class="check"><input type="checkbox" name="cursorBlink" ${st.cursorBlink ? 'checked' : ''}> Curseur clignotant</label>
      <label class="check"><input type="checkbox" name="material" ${st.material ? 'checked' : ''}> Barre latérale translucide (effet Mica de Windows 11, expérimental)</label>
      <div class="field"><span>Sauvegarde de tes dossiers, discussions et réglages</span><div class="row"><button type="button" id="backup-export">Exporter…</button><button type="button" id="backup-import">Importer…</button></div></div>
      <label class="field"><span>Police</span><input name="fontFamily" value="${esc(st.fontFamily)}" spellcheck="false"></label>
      <label class="field"><span>Taille du texte</span><input name="fontSize" type="number" min="9" max="28" value="${st.fontSize}"></label>
      <label class="field"><span>Historique (lignes gardées par terminal)</span><input name="scrollback" type="number" min="1000" max="100000" step="1000" value="${st.scrollback}"></label>
      <label class="check"><input type="checkbox" name="restore" ${st.restore ? 'checked' : ''}> Retrouver le contenu des terminaux au redémarrage</label>
      <label class="check"><input type="checkbox" name="notify" ${st.notify ? 'checked' : ''}> Notification Windows quand Claude attend ta réponse</label>
      <label class="check"><input type="checkbox" name="gpu" ${st.gpu ? 'checked' : ''}> Accélération graphique (plus fluide, à décocher en cas d'affichage bizarre)</label>
      <small style="color:var(--muted)">Raccourcis : Ctrl+Maj+P sélecteur rapide · Ctrl+Maj+T discussion · Ctrl+Maj+N Claude · Ctrl+Maj+D dossier · Ctrl+Tab suivante · Ctrl+Maj+W fermer · F2 renommer · Ctrl+Maj+F chercher dans le terminal · Ctrl+Maj+B barre latérale · Ctrl+Maj+U discussion qui attend · Ctrl+Maj+E côte à côte · Ctrl +/− taille</small>
      <div class="modal-actions"><button type="button" id="cancel">Annuler</button><button type="submit" class="primary">Enregistrer</button></div>
    </form>`, (modal) => {
    const form = modal.querySelector('form');
    modal.querySelector('#browse').addEventListener('click', async () => {
      const dir = await api.pickFolder(form.defaultCwd.value || info.home);
      if (dir) form.defaultCwd.value = dir;
    });
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    modal.querySelector('#sbx-setup').addEventListener('click', openSbxSetup);
    modal.querySelector('#backup-export').addEventListener('click', exportBackup);
    modal.querySelector('#backup-import').addEventListener('click', importBackup);
    modal.querySelector('#sbx-config').addEventListener('click', openSbxConfig);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const gpuChanged = !!data.gpu !== settings().gpu;
      state.settings = { ...state.settings, ...data, fontSize: Number(data.fontSize) || 14, scrollback: Number(data.scrollback) || 10000, gpu: !!data.gpu, notify: !!data.notify, restore: !!data.restore, cursorBlink: !!data.cursorBlink, material: !!data.material };
      applyFont();
      applyAppearance();
      if (gpuChanged) alert('L\'accélération graphique changera au prochain démarrage de Younesh.');
      save();
      closeModal();
    });
  });
}

function applyFont() {
  const st = settings();
  for (const rt of runtime.values()) {
    rt.term.options.fontSize = st.fontSize;
    rt.term.options.fontFamily = st.fontFamily;
    rt.term.options.scrollback = st.scrollback;
    safeFit(rt);
  }
}

// ---------- Sauvegarde ----------

function backupJson() {
  const sessions = state.sessions.map(({ prefill, ...s }) => s);
  return JSON.stringify({ format: 'younesh-backup', version: 1, exportedAt: new Date().toISOString(), folders: state.folders, sessions, settings: state.settings }, null, 2);
}

function exportBackup() {
  api.saveJson(`younesh-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`, backupJson());
}

async function importBackup() {
  const text = await api.openJson();
  if (text != null) importBackupText(text);
}

function importBackupText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return alert('Ce fichier n\'est pas un JSON valide.');
  }
  if (data.format !== 'younesh-backup') return alert('Ce fichier n\'est pas une sauvegarde Younesh.');
  const newFolders = (data.folders || []).filter((f) => !folderById(f.id));
  const newSessions = (data.sessions || []).filter((s) => !sessionById(s.id));
  openModal(`
    <h2>Importer une sauvegarde</h2>
    <form>
      <label class="check"><input type="checkbox" name="items" checked> Ajouter ${newFolders.length} dossier(s) et ${newSessions.length} discussion(s) à ceux que tu as déjà</label>
      <label class="check"><input type="checkbox" name="settings"> Remplacer mes réglages (thème, police, configuration sbx…)</label>
      <p class="hint">Rien n'est supprimé. Les dossiers de travail qui n'existent pas sur ce PC s'ouvriront dans ton dossier personnel.</p>
      <div class="modal-actions"><button type="button" id="cancel">Annuler</button><button type="submit" class="primary">Importer</button></div>
    </form>`, (modal) => {
    const form = modal.querySelector('form');
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (form.items.checked) {
        state.folders.push(...newFolders);
        state.sessions.push(...newSessions);
      }
      if (form.settings.checked && data.settings) state.settings = { ...data.settings, sidebarWidth: state.settings.sidebarWidth };
      closeModal();
      applyAppearance();
      applyFont();
      render();
      refreshBranches();
      save();
      toast('Sauvegarde importée.', 3000);
    });
  });
}

function applyAppearance() {
  const st = settings();
  const theme = themeOf(st.theme);
  for (const [k, v] of Object.entries(theme.ui)) document.documentElement.style.setProperty('--' + k, v);
  document.documentElement.classList.toggle('material', st.material);
  api.setChrome({ bg: theme.ui.bg, fg: theme.ui.text, material: st.material });
  for (const rt of runtime.values()) {
    rt.term.options.theme = theme.term;
    rt.term.options.cursorStyle = st.cursorStyle;
    rt.term.options.cursorBlink = st.cursorBlink;
  }
}

function changeFontSize(delta) {
  const size = delta === 0 ? 14 : Math.max(9, Math.min(28, settings().fontSize + delta));
  state.settings.fontSize = size;
  applyFont();
  save();
}

// ---------- Raccourcis et interface ----------

function quickNew(kind) {
  const active = sessionById(state.activeId);
  createSession({ kind, folderId: active?.folderId ?? null, cwd: active && cwdOf(active) });
}

function isShortcut(e) {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && e.key === 'Tab') return true;
  if (e.key === 'F2') return true;
  if (mod && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) return true;
  if (mod && e.shiftKey && ['t', 'n', 'd', 'w', 'f', 'b', 'u', 'p', 'e'].includes(key)) return true;
  if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) return true;
  return false;
}

function handleShortcut(e) {
  if (document.querySelector('.secret-layer')) return;
  if (!$('#modal-backdrop').hidden) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (e.key === 'Escape') closeMenu();
  if (!isShortcut(e)) return;
  const key = e.key.toLowerCase();
  e.preventDefault();
  e.stopPropagation();
  if (e.ctrlKey && e.key === 'Tab') return cycle(e.shiftKey ? -1 : 1);
  if (e.key === 'PageDown') return cycle(1);
  if (e.key === 'PageUp') return cycle(-1);
  if (e.key === 'F2') return state.activeId && startRename('session', state.activeId);
  if (e.key === '=' || e.key === '+') return changeFontSize(1);
  if (e.key === '-') return changeFontSize(-1);
  if (e.key === '0') return changeFontSize(0);
  if (key === 't') return quickNew('shell');
  if (key === 'n') return quickNew('claude');
  if (key === 'd') return createFolder();
  if (key === 'w') return state.activeId && closeSession(state.activeId);
  if (key === 'f') return openFind();
  if (key === 'b') return toggleSidebar();
  if (key === 'u') return jumpToAttention();
  if (key === 'p') return $('#palette').hidden ? openPalette() : closePalette();
  if (key === 'e') return toggleSplit();
}

function toggleSidebar() {
  const hidden = $('#sidebar').style.display === 'none';
  $('#sidebar').style.display = hidden ? '' : 'none';
  $('#resizer').style.display = hidden ? '' : 'none';
}

function bindUI() {
  $('#btn-new').addEventListener('click', () => openNewDialog());
  $('#btn-new-claude').addEventListener('click', () => openNewDialog({ kind: 'claude' }));
  $('#btn-new-folder').addEventListener('click', () => createFolder());
  $('#btn-sandbox').addEventListener('click', () => openSbxNew());
  $('#btn-sandbox').addEventListener('contextmenu', sbxButtonMenu);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#palette-input').addEventListener('input', () => {
    paletteIndex = 0;
    renderPalette();
  });
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') movePalette(1);
    else if (e.key === 'ArrowUp') movePalette(-1);
    else if (e.key === 'Enter') runPalette(paletteIndex);
    else if (e.key === 'Escape') closePalette();
    else return;
    e.preventDefault();
  });
  $('#palette-input').addEventListener('blur', () => setTimeout(() => !$('#palette').contains(document.activeElement) && closePalette(false), 120));
  $('#find-input').addEventListener('input', () => find(1, true));
  $('#find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') find(e.shiftKey ? -1 : 1);
    if (e.key === 'Escape') closeFind();
  });
  $('#find-next').addEventListener('click', () => find(1));
  $('#find-prev').addEventListener('click', () => find(-1));
  $('#find-close').addEventListener('click', closeFind);
  $('#find-case').addEventListener('click', () => {
    findCase = !findCase;
    $('#find-case').classList.toggle('on', findCase);
    find(1, true);
  });
  $('#search').addEventListener('input', (e) => {
    search = e.target.value.trim();
    render();
  });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.target.value = '';
      search = '';
      render();
      runtime.get(state.activeId)?.term.focus();
    }
    if (e.key === 'Enter') {
      const first = visibleOrder()[0];
      if (first) activate(first);
    }
  });
  $('#tree').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.session, .folder-head')) return;
    openMenu(e, (m) => {
      menuItem(m, '+ Nouvelle discussion', () => openNewDialog({ folderId: null }));
      menuItem(m, '✳ Nouvelle discussion Claude', () => openNewDialog({ folderId: null, kind: 'claude' }));
      menuItem(m, 'Nouveau dossier', () => createFolder());
      if (state.folders.length) {
        menuSep(m);
        menuItem(m, 'Tout replier', () => { state.folders.forEach((f) => (f.collapsed = true)); render(); save(); });
        menuItem(m, 'Tout déplier', () => { state.folders.forEach((f) => (f.collapsed = false)); render(); save(); });
      }
    });
  });
  document.addEventListener('keydown', handleShortcut, true);
  // Sans ça, lâcher un fichier hors du terminal ferait naviguer la fenêtre vers ce fichier.
  document.addEventListener('dragover', (e) => e.dataTransfer.types.includes('Files') && e.preventDefault());
  document.addEventListener('drop', (e) => e.dataTransfer.files.length && e.preventDefault());
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#menu')) closeMenu();
  });
  window.addEventListener('blur', closeMenu);
  $('#modal-backdrop').addEventListener('mousedown', (e) => e.target.id === 'modal-backdrop' && closeModal());

  // Partage entre les deux panneaux.
  const divider = $('#split-divider');
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const box = $('#terminals').getBoundingClientRect();
    const move = (ev) => {
      const ratio = Math.max(20, Math.min(80, ((ev.clientX - box.left) / box.width) * 100));
      $('#terminals').style.setProperty('--split', ratio + '%');
      layout();
    };
    const up = () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });

  // Largeur de la barre latérale.
  const resizer = $('#resizer');
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizer.classList.add('active');
    const move = (ev) => {
      const w = Math.max(200, Math.min(520, ev.clientX));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
      state.settings.sidebarWidth = w;
    };
    const up = () => {
      resizer.classList.remove('active');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      save();
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

init();
