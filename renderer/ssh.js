'use strict';

// Connexions SSH et tunnels (redirection de ports), avec le client OpenSSH livré avec Windows 10 et 11.
// Une discussion SSH lance ssh directement : les clés, l'agent, ~/.ssh/config et la vérification des
// serveurs (known_hosts) restent gérés par OpenSSH. Younesh n'enregistre aucun mot de passe.

const SSH_ICON = '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="2" y="2.5" width="12" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="9" width="12" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.8" cy="4.75" r=".9" fill="currentColor"/><circle cx="4.8" cy="11.25" r=".9" fill="currentColor"/></svg>';

const sshEnabled = () => !!settings().ssh;
const sshTarget = (c) => (c.user ? `${c.user}@${c.host}` : c.host);
const sshLabel = (c) => sshTarget(c) + (c.port ? `:${c.port}` : '');

// Découpe « -A -o "Clé=valeur avec espaces" » comme le ferait un shell simple.
function splitArgs(str) {
  return [...(str || '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

// « -- » avant le serveur : une adresse qui commencerait par un tiret ne peut pas passer pour une option.
function sshArgs(c, extra = []) {
  const args = [];
  if (c.port) args.push('-p', String(c.port));
  if (c.identity) args.push('-i', c.identity);
  if (c.jump) args.push('-J', c.jump);
  return [...args, ...splitArgs(c.options), ...extra, '--', sshTarget(c)];
}

function sshCommandLine(c) {
  return ['ssh', ...sshArgs(c).filter((a) => a !== '--')].map((a) => (/[\s"']/.test(a) ? `"${a}"` : a)).join(' ');
}

function folderSelect(folderId) {
  return ['<option value="">Sans dossier</option>', ...state.folders.map((f) => `<option value="${f.id}" ${f.id === folderId ? 'selected' : ''}>${esc(f.name)}</option>`)].join('');
}

// ---------- Connexions ----------

// « moi@serveur » ou « serveur:2222 » collés dans le champ de l'adresse sont rangés dans les bons champs.
function readSsh(data) {
  let user = data.user.trim();
  let host = data.host.trim();
  let port = data.port.trim();
  const at = host.lastIndexOf('@');
  if (at > 0 && !user) [user, host] = [host.slice(0, at), host.slice(at + 1)];
  const m = /^([^:\s]+):(\d+)$/.exec(host);
  if (m && !port) [host, port] = [m[1], m[2]];
  return { host, user, port, identity: data.identity.trim(), jump: data.jump.trim(), options: data.options.trim() };
}

function sshProblem(c) {
  if (!c.host) return 'Indique l\'adresse du serveur.';
  if (/^-|\s/.test(c.host) || /^-|\s|@/.test(c.user)) return 'L\'adresse et l\'utilisateur ne peuvent pas contenir d\'espace ni commencer par un tiret.';
  if (c.port && !(/^\d+$/.test(c.port) && +c.port >= 1 && +c.port <= 65535)) return 'Le port doit être un nombre entre 1 et 65535.';
  return null;
}

function openSshDialog(s, preset = {}) {
  const c = s?.ssh || { host: '', user: '', port: '', identity: '', jump: '', options: '' };
  const active = sessionById(state.activeId);
  const folderId = s ? s.folderId : preset.folderId !== undefined ? preset.folderId : active?.folderId ?? null;
  openModal(`
    <h2>${s ? 'Modifier la connexion SSH' : 'Nouvelle connexion SSH'}</h2>
    <form>
      <div class="field"><span>Serveur</span>
        <div class="row ssh-target"><input name="user" value="${esc(c.user)}" placeholder="utilisateur" spellcheck="false"><span class="at">@</span><input name="host" value="${esc(c.host)}" placeholder="adresse, ou nom dans ~/.ssh/config" spellcheck="false"><input name="port" value="${esc(c.port)}" placeholder="22" spellcheck="false" inputmode="numeric"></div>
      </div>
      <label class="field"><span>Nom</span><input name="name" value="${esc(s?.name || '')}" placeholder="Automatique" spellcheck="false"></label>
      <div class="field"><span>Clé privée (facultatif)</span>
        <div class="row"><input name="identity" value="${esc(c.identity)}" placeholder="Clés par défaut et agent SSH" spellcheck="false"><button type="button" id="browse-key">Parcourir…</button></div>
      </div>
      <label class="field"><span>Serveur de rebond (facultatif)</span><input name="jump" value="${esc(c.jump)}" placeholder="ex. admin@bastion.exemple.fr" spellcheck="false"></label>
      <label class="field"><span>Options ssh en plus (facultatif)</span><input name="options" value="${esc(c.options)}" placeholder="ex. -A pour transférer l'agent" spellcheck="false"></label>
      <label class="field"><span>Ranger dans</span><select name="folderId">${folderSelect(folderId)}</select></label>
      <p class="hint">Younesh n'enregistre aucun mot de passe : ssh le demande dans le terminal. Avec une clé et l'agent SSH, plus besoin de le taper.</p>
      <p class="hint form-error" id="ssh-error"></p>
      <div class="modal-actions"><button type="button" id="cancel">Annuler</button><button type="submit" class="primary">${s ? 'Enregistrer' : 'Se connecter'}</button></div>
    </form>`, (modal) => {
    const form = modal.querySelector('form');
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    modal.querySelector('#browse-key').addEventListener('click', async () => {
      const file = await api.pickFile(form.identity.value || `${info.home}${isMac() ? '/' : '\\'}.ssh`);
      if (file) form.identity.value = file;
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const next = readSsh(data);
      const problem = sshProblem(next);
      if (problem) return (modal.querySelector('#ssh-error').textContent = problem);
      closeModal();
      const name = data.name.trim();
      const folder = data.folderId || null;
      if (!s) return createSession({ kind: 'ssh', name: name || sshTarget(next), cwd: info.home, folderId: folder, ssh: next });
      const changed = JSON.stringify(next) !== JSON.stringify(s.ssh);
      Object.assign(s, { name: name || s.name, folderId: folder, ssh: next });
      render();
      updateTopbar();
      save();
      if (changed && runtime.get(s.id)?.running && confirm('Se reconnecter avec ces réglages ?')) startSession(s);
    });
  });
}

// Les serveurs de ~/.ssh/config (sauf les motifs comme « * »). Plusieurs noms sur une ligne Host partagent ses réglages ;
// comme dans ssh, la première valeur trouvée pour un réglage l'emporte.
function parseSshConfig(text) {
  const hosts = [];
  let props = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(\w+)\s*(?:=\s*|\s)\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith('#')) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      props = {};
      for (const alias of value.split(/\s+/)) if (alias && !/[*?!]/.test(alias)) hosts.push({ alias, props });
    } else if (key === 'match') props = null;
    else if (props && !(key in props)) props[key] = value;
  }
  return hosts;
}

// Les discussions importées gardent juste le nom du serveur : ssh relit ~/.ssh/config à chaque connexion.
async function openSshImport(preset = {}) {
  const hosts = parseSshConfig(await api.sshConfig());
  const known = (alias) => state.sessions.some((s) => s.kind === 'ssh' && s.ssh.host === alias && !s.ssh.user && !s.ssh.port);
  const active = sessionById(state.activeId);
  const folderId = preset.folderId !== undefined ? preset.folderId : active?.folderId ?? null;
  const rows = hosts.map((h, i) => {
    const p = h.props;
    const detail = [p.user && p.user + '@', p.hostname || h.alias, p.port && ':' + p.port].filter(Boolean).join('');
    return `<label class="check"><input type="checkbox" name="host" value="${i}" ${known(h.alias) ? '' : 'checked'}> <span><b>${esc(h.alias)}</b> <small>${esc(detail)}${known(h.alias) ? ' · déjà dans Younesh' : ''}</small></span></label>`;
  }).join('');
  openModal(`
    <h2>Importer depuis ~/.ssh/config</h2>
    <form>
      ${hosts.length ? `<div class="ssh-import">${rows}</div><label class="field"><span>Ranger dans</span><select name="folderId">${folderSelect(folderId)}</select></label>` : '<p class="hint">Aucun serveur trouvé dans ~/.ssh/config.</p>'}
      <div class="modal-actions"><button type="button" id="cancel">${hosts.length ? 'Annuler' : 'Fermer'}</button>${hosts.length ? '<button type="submit" class="primary">Importer</button>' : ''}</div>
    </form>`, (modal) => {
    const form = modal.querySelector('form');
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const picked = [...form.querySelectorAll('[name=host]:checked')].map((x) => hosts[Number(x.value)]);
      const folder = form.folderId.value || null;
      closeModal();
      for (const h of picked) createSession({ kind: 'ssh', name: h.alias, cwd: info.home, folderId: folder, ssh: { host: h.alias, user: '', port: '', identity: '', jump: '', options: '' }, background: true });
      toast(picked.length ? `${picked.length} serveur(s) ajouté(s). Clique sur l'un d'eux pour t'y connecter.` : 'Aucun serveur choisi.', 4000);
    });
  });
}

function sshSessionMenu(m, s) {
  const n = tunnelsOf(s.id).length;
  if (sshEnabled()) {
    menuItem(m, `⇄ Tunnels de ce serveur${n ? ` (${n})` : ''}…`, () => openTunnels(s.id));
    menuItem(m, '⇄ Nouveau tunnel sur ce serveur…', () => openTunnelForm(null, { sessionId: s.id, back: s.id }));
  }
  menuItem(m, 'Copier la commande ssh', () => api.copy(sshCommandLine(s.ssh)));
  menuSep(m);
}

function sshButtonMenu(e) {
  openMenu(e, (m) => {
    menuItem(m, 'Nouvelle connexion SSH…', () => openSshDialog());
    menuItem(m, 'Importer depuis ~/.ssh/config…', () => openSshImport());
    menuSep(m);
    menuItem(m, '⇄ Tunnels…', () => openTunnels());
    menuItem(m, '⇄ Nouveau tunnel…', () => openTunnelForm());
  });
}

// ---------- Tunnels ----------

// Un tunnel : { id, name, sessionId (la connexion SSH), type L | R | D, port, host, hostPort, auto }.
const TUNNEL_STATUS = { off: 'Fermé', connecting: 'Connexion…', prompt: 'Attend ta réponse', on: 'Ouvert', retry: 'Coupé', error: 'Erreur' };
const tunnelRt = new Map(); // id -> { status, message, tail, wanted, everOn, retries, asking, timers… }
const tunnelList = () => (state.tunnels ||= []);
const tunnelById = (id) => tunnelList().find((t) => t.id === id);
const tunnelsOf = (sessionId) => tunnelList().filter((t) => t.sessionId === sessionId);
const tunnelState = (id) => tunnelRt.get(id) || tunnelRt.set(id, { status: 'off', message: '', tail: '' }).get(id);
const tunnelOpen = (t) => tunnelState(t.id).status === 'on';

function tunnelSpec(t) {
  if (t.type === 'D') return ['-D', String(t.port)];
  return [t.type === 'R' ? '-R' : '-L', `${t.port}:${t.host || 'localhost'}:${t.hostPort}`];
}

// -N : pas de shell, juste les ports. ExitOnForwardFailure : s'arrêter si le port ne s'ouvre pas, au lieu de rester
// connecté pour rien. LogLevel=VERBOSE : ssh écrit « Authenticated to … » une fois connecté.
function tunnelArgs(t, c) {
  return sshArgs(c, ['-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=VERBOSE', ...tunnelSpec(t)]);
}

function tunnelText(t) {
  const server = sessionById(t.sessionId)?.name || 'serveur supprimé';
  const dest = `${t.host || 'localhost'}:${t.hostPort}`;
  if (t.type === 'D') return `Proxy SOCKS sur ce PC (localhost:${t.port}), via ${server}`;
  if (t.type === 'R') return `Port ${t.port} de ${server} → ${dest} vu depuis ce PC`;
  return `localhost:${t.port} sur ce PC → ${dest} vu depuis ${server}`;
}

function tunnelName(t) {
  if (t.name) return t.name;
  if (t.type === 'D') return `SOCKS ${t.port}`;
  return `${t.type === 'R' ? 'Distant' : 'Local'} ${t.port} → ${t.host || 'localhost'}:${t.hostPort}`;
}

function setTunnel(id, status, message = '') {
  const rt = tunnelState(id);
  rt.status = status;
  rt.message = message;
  if (status === 'on') {
    rt.everOn = true;
    rt.retries = 0;
  }
  applySshUi();
  renderTunnelRows();
  render();
}

// Ouverture demandée par l'utilisateur (ou au démarrage) : on repart de zéro pour les nouveaux essais.
function openTunnel(t) {
  Object.assign(tunnelState(t.id), { everOn: false, retries: 0 });
  startTunnel(t);
}

async function startTunnel(t) {
  const rt = tunnelState(t.id);
  clearTimeout(rt.timer);
  const s = sessionById(t.sessionId);
  if (!s?.ssh) return setTunnel(t.id, 'error', 'La connexion SSH de ce tunnel a été supprimée.');
  Object.assign(rt, { wanted: true, tail: '' });
  setTunnel(t.id, 'connecting');
  const res = await api.tunnelStart(t.id, tunnelArgs(t, s.ssh));
  if (!rt.wanted) return api.tunnelStop(t.id);
  if (res.error) {
    rt.wanted = false;
    setTunnel(t.id, 'error', 'ssh est introuvable sur ce PC : installe le « Client OpenSSH » (Paramètres › Système › Fonctionnalités facultatives).');
  }
}

function stopTunnel(t) {
  const rt = tunnelState(t.id);
  rt.wanted = false;
  clearTimeout(rt.timer);
  clearTimeout(rt.onTimer);
  api.tunnelStop(t.id);
  rt.cancelPrompt?.();
  setTunnel(t.id, 'off');
}

function startAutoTunnels() {
  for (const t of tunnelList()) if (t.auto && !tunnelState(t.id).wanted) openTunnel(t);
}

function stopAllTunnels() {
  for (const t of tunnelList()) if (tunnelState(t.id).wanted) stopTunnel(t);
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;

// Sous Windows, ConPTY peut passer à la ligne en déplaçant le curseur (CSI H) et sauter des espaces (CSI C) :
// on les remplace par un retour à la ligne et une espace avant d'enlever le reste des séquences.
function plainText(data) {
  return data.replace(/\x1b\[[\d;]*[Hf]/g, '\n').replace(/\x1b\[\d*C/g, ' ').replace(ANSI, '');
}

function onTunnelData(id, data) {
  const rt = tunnelRt.get(id);
  if (!rt?.wanted) return;
  rt.tail = (rt.tail + plainText(data)).slice(-6000);
  // Connecté. On attend encore un peu : un port déjà pris fait quitter ssh juste après.
  if (rt.status !== 'on' && !rt.onTimer && /Authenticated to /.test(rt.tail)) {
    rt.onTimer = setTimeout(() => {
      rt.onTimer = null;
      if (rt.wanted && rt.status !== 'on') setTunnel(id, 'on');
    }, 1200);
  }
  clearTimeout(rt.promptTimer);
  if (rt.status !== 'on') rt.promptTimer = setTimeout(() => checkPrompt(id), 350);
}

// ssh pose une question (mot de passe, phrase de passe, code, nouveau serveur) : sa dernière ligne, sans retour
// à la ligne, finit par « : » ou « ? ».
function checkPrompt(id) {
  const rt = tunnelRt.get(id);
  if (!rt?.wanted || rt.status === 'on' || rt.asking || rt.onTimer) return;
  const lines = rt.tail.split(/\r?\n/);
  const question = (lines.pop() || '').split('\r').pop().trim();
  if (!/[:?]$/.test(question)) return;
  askTunnel(id, question, lines.map((l) => l.trim()).filter(Boolean).slice(-4).join('\n'));
}

let promptQueue = Promise.resolve();

function askTunnel(id, question, context) {
  const rt = tunnelState(id);
  rt.asking = true;
  setTunnel(id, 'prompt');
  api.flash();
  promptQueue = promptQueue.then(() => new Promise((resolve) => {
    const t = tunnelById(id);
    if (!rt.wanted || !t) {
      rt.asking = false;
      return resolve();
    }
    const yesNo = /\(yes\/no/i.test(question);
    const layer = document.createElement('div');
    layer.className = 'secret-layer';
    layer.innerHTML = `<form class="secret-box"><h2>Tunnel « ${esc(tunnelName(t))} »</h2>${yesNo
      ? '<p class="hint">Premier passage sur ce serveur : ssh demande de confirmer son empreinte. Vérifie-la auprès de son administrateur si tu as un doute.</p><pre class="ssh-question"></pre>'
      : '<label class="field"><span></span><input type="password" name="answer" autocomplete="off"></label><p class="hint">Envoyé à ssh pour cette connexion uniquement, jamais enregistré par Younesh.</p>'}
      <div class="modal-actions"><button type="button" id="t-cancel">${yesNo ? 'Refuser' : 'Annuler'}</button><button type="submit" class="primary">${yesNo ? 'Faire confiance' : 'Envoyer'}</button></div></form>`;
    if (yesNo) layer.querySelector('pre').textContent = [context, question].filter(Boolean).join('\n');
    else layer.querySelector('.field span').textContent = question;
    document.body.appendChild(layer);
    (layer.querySelector('input') || layer.querySelector('[type=submit]')).focus();
    const form = layer.querySelector('form');
    const finish = (answer, stop) => {
      if (!layer.isConnected) return;
      layer.remove();
      rt.asking = false;
      rt.cancelPrompt = null;
      if (answer != null) {
        api.tunnelWrite(id, answer + '\r');
        rt.tail += '\n';
        if (rt.status === 'prompt') setTunnel(id, 'connecting');
      } else if (stop) stopTunnel(t);
      if ($('#modal-backdrop').hidden) runtime.get(state.activeId)?.term.focus();
      resolve();
    };
    rt.cancelPrompt = () => finish(null, false);
    layer.querySelector('#t-cancel').addEventListener('click', () => finish(null, true));
    form.addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), finish(null, true)));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(yesNo ? 'yes' : form.answer.value, true);
    });
  }));
}

