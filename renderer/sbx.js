'use strict';

// Sandbox sbx, en trois couches pour qu'une nouvelle version de sbx ne touche que « cli » :
//  - cli : les commandes sbx elles-mêmes (créer, ouvrir, exécuter, supprimer) ;
//  - setup : la préparation du poste, une fois par PC ;
//  - installs : ce qu'on installe dans une sandbox, choisi projet par projet.
// La configuration vit dans les réglages locaux, jamais dans le dépôt, et s'importe ou s'exporte en JSON.
// Variables : {projet}, {dossier}, {script} (exec) et {secret:NOM}, demandé au lancement et jamais enregistré.

const SBX_DEFAULT = {
  format: 'younesh-sbx',
  version: 1,
  cli: {
    create: 'sbx run --name={projet} --clone claude .',
    open: 'sbx run --name={projet}',
    exec: 'sbx exec -it {projet} bash -lc "{script}"',
    remove: 'sbx rm {projet}',
  },
  setup: [
    { id: 'version', label: 'Vérifier la version de sbx', cmd: 'sbx version' },
    { id: 'login', label: 'Se connecter à Docker', cmd: 'sbx login' },
    { id: 'network', label: 'Initialiser le réseau (choisir le mode)', cmd: 'sbx' },
  ],
  installs: [
    { id: 'claude-update', label: 'Mettre à jour Claude', script: 'claude update' },
    { id: 'tz', label: 'Fuseau horaire Europe/Paris', script: "echo 'export TZ=Europe/Paris' >> /etc/sandbox-persistent.sh" },
  ],
};

// « sbx run <nom> » est déprécié depuis sbx 0.33 : les configurations enregistrées ou importées passent à --name.
function sbxConfig() {
  const cfg = state.settings.sbx || structuredClone(SBX_DEFAULT);
  if (cfg.cli?.open?.trim() === 'sbx run {projet}') cfg.cli.open = SBX_DEFAULT.cli.open;
  return cfg;
}

const sbxImageOf = (create) => /\s--template=(\S+)/.exec(create)?.[1] || '';

function sbxCreateTemplate(create, image) {
  const bare = create.replace(/\s+--template=\S+/, '');
  return image ? bare.replace(/^\s*\S+\s+\S+/, (start) => `${start} --template=${image}`) : bare;
}

const sbxSlug = (name) => (name || 'projet').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'projet';
const sbxFill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

