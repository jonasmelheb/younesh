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
    open: 'sbx run {projet}',
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

const sbxConfig = () => state.settings.sbx || structuredClone(SBX_DEFAULT);
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
function sbxInstallCommand(projet, items) {
  const lines = ['set -e', ...items.flatMap((it) => [`echo; echo "==> ${it.label.replace(/"/g, '')}"`, it.script]), 'echo; echo "==> Installation terminée. Relance Claude : clic droit sur la sandbox, Rouvrir Claude."'];
  const script = `echo ${base64(lines.join('\n'))} | base64 -d > /tmp/younesh-install.sh && bash /tmp/younesh-install.sh`;
  return sbxFill(sbxConfig().cli.exec, { projet, script });
}

function sbxStartup(s) {
  const cli = sbxConfig().cli;
  return sbxFill(s.sbx.created ? cli.open : cli.create, { projet: s.sbx.projet, dossier: `"${s.cwd}"` });
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

function toast(message, ms = 9000) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- Nouvelle sandbox ----------

function installChecks(cfg, checked) {
  if (!cfg.installs.length) return '<small>Aucune installation configurée (Configurer sbx).</small>';
  return cfg.installs.map((it) => `<label class="check"><input type="checkbox" name="install" value="${esc(it.id)}" ${checked.includes(it.id) ? 'checked' : ''}> ${esc(it.label)}</label>`).join('');
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
      <div class="field"><span>Installer dans la sandbox</span>${installChecks(cfg, st.sbxLastInstalls || [])}</div>
      <p class="hint"><a href="#" id="go-setup">Préparer le poste</a> (une fois par PC) · <a href="#" id="go-config">Configurer sbx</a></p>
      <div class="modal-actions"><button type="button" id="cancel">Annuler</button><button type="submit" class="primary">Créer la sandbox</button></div>
    </form>`, (modal) => {
    const form = modal.querySelector('form');
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
      const checked = [...form.querySelectorAll('[name=install]:checked')].map((x) => x.value);
      state.settings.sbxLastInstalls = checked;
      closeModal();
      createSandbox(projet, dir, folder, cfg.installs.filter((it) => checked.includes(it.id)));
    });
  });
}

function createSandbox(projet, dir, folderId, items) {
  const s = createSession({ kind: 'sandbox', name: projet, cwd: dir, folderId, sbx: { projet, created: false } });
  if (items.length) {
    const h = sbxHelper(`Installation · ${projet}`, dir, folderId, sbxInstallCommand(projet, items), false);
    moveSession(h.id, folderId, state.sessions.indexOf(s) + 1);
    activate(s.id);
    toast(`Sandbox « ${projet} » : connecte-toi dans Claude (/login). Une fois Claude ouvert, va dans « Installation · ${projet} » et appuie sur Entrée.`, 15000);
  } else {
    toast(`Sandbox « ${projet} » : connecte-toi dans Claude avec /login la première fois.`);
  }
}

function openSbxInstall(s) {
  const cfg = sbxConfig();
  openModal(`
    <h2>Installer dans « ${esc(s.sbx.projet)} »</h2>
    <form>
      <div class="field"><span>À installer</span>${installChecks(cfg, [])}</div>
      <p class="hint">La commande est tapée dans une discussion d'installation : appuie sur Entrée quand la sandbox tourne.</p>
      <div class="modal-actions"><button type="button" id="cancel">Annuler</button><button type="submit" class="primary">Préparer</button></div>
    </form>`, (modal) => {
    const form = modal.querySelector('form');
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const checked = [...form.querySelectorAll('[name=install]:checked')].map((x) => x.value);
      closeModal();
      const items = cfg.installs.filter((it) => checked.includes(it.id));
      if (items.length) sbxHelper(`Installation · ${s.sbx.projet}`, s.cwd, s.folderId, sbxInstallCommand(s.sbx.projet, items), false);
    });
  });
}

function removeSandbox(s) {
  const projet = s.sbx.projet;
  if (!confirm(`Supprimer la sandbox « ${projet} » ?\n\nAvant, récupère les commits non poussés : git fetch sandbox-${projet}\n\nLa commande de suppression sera tapée dans une discussion, à valider avec Entrée.`)) return;
  api.kill(s.id);
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

function openSbxConfig() {
  openModal(`
    <h2>Configurer sbx</h2>
    <p class="hint"><b>cli</b> : les commandes sbx (à changer seulement si sbx évolue). <b>setup</b> : la préparation du poste. <b>installs</b> : ce qu'on peut installer dans une sandbox.<br>
    Variables : <code>{projet}</code>, <code>{dossier}</code>, <code>{script}</code>, <code>{secret:NOM}</code>.</p>
    <textarea id="sbx-json" class="code" spellcheck="false"></textarea>
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
    area.value = JSON.stringify(sbxConfig(), null, 2);
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
      }
    });
    modal.querySelector('#export').addEventListener('click', () => parse() && api.saveJson('younesh-sbx.json', area.value));
    modal.querySelector('#reset').addEventListener('click', () => {
      area.value = JSON.stringify(SBX_DEFAULT, null, 2);
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
    menuItem(m, 'Préparer le poste…', openSbxSetup);
    menuItem(m, 'Configurer sbx…', openSbxConfig);
  });
}