// final : inutile de réessayer tout seul (refus, port pris, serveur qui a changé d'empreinte).
function tunnelError(tail, t, code) {
  const has = (re) => re.test(tail);
  if (has(/REMOTE HOST IDENTIFICATION HAS CHANGED/i)) return { final: true, message: 'L\'empreinte du serveur a changé depuis la dernière connexion : réinstallation, ou tentative d\'interception. Vérifie auprès de l\'administrateur avant de corriger ~/.ssh/known_hosts.' };
  if (has(/Host key verification failed/i)) return { final: true, message: 'Serveur non confirmé : connexion annulée.' };
  if (has(/cannot listen to port|Address already in use|Could not request local forwarding|bind \[?[^\]\s]*\]?:\d+: /i)) return { final: true, message: `Le port ${t.port} est déjà pris sur ce PC (ou réservé par Windows) : choisis-en un autre.` };
  if (has(/remote port forwarding failed/i)) return { final: true, message: `Le serveur refuse d'ouvrir son port ${t.port} : déjà pris, ou redirection interdite (AllowTcpForwarding).` };
  if (has(/Permission denied|Too many authentication failures/i)) return { final: true, message: 'Connexion refusée : mot de passe ou clé incorrects.' };
  if (has(/Could not resolve hostname/i)) return { final: false, message: 'Adresse du serveur inconnue (ou pas de réseau).' };
  if (has(/Connection refused|timed out|No route to host|Network is unreachable|Connection reset|Broken pipe|not responding|Connection closed|Connection to .* closed/i)) return { final: false, message: 'Serveur injoignable ou connexion perdue.' };
  const last = tail.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(Authenticated to|Transferred:|Warning: Permanently added|debug)/.test(l)).pop();
  return { final: false, message: last ? last.slice(0, 200) : `ssh s'est arrêté (code ${code}).` };
}