function base64(str) {
  let bin = '';
  for (const byte of new TextEncoder().encode(str)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

// Les étapes d'installation partent en un seul « exec ». Le script est encodé en base64 pour
// traverser PowerShell, cmd ou bash sans souci de guillemets ni de « $ », puis lancé depuis un
// fichier pour garder le clavier (sudo, questions éventuelles).
const SBX_INSTALL_DONE = '==> Installation terminée.';

// La commande s'exécute déjà dans la sandbox, où sbx n'existe pas. Celle copiée depuis une doc arrive souvent
// emballée (« sbx exec -it nom bash -lc '…' ») : seul l'intérieur est gardé, aussi pour celles déjà enregistrées.
function sbxInnerScript(script) {
  return script.split('\n').map((line) => {
    const inShell = /^\s*sbx\s+exec\s+(?:-\S+\s+)*\S+\s+(?:bash|sh)\s+-l?c\s+(['"])(.*)\1\s*$/.exec(line);
    return inShell ? inShell[2] : line.replace(/^\s*sbx\s+exec\s+(?:-\S+\s+)*\S+\s+/, '');
  }).join('\n');
}

function sbxInstallCommand(projet, items) {
  const lines = ['set -e', ...items.flatMap((it) => [`echo; echo "==> ${it.label.replace(/"/g, '')}"`, sbxInnerScript(it.script)]), `echo; echo "${SBX_INSTALL_DONE} Relance Claude : clic droit sur la sandbox, Rouvrir Claude."`];
  const script = `echo ${base64(lines.join('\n'))} | base64 -d > /tmp/younesh-install.sh && bash /tmp/younesh-install.sh`;
  return sbxFill(sbxConfig().cli.exec, { projet, script });
}

function sbxStartup(s, shell, hasGit) {
  const cli = sbxConfig().cli;
  const vars = { projet: s.sbx.projet, dossier: `"${s.cwd}"` };
  if (!s.sbx.created) {
    const create = s.sbx.image === undefined ? cli.create : sbxCreateTemplate(cli.create, s.sbx.image);
    // --clone copie un dépôt git : sans dépôt dans le dossier, la création échoue. On l'enlève.
    return sbxFill(hasGit === false ? create.replace(/\s--clone\b/g, '') : create, vars);
  }
  const open = sbxFill(cli.open, vars);
  if (open.includes(' -- ') || !/\bclaude\b/.test(cli.create)) return open;
  // Sans message envoyé, pas de conversation : --continue échoue et la relance de secours reste bloquée (écran noir).
  if (s.sbx.talked === false) return open;
  // Reprend la dernière conversation de la sandbox ; s'il n'y en a pas encore, Claude démarre normalement.
  const resume = `${open} -- --continue`;
  return shell.family === 'powershell' ? `${resume}; if (-not $?) { ${open} }` : `${resume} || ${open}`;
}

// Une sandbox existante met parfois une minute à démarrer, écran noir compris : une pastille l'indique
// jusqu'à ce que Claude s'affiche, que le processus s'arrête, ou au bout de 5 minutes.
const ESCAPES = /\x1b\[[0-9;?<>=]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function sbxShowLoading(rt, what) {
  sbxHideLoading(rt);
  const pill = document.createElement('div');
  pill.className = 'load-pill';
  rt.el.appendChild(pill);
  const start = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - start) / 1000);
    if (s >= 300) return sbxHideLoading(rt);
    pill.textContent = `${what} ${['·  ', '·· ', '···'][s % 3]}  ${s} s`;
  };
  tick();
  rt.loading = { pill, timer: setInterval(tick, 1000), tail: '' };
}

function sbxHideLoading(rt) {
  if (!rt?.loading) return;
  clearInterval(rt.loading.timer);
  rt.loading.pill.remove();
  rt.loading = null;
}

// L'en-tête « Claude Code » n'arrive pas toujours d'un bloc (reprise d'une conversation, espaces remplacés par des
// déplacements du curseur) : la zone de saisie de Claude (lignes ─── et ❯) suffit aussi.
function sbxWatchLoading(rt, data) {
  if (!rt.loading) return;
  // Recherche sur tout le bloc reçu, puis seule la fin est gardée pour le bloc suivant (comme watchApiBilling).
  const raw = rt.loading.tail + data;
  rt.loading.tail = raw.slice(-300);
  const text = raw.replace(ESCAPES, '');
  if (text.replace(/ /g, '').includes('ClaudeCode') || text.includes('───') || text.includes('❯')) sbxHideLoading(rt);
}

// « Git remote sandbox-NOM is not ready … git://127.0.0.1:PORT/DEPOT » : Younesh repose le remote lui-même (main.js).
function sbxWatchGitRemote(s, rt, data) {
  if (!s?.sbx || !s.cwd || info.platform !== 'win32') return;
  // Recherche sur tout le bloc reçu, puis seule la fin est gardée pour le bloc suivant (comme watchApiBilling).
  const text = (rt.gitTail || '') + data;
  rt.gitTail = text.slice(-2000);
  const nr = /Git remote (sandbox-[\w.-]+) is not ready/.exec(text);
  const url = /git:\/\/127\.0\.0\.1:(\d{2,5})\/([\w.-]+)/.exec(text);
  if (!nr || !url) return;
  rt.gitTail = '';
  api.repairGitRemote(s.cwd, nr[1], url[1], url[2])
    .then((ok) => toast(ok ? `Remote git « ${nr[1]} » réparé.` : `La réparation du remote git « ${nr[1]} » a échoué.`, 8000));
}

// Discussion d'appoint (préparation du poste, installation…) : réutilisée si elle existe déjà.
// La commande est tapée sans Entrée quand il faut attendre que la sandbox soit prête.
function sbxHelper(name, cwd, folderId, text, enter) {
  let h = state.sessions.find((x) => x.helper === name);
  if (!h) {
    h = createSession({ kind: 'shell', name, cwd, folderId });
    h.helper = name;
  }
  const rt = runtime.get(h.id);
  if (rt?.running) {
    activate(h.id);
    api.write(h.id, text + (enter ? '\r' : ''));
  } else {
    h.prefill = { text, enter };
    activate(h.id);
  }
  save();
  return h;
}

function toast(message, ms = 9000, action) {
  const el = $('#toast');
  el.textContent = message;
  if (action) {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      el.hidden = true;
      action.run();
    });
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- Nouvelle sandbox ----------

// Les commandes enregistrées : cases à cocher, plus ajouter, modifier et supprimer sur place.
// Renvoie la fonction qui donne les commandes cochées.
function mountInstalls(box, checked) {
  const selected = new Set(checked);
  const store = (cfg) => {
    state.settings.sbx = cfg;
    save();
  };
  const editor = (item) => {
    box.querySelector('.install-add').hidden = true;
    const form = document.createElement('div');
    form.className = 'install-editor';
    form.innerHTML = `
      <label class="field"><span>Nom</span><input class="install-label" value="${esc(item?.label)}" spellcheck="false" placeholder="Plugin de l'équipe"></label>
      <label class="field"><span>Commande, lancée dans la sandbox</span><textarea class="install-script" spellcheck="false" placeholder="claude plugin install …">${esc(item?.script)}</textarea></label>
      <div class="row"><button type="button" class="install-cancel">Annuler</button><button type="button" class="primary install-save">Enregistrer la commande</button></div>`;
    box.append(form);
    const label = form.querySelector('.install-label');
    const script = form.querySelector('.install-script');
    label.focus();
    label.addEventListener('keydown', (e) => e.key === 'Enter' && e.preventDefault());
    form.querySelector('.install-cancel').addEventListener('click', draw);
    form.querySelector('.install-save').addEventListener('click', () => {
      if (!label.value.trim()) return label.focus();
      if (!script.value.trim()) return script.focus();
      const cfg = sbxConfig();
      const known = item && cfg.installs.find((x) => x.id === item.id);
      if (known) {
        known.label = label.value.trim();
        known.script = script.value.trim();
      } else {
        let id = sbxSlug(label.value);
        while (cfg.installs.some((x) => x.id === id)) id += '-2';
        cfg.installs.push({ id, label: label.value.trim(), script: script.value.trim() });
        selected.add(id);
      }
      store(cfg);
      draw();
    });
  };
  function draw() {
    const cfg = sbxConfig();
    box.querySelectorAll('.install-row, .install-editor, .install-add, small').forEach((x) => x.remove());
    box.insertAdjacentHTML('beforeend', `${cfg.installs.length ? '' : '<small>Aucune commande enregistrée.</small>'}
      ${cfg.installs.map((it) => `<div class="install-row"><label class="check"><input type="checkbox" name="install" value="${esc(it.id)}" ${selected.has(it.id) ? 'checked' : ''}> ${esc(it.label)}</label><button type="button" class="ghost" data-edit="${esc(it.id)}" title="Modifier">✎</button><button type="button" class="ghost" data-del="${esc(it.id)}" title="Supprimer">✕</button></div>`).join('')}
      <button type="button" class="install-add">+ Ajouter une commande</button>`);
    box.querySelectorAll('[name=install]').forEach((c) => c.addEventListener('change', () => (c.checked ? selected.add(c.value) : selected.delete(c.value))));
    box.querySelector('.install-add').addEventListener('click', () => editor(null));
    box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editor(sbxConfig().installs.find((x) => x.id === b.dataset.edit))));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const current = sbxConfig();
      const item = current.installs.find((x) => x.id === b.dataset.del);
      if (!confirm(`Supprimer la commande « ${item.label} » ?`)) return;
      current.installs = current.installs.filter((x) => x !== item);
      selected.delete(item.id);
      store(current);
      draw();
    }));
  }
  draw();
  return () => sbxConfig().installs.filter((x) => selected.has(x.id));
}