// Un tunnel qui s'était ouvert puis coupe (réseau, mise en veille) se relance tout seul, de plus en plus espacé.
function onTunnelExit(id, code) {
  const rt = tunnelRt.get(id);
  const t = tunnelById(id);
  if (!rt || !t) return;
  rt.cancelPrompt?.();
  clearTimeout(rt.promptTimer);
  clearTimeout(rt.onTimer);
  rt.onTimer = null;
  if (!rt.wanted) return setTunnel(id, 'off');
  const { final, message } = tunnelError(rt.tail, t, code);
  if (rt.everOn && !final) {
    const delay = [5, 15, 30, 60][Math.min(rt.retries || 0, 3)];
    rt.retries = (rt.retries || 0) + 1;
    setTunnel(id, 'retry', `${message} Nouvel essai dans ${delay} s.`);
    rt.timer = setTimeout(() => rt.wanted && startTunnel(t), delay * 1000);
  } else {
    rt.wanted = false;
    setTunnel(id, 'error', message);
  }
}

function deleteTunnel(t) {
  stopTunnel(t);
  state.tunnels = tunnelList().filter((x) => x.id !== t.id);
  tunnelRt.delete(t.id);
  save();
  applySshUi();
  renderTunnelRows();
  render();
}

function openTunnels(sessionId) {
  const s = sessionId && sessionById(sessionId);
  openModal(`
    <h2>${s ? `Tunnels de « ${esc(s.name)} »` : 'Tunnels SSH'}</h2>
    <p class="hint">Chaque tunnel ouvre sa propre connexion ssh, en arrière-plan. S'il coupe après s'être ouvert (réseau, mise en veille), il se relance tout seul.</p>
    <div class="tunnel-list"></div>
    <div class="modal-actions"><button type="button" id="new">+ Nouveau tunnel</button><span style="flex:1"></span><button type="button" id="cancel" class="primary">Fermer</button></div>`, (modal) => {
    modal.classList.add('wide');
    modal.querySelector('.tunnel-list').dataset.session = sessionId || '';
    modal.querySelector('#cancel').addEventListener('click', closeModal);
    modal.querySelector('#new').addEventListener('click', () => openTunnelForm(null, { sessionId, back: sessionId || '' }));
    renderTunnelRows();
    modal.querySelector('#new').focus();
  });
}