function openSbxNew(preset = {}) {
  const cfg = sbxConfig();
  const st = settings();
  const active = sessionById(state.activeId);
  const cwd = preset.cwd || (active && cwdOf(active)) || st.defaultCwd;
  const folderId = preset.folderId !== undefined ? preset.folderId : active?.folderId ?? null;
  const folderOptions = ['<option value="">Sans dossier</option>', ...state.folders.map((f) => `<option value="${f.id}" ${f.id === folderId ? 'selected' : ''}>${esc(f.name)}</option>`)].join('');
  openModal(`
    <h2>Nouvelle sandbox</h2>
    <form>
      <div class="field"><span>Dossier du projet</span>
        <div class="row"><input name="cwd" value="${esc(cwd)}" spellcheck="false"><button type="button" id="browse">Parcourir…</button></div>
      </div>
      <label class="field"><span>Nom de la sandbox</span><input name="projet" value="${esc(sbxSlug(basename(cwd)))}" spellcheck="false"></label>
      <label class="field"><span>Ranger dans</span><select name="folderId">${folderOptions}</select></label>
      <label class="field"><span>Image de la sandbox (facultatif)</span><input name="image" value="${esc(st.sbxImage ?? sbxImageOf(cfg.cli.create))}" spellcheck="false"></label>
      <div class="field" id="installs"><span>Installer dans la sandbox</span></div>
      <p class="hint"><a href="#" id="go-setup">Préparer le poste</a> (une fois par PC) · <a href="#" id="go-config">Configurer sbx</a></p>
      <div class="modal-actions"><button type="button" id="cancel">Annuler</button><button type="submit" class="primary">Créer la sandbox</button></div>
    </form>`, (modal) => {
    const form = modal.querySelector('form');
    const selectedInstalls = mountInstalls(modal.querySelector('#installs'), st.sbxLastInstalls || []);
    let nameEdited = false;
    form.projet.addEventListener('input', () => (nameEdited = true));
    const syncName = () => !nameEdited && (form.projet.value = sbxSlug(basename(form.cwd.value)));
    form.cwd.addEventListener('input', syncName);
    modal.querySelector('#browse').addEventListener('click', async () => {
      const dir = await api.pickFolder(form.cwd.value || info.home);
      if (dir) {
        form.cwd.value = dir;
        syncName();
      }
    });
    modal.querySelector('#go-setup').addEventListener('click', (e) => (e.preventDefault(), openSbxSetup()));
    modal.querySelector('#go-config').addEventListener('click', (e) => (e.preventDefault(), openSbxConfig()));
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const projet = sbxSlug(form.projet.value);
      const dir = form.cwd.value.trim();
      const folder = form.folderId.value || null;
      const items = selectedInstalls();
      const image = form.image.value.replace(/\s+/g, '');
      state.settings.sbxLastInstalls = items.map((it) => it.id);
      state.settings.sbxImage = image;
      closeModal();
      createSandbox(projet, dir, folder, items, image);
    });
  });
}