function renderTunnelRows() {
  const list = document.querySelector('.tunnel-list');
  if (!list) return;
  const only = list.dataset.session;
  const items = tunnelList().filter((t) => !only || t.sessionId === only);
  if (!items.length) {
    list.innerHTML = '<small>Aucun tunnel. Un tunnel rend un port du serveur accessible sur ce PC (une base de données, une appli web…), ou l\'inverse.</small>';
    return;
  }
  list.innerHTML = '';
  for (const t of items) {
    const rt = tunnelState(t.id);
    const row = document.createElement('div');
    row.className = `tunnel-row ${rt.status}`;
    row.innerHTML = '<input type="checkbox" class="switch" title="Ouvrir ou fermer le tunnel"><div class="info"><div class="name"></div><div class="sub"></div><div class="status"><span class="dot"></span><span class="text"></span></div></div><button type="button" class="edit">Modifier</button><button type="button" class="icon del" title="Supprimer le tunnel">✕</button>';
    row.querySelector('.name').textContent = tunnelName(t) + (t.auto ? '  · au démarrage' : '');
    row.querySelector('.sub').textContent = tunnelText(t);
    row.querySelector('.status .text').textContent = TUNNEL_STATUS[rt.status] + (rt.message ? ` · ${rt.message}` : '');
    const box = row.querySelector('.switch');
    box.checked = !!rt.wanted;
    box.addEventListener('change', () => (box.checked ? openTunnel(t) : stopTunnel(t)));
    row.querySelector('.edit').addEventListener('click', () => openTunnelForm(t, { back: only }));
    row.querySelector('.del').addEventListener('click', () => confirm(`Supprimer le tunnel « ${tunnelName(t)} » ?`) && deleteTunnel(t));
    list.appendChild(row);
  }
}