function createSandbox(projet, dir, folderId, items, image) {
  const s = createSession({ kind: 'sandbox', name: projet, cwd: dir, folderId, sbx: { projet, created: false, image, talked: false } });
  if (items.length) {
    const h = sbxHelper(`Installation · ${projet}`, dir, folderId, sbxInstallCommand(projet, items), false);
    moveSession(h.id, folderId, state.sessions.indexOf(s) + 1);
    activate(s.id);
    sbxRunWhenReady(projet, h.id);
    toast(`Sandbox « ${projet} » : connecte-toi dans Claude (/login). Les commandes se lanceront seules dans « Installation · ${projet} » dès que la sandbox tourne.`, 15000);
  } else {
    toast(`Sandbox « ${projet} » : connecte-toi dans Claude avec /login la première fois.`);
  }
}

// La commande est déjà tapée dans la discussion d'installation : on la valide dès que « sbx ls » montre
// la sandbox en marche. Après 10 minutes sans la voir, on rend la main : Entrée la lance toujours.
const sbxInstalling = new Map();
const SBX_READY_TRIES = 200;

async function sbxRunWhenReady(projet, helperId) {
  sbxInstalling.set(helperId, { projet, tail: '' });
  for (let i = 0; i < SBX_READY_TRIES; i++) {
    if (!sessionById(helperId)) return sbxInstalling.delete(helperId);
    const res = await api.sbxList();
    const running = res.sandboxes?.some((x) => x.name === projet && /^running/i.test(x.status));
    if (running && runtime.get(helperId)?.running && !sessionById(helperId)?.prefill) {
      await new Promise((r) => setTimeout(r, 2000));
      api.write(helperId, '\r');
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  sbxInstalling.delete(helperId);
  toast(`La sandbox « ${projet} » n'a pas démarré. Quand elle tourne, va dans « Installation · ${projet} » et appuie sur Entrée.`, 30000);
}

// Claude doit être rouvert pour voir ce qu'on vient d'installer. On le propose sans le faire : un /login peut être en cours.
function sbxWatchInstall(id, data) {
  const watch = sbxInstalling.get(id);
  if (!watch) return;
  watch.tail = (watch.tail + data).slice(-200);
  if (!watch.tail.includes(SBX_INSTALL_DONE)) return;
  sbxInstalling.delete(id);
  const s = state.sessions.find((x) => x.sbx?.projet === watch.projet);
  toast(`Installation terminée dans « ${watch.projet} ».`, 120000, s && { label: 'Rouvrir Claude', run: () => (activate(s.id), startSession(s)) });
}

// ---------- Sandbox existante ----------

// Rouvre dans Younesh une sandbox créée ailleurs (autre terminal, tableau de bord sbx) ou dont la discussion a été fermée.
function openSbxExisting(preset = {}) {
  openModal(`
    <h2>Ouvrir une sandbox existante</h2>
    <input class="sbx-filter" type="search" placeholder="Filtrer par nom ou dossier…" spellcheck="false">
    <div class="sbx-list"><small>Recherche des sandboxes (sbx ls)…</small></div>
    <div class="modal-actions"><button type="button" id="new">Nouvelle sandbox…</button><span style="flex:1"></span><button type="button" id="cancel">Fermer</button></div>`, async (modal) => {
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    modal.querySelector('#new').addEventListener('click', () => openSbxNew(preset));
    const res = await api.sbxList();
    const list = modal.querySelector('.sbx-list');
    if (!list.isConnected) return;
    if (res.error) return (list.innerHTML = `<small>${esc(res.error)}</small>`);
    if (!res.sandboxes.length) return (list.innerHTML = '<small>Aucune sandbox sur ce PC.</small>');
    // Les sandboxes déjà ouvertes dans Younesh passent en bas de la liste, avec un badge : un clic y ramène.
    const items = res.sandboxes.map((x) => {
      const known = state.sessions.find((s) => s.sbx?.projet === x.name);
      return { x, known, open: !!(known && runtime.get(known.id)?.running) };
    }).sort((a, b) => a.open - b.open);
    const draw = (query) => {
      const q = query.trim().toLowerCase();
      const shown = items.filter(({ x }) => `${x.name} ${x.workspace}`.toLowerCase().includes(q));
      list.innerHTML = shown.length ? shown.map(({ x, known, open }) => {
        const sub = [x.status, x.workspace && shortPath(x.workspace), known && !open && 'déjà dans Younesh'].filter(Boolean).join(' · ');
        return `<button type="button" class="sbx-item" data-i="${items.findIndex((it) => it.x === x)}"><span class="kind">⧉</span><span class="info"><span class="name">${esc(x.name)}</span><span class="sub">${esc(sub)}</span></span>${open ? '<span class="sbx-badge">Déjà ouverte</span>' : ''}</button>`;
      }).join('') : '<small>Aucune sandbox ne correspond.</small>';
      list.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
        closeModal();
        openExistingSandbox(items[Number(b.dataset.i)].x, preset.folderId);
      }));
    };
    const filter = modal.querySelector('.sbx-filter');
    filter.addEventListener('input', () => draw(filter.value));
    draw(filter.value);
  });
}

function openExistingSandbox(x, folderId) {
  const known = state.sessions.find((s) => s.sbx?.projet === x.name);
  if (known) {
    activate(known.id);
    if (!runtime.get(known.id)?.running) startSession(known);
    return;
  }
  const active = sessionById(state.activeId);
  createSession({ kind: 'sandbox', name: x.name, cwd: x.workspace || info.home, folderId: folderId !== undefined ? folderId : active?.folderId ?? null, sbx: { projet: x.name, created: true } });
}

function openSbxInstall(s) {
  openModal(`
    <h2>Installer dans « ${esc(s.sbx.projet)} »</h2>
    <form>
      <div class="field" id="installs"><span>À installer</span></div>
      <p class="hint">Les commandes se lancent seules dans une discussion d'installation dès que la sandbox tourne.</p>
      <div class="modal-actions"><button type="button" id="cancel">Annuler</button><button type="submit" class="primary">Préparer</button></div>
    </form>`, (modal) => {
    const form = modal.querySelector('form');
    const selectedInstalls = mountInstalls(modal.querySelector('#installs'), []);
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const items = selectedInstalls();
      closeModal();
      if (items.length) sbxRunWhenReady(s.sbx.projet, sbxHelper(`Installation · ${s.sbx.projet}`, s.cwd, s.folderId, sbxInstallCommand(s.sbx.projet, items), false).id);
    });
  });
}