function tunnelProblem(v) {
  const port = (p) => /^\d+$/.test(p) && +p >= 1 && +p <= 65535;
  if (!port(v.port)) return 'Le port doit être un nombre entre 1 et 65535.';
  if (v.type !== 'D' && !port(v.hostPort)) return 'Indique le port de destination (entre 1 et 65535).';
  if (v.type !== 'D' && /[\s:]/.test(v.host)) return 'La destination doit être un nom ou une adresse, sans espace ni « : ».';
  return null;
}

function openTunnelForm(t, preset = {}) {
  const servers = state.sessions.filter((s) => s.kind === 'ssh');
  if (!servers.length) {
    openModal(`
      <h2>Nouveau tunnel</h2>
      <p class="hint">Un tunnel passe par une connexion SSH : crée-la d'abord.</p>
      <div class="modal-actions"><button type="button" id="cancel">Annuler</button><button type="button" id="new" class="primary">Nouvelle connexion SSH…</button></div>`, (modal) => {
      modal.querySelector('#cancel').addEventListener('click', closeModal);
      modal.querySelector('#new').addEventListener('click', () => openSshDialog());
    });
    return;
  }
  const v = t ? { ...t } : { name: '', sessionId: preset.sessionId || sessionById(state.activeId)?.ssh && state.activeId || servers[0].id, type: 'L', port: '', host: 'localhost', hostPort: '', auto: false };
  openModal(`
    <h2>${t ? 'Modifier le tunnel' : 'Nouveau tunnel'}</h2>
    <form>
      <label class="field"><span>Connexion SSH</span><select name="sessionId">${servers.map((s) => `<option value="${s.id}" ${s.id === v.sessionId ? 'selected' : ''}>${esc(s.name)} (${esc(sshLabel(s.ssh))})</option>`).join('')}</select></label>
      <div class="field"><span>Sens</span>
        <div class="segmented" id="ttype">
          <button type="button" data-type="L">Ce PC → serveur</button>
          <button type="button" data-type="R">Serveur → ce PC</button>
          <button type="button" data-type="D">Proxy SOCKS</button>
        </div>
      </div>
      <label class="field"><span id="port-label"></span><input name="port" value="${esc(v.port)}" placeholder="ex. 5432" spellcheck="false" inputmode="numeric"></label>
      <div class="field" id="dest"><span id="dest-label"></span>
        <div class="row tunnel-dest"><input name="host" value="${esc(v.host || 'localhost')}" spellcheck="false"><input name="hostPort" value="${esc(v.hostPort)}" placeholder="port" spellcheck="false" inputmode="numeric"></div>
      </div>
      <label class="field"><span>Nom (facultatif)</span><input name="name" value="${esc(v.name)}" placeholder="Automatique" spellcheck="false"></label>
      <label class="check"><input type="checkbox" name="auto" ${v.auto ? 'checked' : ''}> Ouvrir au démarrage de Younesh</label>
      <p class="hint" id="t-preview"></p>
      <p class="hint form-error" id="t-error"></p>
      <div class="modal-actions"><button type="button" id="cancel">Annuler</button><button type="submit" class="primary">${t ? 'Enregistrer' : 'Créer et ouvrir'}</button></div>
    </form>`, (modal) => {
    const form = modal.querySelector('form');
    let type = v.type;
    const read = () => ({ ...v, sessionId: form.sessionId.value, type, port: form.port.value.trim(), host: form.host.value.trim() || 'localhost', hostPort: form.hostPort.value.trim(), name: form.name.value.trim(), auto: form.auto.checked });
    const update = () => {
      modal.querySelectorAll('#ttype button').forEach((b) => b.classList.toggle('on', b.dataset.type === type));
      modal.querySelector('#port-label').textContent = { L: 'Port sur ce PC', R: 'Port sur le serveur', D: 'Port du proxy sur ce PC' }[type];
      modal.querySelector('#dest').hidden = type === 'D';
      modal.querySelector('#dest-label').textContent = type === 'R' ? 'Destination, vue depuis ce PC' : 'Destination, vue depuis le serveur';
      const now = read();
      modal.querySelector('#t-preview').textContent = tunnelProblem(now) ? '' : `${tunnelText(now)}  ·  ssh ${tunnelSpec(now).join(' ')}`;
    };
    modal.querySelectorAll('#ttype button').forEach((b) => b.addEventListener('click', () => {
      type = b.dataset.type;
      update();
    }));
    // Même numéro de port des deux côtés par défaut : c'est le cas le plus courant.
    form.port.addEventListener('input', () => {
      if (!form.hostPort.dataset.edited) form.hostPort.value = form.port.value;
    });
    form.hostPort.addEventListener('input', () => (form.hostPort.dataset.edited = '1'));
    if (v.hostPort && v.hostPort !== v.port) form.hostPort.dataset.edited = '1';
    form.addEventListener('input', update);
    update();
    if (t || preset.sessionId) form.port.focus();
    const back = () => (preset.back !== undefined ? openTunnels(preset.back || undefined) : closeModal());
    modal.querySelector('#cancel').addEventListener('click', back);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = read();
      if (next.type === 'D') Object.assign(next, { host: '', hostPort: '' });
      const problem = tunnelProblem(next);
      if (problem) return (modal.querySelector('#t-error').textContent = problem);
      if (t) {
        const wasOpen = tunnelState(t.id).wanted;
        Object.assign(t, next);
        if (wasOpen) {
          stopTunnel(t);
          openTunnel(t);
        }
      } else {
        const created = { ...next, id: uid() };
        tunnelList().push(created);
        openTunnel(created);
      }
      save();
      applySshUi();
      openTunnels(preset.back || undefined);
    });
  });
}

// Bouton serveur dans la barre latérale et compteur de tunnels en bas : visibles seulement si SSH est activé.
function applySshUi() {
  const on = sshEnabled();
  $('#btn-ssh').hidden = !on;
  const list = tunnelList();
  const btn = $('#btn-tunnels');
  btn.hidden = !on || !list.length;
  const open = list.filter(tunnelOpen).length;
  const trouble = list.some((t) => ['error', 'retry', 'prompt'].includes(tunnelState(t.id).status));
  btn.textContent = `⇄ ${open}`;
  btn.classList.toggle('on', open > 0);
  btn.classList.toggle('warn', trouble);
  btn.title = `Tunnels SSH : ${open} ouvert(s) sur ${list.length}${trouble ? ' · un tunnel a un problème' : ''}`;
}