function removeSandbox(s) {
  const projet = s.sbx.projet;
  if (!confirm(`Supprimer la sandbox « ${projet} » ?\n\nAvant, récupère les commits non poussés : git fetch sandbox-${projet}\n\nLa commande de suppression sera tapée dans une discussion, à valider avec Entrée.`)) return;
  api.kill(s.id);
  s.sbx.removed = true;
  save();
  sbxHelper(`Commandes sbx · ${projet}`, s.cwd, s.folderId, sbxFill(sbxConfig().cli.remove, { projet, dossier: `"${s.cwd}"` }), false);
}

function sbxSessionMenu(m, s) {
  menuItem(m, '⧉ Rouvrir Claude dans la sandbox', () => {
    activate(s.id);
    startSession(s);
  });
  menuItem(m, '⧉ Installer dans la sandbox…', () => openSbxInstall(s));
  menuItem(m, '⧉ Supprimer la sandbox…', () => removeSandbox(s), 'danger');
  menuSep(m);
}

// ---------- Préparer le poste ----------

function openSbxSetup() {
  const cfg = sbxConfig();
  const done = state.settings.sbxDone || {};
  const rows = cfg.setup.map((st, i) => `
    <div class="setup-step">
      <input type="checkbox" data-done="${esc(st.id)}" ${done[st.id] ? 'checked' : ''} title="Fait">
      <div class="info"><div>${esc(st.label)}</div><code>${esc(st.cmd)}</code></div>
      <button type="button" data-run="${i}">Lancer</button>
    </div>`).join('');
  openModal(`
    <h2>Préparer le poste</h2>
    <p class="hint">À faire une fois par PC. Chaque étape est lancée dans la discussion « Préparation du poste (sbx) ». Les secrets sont demandés au lancement et ne sont jamais enregistrés.</p>
    <div class="setup-list">${rows || '<small>Aucune étape configurée.</small>'}</div>
    <div class="modal-actions"><button type="button" id="config">Configurer sbx</button><button type="button" id="cancel" class="primary">Fermer</button></div>`, (modal) => {
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    modal.querySelector('#config').addEventListener('click', openSbxConfig);
    modal.querySelectorAll('[data-done]').forEach((box) => box.addEventListener('change', () => {
      state.settings.sbxDone = { ...(state.settings.sbxDone || {}), [box.dataset.done]: box.checked };
      save();
    }));
    modal.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => {
      const step = cfg.setup[Number(b.dataset.run)];
      const cmd = await askSecrets(step.cmd);
      if (cmd == null) return;
      const box = modal.querySelector(`[data-done="${CSS.escape(step.id)}"]`);
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      sbxHelper('Préparation du poste (sbx)', info.home, null, cmd, true);
      b.textContent = 'Relancer';
    }));
  });
}

// Demande chaque {secret:NOM} dans une petite fenêtre par-dessus, sans rien enregistrer.
function askSecrets(cmd) {
  const names = [...new Set([...cmd.matchAll(/\{secret:(\w+)\}/g)].map((m) => m[1]))];
  if (!names.length) return Promise.resolve(cmd);
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = 'secret-layer';
    layer.innerHTML = `<form class="secret-box"><h2>Secret requis</h2>${names.map((n) => `<label class="field"><span>${esc(n)}</span><input type="password" name="${esc(n)}" autocomplete="off" required></label>`).join('')}<p class="hint">Utilisé pour cette commande uniquement, jamais enregistré par Younesh.</p><div class="modal-actions"><button type="button" id="secret-cancel">Annuler</button><button type="submit" class="primary">Lancer</button></div></form>`;
    document.body.appendChild(layer);
    const form = layer.querySelector('form');
    form.querySelector('input').focus();
    const finish = (value) => {
      layer.remove();
      resolve(value);
    };
    layer.querySelector('#secret-cancel').addEventListener('click', () => finish(null));
    form.addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), finish(null)));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(cmd.replace(/\{secret:(\w+)\}/g, (_m, n) => form[n].value));
    });
  });
}

// ---------- Configuration ----------

function validateSbx(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'Le fichier doit contenir un objet JSON.';
  for (const k of ['create', 'open', 'exec', 'remove']) if (typeof cfg.cli?.[k] !== 'string') return `Il manque la commande cli.${k}.`;
  if (!cfg.cli.exec.includes('{script}')) return 'cli.exec doit contenir {script}.';
  for (const [list, field] of [['setup', 'cmd'], ['installs', 'script']]) {
    if (!Array.isArray(cfg[list])) return `« ${list} » doit être une liste.`;
    for (const it of cfg[list]) if (!it.id || !it.label || typeof it[field] !== 'string') return `Chaque élément de « ${list} » doit avoir id, label et ${field}.`;
  }
  return null;
}

// JSON coloré : le texte est recopié en couleurs dans un <pre> placé sous la zone de saisie, dont le texte est transparent.
const JSON_TOKEN = /("(?:[^"\\\n]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

function colorJson(area, pre) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paint = () => {
    let html = '';
    let last = 0;
    for (const m of area.value.matchAll(JSON_TOKEN)) {
      html += esc(area.value.slice(last, m.index));
      const cls = m[1] ? (m[2] ? 'key' : 'str') : m[3] ? 'num' : m[4] ? 'lit' : 'pun';
      const tok = cls === 'key' ? m[1] : m[0];
      html += `<span class="j-${cls}">${esc(tok)}</span>` + (cls === 'key' ? esc(m[2]) : '');
      last = m.index + m[0].length;
    }
    // Le \n final garde la même hauteur que la zone de saisie quand le texte finit par un retour à la ligne.
    pre.innerHTML = html + esc(area.value.slice(last)) + '\n';
    pre.scrollTop = area.scrollTop;
    pre.scrollLeft = area.scrollLeft;
  };
  area.addEventListener('input', paint);
  area.addEventListener('scroll', () => {
    pre.scrollTop = area.scrollTop;
    pre.scrollLeft = area.scrollLeft;
  });
  return paint;
}

function openSbxConfig() {
  openModal(`
    <h2>Configurer sbx</h2>
    <p class="hint"><b>cli</b> : les commandes sbx (à changer seulement si sbx évolue). <b>setup</b> : la préparation du poste. <b>installs</b> : ce qu'on peut installer dans une sandbox.<br>
    Variables : <code>{projet}</code>, <code>{dossier}</code>, <code>{script}</code>, <code>{secret:NOM}</code>.</p>
    <div class="code-wrap"><pre class="code-hl" aria-hidden="true"></pre><textarea id="sbx-json" class="code" spellcheck="false" wrap="off"></textarea></div>
    <p class="hint" id="sbx-error"></p>
    <div class="modal-actions">
      <button type="button" id="import">Importer…</button>
      <button type="button" id="export">Exporter…</button>
      <button type="button" id="reset">Par défaut</button>
      <span style="flex:1"></span>
      <button type="button" id="cancel">Annuler</button>
      <button type="button" id="save" class="primary">Enregistrer</button>
    </div>`, (modal) => {
    modal.closest('#modal').classList.add('wide');
    const area = modal.querySelector('#sbx-json');
    const error = modal.querySelector('#sbx-error');
    const paint = colorJson(area, modal.querySelector('.code-hl'));
    area.value = JSON.stringify(sbxConfig(), null, 2);
    paint();
    const parse = () => {
      try {
        const cfg = JSON.parse(area.value);
        const problem = validateSbx(cfg);
        error.textContent = problem || '';
        return problem ? null : cfg;
      } catch (err) {
        error.textContent = 'JSON invalide : ' + err.message;
        return null;
      }
    };
    modal.querySelector('#import').addEventListener('click', async () => {
      const text = await api.openJson();
      if (text != null) {
        area.value = text;
        if (parse()) area.value = JSON.stringify(JSON.parse(text), null, 2);
        paint();
      }
    });
    modal.querySelector('#export').addEventListener('click', () => parse() && api.saveJson('younesh-sbx.json', area.value));
    modal.querySelector('#reset').addEventListener('click', () => {
      area.value = JSON.stringify(SBX_DEFAULT, null, 2);
      paint();
      parse();
    });
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    modal.querySelector('#save').addEventListener('click', () => {
      const cfg = parse();
      if (!cfg) return;
      state.settings.sbx = cfg;
      save();
      closeModal();
      toast('Configuration sbx enregistrée.', 3000);
    });
  });
}

function sbxButtonMenu(e) {
  openMenu(e, (m) => {
    menuItem(m, '⧉ Nouvelle sandbox…', () => openSbxNew());
    menuItem(m, '⧉ Ouvrir une sandbox existante…', () => openSbxExisting());
    menuSep(m);
    menuItem(m, 'Préparer le poste…', openSbxSetup);
    menuItem(m, 'Configurer sbx…', openSbxConfig);
  });
}
