// AccountDeck for Windows — accounts and switching.
//
// How switching works:
//  • Claude Code: each account has its own config folder. The active one is set as the user
//    environment variable CLAUDE_CONFIG_DIR (the Main account leaves it unset = %USERPROFILE%\.claude).
//  • Codex: same idea with CODEX_HOME (Main = %USERPROFILE%\.codex).
//  • Claude Desktop: its login lives in its data folder (cookies + config.json). Switching closes
//    Claude, saves those files into the current account's folder, puts the chosen account's back
//    and reopens Claude.
//  • ChatGPT: each account gets its own Chrome/Edge/Brave profile (--user-data-dir), opened on chatgpt.com.
// Nothing is ever sent anywhere; passwords and tokens are never shown or copied out of their files.
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const P = require('./paths');
const U = require('./util');
const W = require('./win');

const SERVICES = ['desktop', 'claude', 'codex', 'chatgpt'];
const SERVICE_INFO = {
  desktop: { title: 'Claude Desktop', where: 'App', hue: '#D97857', envVar: null },
  claude: { title: 'Claude Code', where: 'Terminal', hue: '#9E6B52', envVar: 'CLAUDE_CONFIG_DIR' },
  codex: { title: 'Codex', where: 'Terminal', hue: '#2E7AF5', envVar: 'CODEX_HOME' },
  chatgpt: { title: 'ChatGPT', where: 'Browser', hue: '#10A37F', envVar: null },
};

// Claude Desktop keeps its login in its cookie database and in config.json
// ("oauth:tokenCacheV2", "lastKnownAccountUuid"). Current Electron/Chromium versions keep the
// cookie database at Network\Cookies; older ones at the top level. Both are handled.
// "Local State" (which holds the key that unlocks those files on this Windows account) is left
// in place, so every saved login keeps working on this PC.
/** Account names are one line of plain text, at most 60 characters. */
const cleanName = n => String(n || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 60);
const DESKTOP_FILES = ['Cookies', 'Cookies-journal', path.join('Network', 'Cookies'), path.join('Network', 'Cookies-journal'), 'config.json'];
const COOKIE_FILES = ['Cookies', path.join('Network', 'Cookies')];

const DEFAULT_SETTINGS = {
  order: SERVICES.slice(),
  hidden: [],
  limit: 'auto',          // "auto", "5h" or "weekly"
  carryChat: false,       // bring the last Code-tab chat along on a Claude Desktop switch (off unless chosen)
  usageOnRows: true,
};

class AppModel extends EventEmitter {
  constructor() {
    super();
    this.accounts = [];
    this.active = {};
    this.details = {};
    this.signedIn = {};
    this.switching = false;
    this.settings = { ...DEFAULT_SETTINGS };
    U.mkdirp(P.root);
    this.load();
    this.ensureDefaults();
    this.repairDesktopState();
    this.save();
    this.refresh();
  }

  get statePath() { return path.join(P.root, 'state.json'); }
  get settingsPath() { return path.join(P.root, 'settings.json'); }

  // ---- persistence ----
  load() {
    const s = U.readJSON(this.statePath);
    if (s) {
      this.accounts = Array.isArray(s.accounts) ? s.accounts.filter(a => a && SERVICES.includes(a.service)) : [];
      this.active = s.active && typeof s.active === 'object' ? s.active : {};
    }
    const st = U.readJSON(this.settingsPath);
    if (st) this.settings = { ...DEFAULT_SETTINGS, ...st };
    this.settings.order = this.order();
  }
  save() {
    U.writeJSON({ accounts: this.accounts, active: this.active }, this.statePath);
  }
  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.settings.order = this.order();
    U.writeJSON(this.settings, this.settingsPath);
    this.changed();
  }
  order() {
    const out = (this.settings.order || []).filter(s => SERVICES.includes(s));
    for (const s of SERVICES) if (!out.includes(s)) out.push(s);
    return [...new Set(out)];
  }

  /** The accounts you already use become the "Main" account of each tool. */
  ensureDefaults() {
    const has = s => this.accounts.some(a => a.service === s && a.isDefault);
    if (!has('desktop')) this.accounts.unshift({ id: 'desktop-default', service: 'desktop', name: 'Main', isDefault: true, dir: path.join(P.root, 'desktop', 'desktop-default') });
    if (!has('claude')) this.accounts.splice(1, 0, { id: 'claude-default', service: 'claude', name: 'Main', isDefault: true, dir: P.claudeHome });
    if (!has('codex')) this.accounts.push({ id: 'codex-default', service: 'codex', name: 'Main', isDefault: true, dir: P.codexHome });
    for (const s of ['desktop', 'claude', 'codex']) {
      if (!this.active[s] || !this.accounts.some(a => a.id === this.active[s])) {
        const d = this.accounts.find(a => a.service === s && a.isDefault); if (d) this.active[s] = d.id;
      }
    }
  }

  accountsFor(s) { return this.accounts.filter(a => a.service === s); }
  byId(id) { return this.accounts.find(a => a.id === id); }
  isActive(a) { return this.active[a.service] === a.id; }
  activeName(s) { return (this.byId(this.active[s]) || {}).name || 'Main'; }

  /** Config folder of a Claude Code / Codex account. */
  configDir(a) { return a.isDefault ? (a.service === 'codex' ? P.codexHome : a.service === 'claude' ? P.claudeHome : a.dir) : a.dir; }
  /** Claude Code's state file (.claude.json): next to the profile for Main, inside the folder otherwise. */
  claudeState(a) { return a.isDefault ? path.join(P.home, '.claude.json') : path.join(a.dir, '.claude.json'); }

  changed() { this.emit('changed'); }
  flash(text) { this.emit('toast', text); }

  // ---- status (read locally) ----
  refresh() {
    const sup = P.desktopSupport();
    for (const a of this.accounts) {
      if (a.service === 'claude') {
        const email = ((U.readJSON(this.claudeState(a)) || {}).oauthAccount || {}).emailAddress;
        this.details[a.id] = email || 'Not signed in'; this.signedIn[a.id] = !!email;
      } else if (a.service === 'codex') {
        const j = U.readJSON(path.join(this.configDir(a), 'auth.json')) || {};
        const email = j.tokens && j.tokens.id_token ? U.jwtEmail(j.tokens.id_token) : null;
        if (email) { this.details[a.id] = email; this.signedIn[a.id] = true; }
        else if (typeof j.OPENAI_API_KEY === 'string' && j.OPENAI_API_KEY) { this.details[a.id] = 'API key'; this.signedIn[a.id] = true; }
        else { this.details[a.id] = 'Not signed in'; this.signedIn[a.id] = false; }
      } else if (a.service === 'desktop') {
        if (this.isActive(a)) {
          const on = COOKIE_FILES.some(f => U.exists(path.join(sup, f)));
          this.details[a.id] = on ? 'Open in Claude now' : 'Not signed in'; this.signedIn[a.id] = on;
        } else {
          const saved = this.desktopSlotHasLogin(a);
          this.details[a.id] = saved ? 'Saved login' : 'Sign in after switching'; this.signedIn[a.id] = saved;
        }
      } else if (a.service === 'chatgpt') {
        const used = U.exists(path.join(a.dir, 'Default'));
        this.details[a.id] = used ? 'Own browser window' : 'Not opened yet'; this.signedIn[a.id] = used;
      }
    }
    this.changed();
  }

  // ---- environment variables for Claude Code / Codex ----
  async applyEnv(service) {
    const v = SERVICE_INFO[service].envVar; if (!v) return;
    const a = this.byId(this.active[service]);
    const r = await W.setUserEnv(v, a && !a.isDefault ? a.dir : null);
    if (!r.ok) this.flash(`Could not set ${v}: ${r.err || 'unknown error'}`);
  }
  /** On start, make sure the Windows user variables match what AccountDeck shows. */
  async syncEnv() {
    for (const s of ['claude', 'codex']) {
      const v = SERVICE_INFO[s].envVar, a = this.byId(this.active[s]);
      const want = a && !a.isDefault ? a.dir : null;
      const have = await W.getUserEnv(v);
      if ((have || null) !== want) await this.applyEnv(s);
      else if (want == null) delete process.env[v]; else process.env[v] = want;
    }
  }

  // ---- actions ----
  async select(a, { confirmed = false } = {}) {
    if (a.service === 'desktop') return this.switchDesktop(a, { confirmed });
    if (a.service === 'chatgpt') {
      this.active.chatgpt = a.id; this.save();
      this.openBrowser(a);
      return;
    }
    if (this.isActive(a)) return;
    this.active[a.service] = a.id; this.save(); this.changed();
    await this.applyEnv(a.service);
    this.flash(`${SERVICE_INFO[a.service].title} → ${a.name}. New terminal windows use it.`);
  }

  add(service, name) {
    const clean = cleanName(name);
    if (!clean || !SERVICES.includes(service)) return null;
    let slug = clean.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '-').replace(/^-+|-+$/g, '') || 'account';
    slug = slug.normalize('NFKD').replace(/[^\x20-\x7e]/g, '') || 'account';   // folder names stay plain ASCII
    let id = `${service}-${slug}`, n = 2;
    while (this.accounts.some(a => a.id === id)) id = `${service}-${slug}-${n++}`;
    const dir = path.join(P.root, service, id);
    U.mkdirp(dir);
    const acc = { id, service, name: clean, isDefault: false, dir };
    this.accounts.push(acc);
    this.save(); this.refresh();
    if (service === 'desktop') this.switchDesktop(acc, { confirmed: true }); else this.signIn(acc);
    return acc;
  }

  signIn(a) {
    const title = `${SERVICE_INFO[a.service].title} - ${a.name}`;
    const nm = W.echoSafe(a.name);
    if (a.service === 'desktop') return this.switchDesktop(a);
    if (a.service === 'chatgpt') return this.openBrowser(a);
    if (a.service === 'claude') {
      W.openTerminal({ title, env: { CLAUDE_CONFIG_DIR: a.isDefault ? null : a.dir }, commands: [
        `echo Signing in to Claude Code as "${nm}". Finish the login, then type /exit.`,
        'echo.',
        'where claude >nul 2>nul || (echo Claude Code is not installed. See https://docs.claude.com/claude-code & goto :eof)',
        'claude /login',
      ] });
    } else if (a.service === 'codex') {
      W.openTerminal({ title, env: { CODEX_HOME: a.isDefault ? null : a.dir }, commands: [
        `echo Signing in to Codex as "${nm}".`,
        'echo.',
        'where codex >nul 2>nul || (echo Codex CLI is not installed. Install it with: npm i -g @openai/codex & goto :eof)',
        'codex login',
      ] });
    }
  }

  rename(id, name) {
    const v = cleanName(name); const a = this.byId(id);
    if (!v || !a) return; a.name = v; this.save(); this.changed();
  }

  /** Moves the account's folder to the Recycle Bin (via the trash function passed in by the app). */
  async remove(id, trash) {
    const a = this.byId(id); if (!a || a.isDefault) return false;
    if (a.service === 'desktop' && this.isActive(a)) { this.flash('Switch Claude to another account first'); return false; }
    try { if (U.exists(a.dir)) await trash(a.dir); } catch (e) { this.flash(`Could not move the folder to the Recycle Bin: ${e.message}`); return false; }
    this.accounts = this.accounts.filter(x => x.id !== id);
    if (this.active[a.service] === id) {
      const d = this.accounts.find(x => x.service === a.service && x.isDefault);
      if (d) this.active[a.service] = d.id; else delete this.active[a.service];
      await this.applyEnv(a.service);
    }
    this.save(); this.changed();
    this.flash(`Removed ${a.name}`);
    return true;
  }

  openTerminal() {
    W.openTerminal({ title: 'AccountDeck', env: {
      CLAUDE_CONFIG_DIR: (a => a && !a.isDefault ? a.dir : null)(this.byId(this.active.claude)),
      CODEX_HOME: (a => a && !a.isDefault ? a.dir : null)(this.byId(this.active.codex)),
    }, commands: [`echo Claude Code: ${W.echoSafe(this.activeName('claude'))}   -   Codex: ${W.echoSafe(this.activeName('codex'))}`] });
  }

  openBrowser(a) {
    const b = W.openChatGPT(a.dir);
    if (!b) { this.flash('Install Chrome, Edge or Brave to use separate ChatGPT accounts'); return; }
    this.flash(`Opening ChatGPT as ${a.name} in ${b}`);
    setTimeout(() => this.refresh(), 5000);
  }

  // ---- Claude Desktop ----
  desktopSlotHasLogin(a) { return COOKIE_FILES.some(f => U.exists(path.join(a.dir, f))); }

  /** Returns a description for the confirm dialog, or performs the switch when confirmed. */
  desktopConfirmText(a) {
    return this.desktopSlotHasLogin(a)
      ? `Claude restarts signed in as ${a.name}. Anything running in Claude stops.`
      : `Claude restarts and asks you to sign in. Use your ${a.name} account. Anything running in Claude stops.`;
  }

  async switchDesktop(a, { confirmed = false } = {}) {
    if (this.switching) return;
    if (this.isActive(a)) {
      if (!this.signedIn[a.id]) await W.launchDesktop();
      return;
    }
    if (!confirmed) { this.emit('confirm', { kind: 'desktop', id: a.id, title: `Switch Claude to "${a.name}"?`, message: this.desktopConfirmText(a), button: 'Restart Claude' }); return; }

    // Check before closing anything: if Claude's login files can't be found, leave Claude alone.
    if (!this.desktopHasLoginFiles(P.desktopSupport())) {
      this.flash(`Claude's login files were not found in ${P.short(P.desktopSupport())}. Nothing was changed.`);
      return;
    }
    const current = this.byId(this.active.desktop);
    this.switching = true; this.changed();
    this.flash('Closing Claude…');
    let carried = null;
    try {
      const lastExe = await W.desktopExePath();
      if (!(await W.quitDesktop())) { this.flash("Claude didn't close. Quit it from its tray icon, then try again."); return; }
      const sup = P.desktopSupport();
      const fromUuid = (U.readJSON(path.join(sup, 'config.json')) || {}).lastKnownAccountUuid;
      try {
        this.swapDesktopFiles(current, a, sup);
        this.active.desktop = a.id; this.save();
        if (this.settings.carryChat) {
          carried = this.carryLastChat(fromUuid, (U.readJSON(path.join(sup, 'config.json')) || {}).lastKnownAccountUuid, sup);
        }
      } catch (e) {
        this.flash(`Switch failed: ${e.message}`);
      }
      this.refresh();
      const opened = await W.launchDesktop(lastExe);
      if (!opened) this.flash('Claude Desktop was not found. Open it from the Start menu.');
      else if (carried) this.flash(`Claude → ${a.name}, with "${carried}"`);
      else this.flash(this.desktopSlotHasLogin(a) || this.signedIn[a.id] ? `Claude → ${a.name}` : `Sign in to Claude as ${a.name}`);
    } finally {
      this.switching = false; this.changed();
    }
  }

  /** True when a folder holds Claude Desktop login files (cookies or its config.json). */
  desktopHasLoginFiles(dir) { return DESKTOP_FILES.some(f => U.exists(path.join(dir, f))); }

  /**
   * The login files to move: the main ones plus the cookie files of every extra browser
   * partition Claude uses (Partitions\<name>), found in any of the given folders. Without those,
   * a part of Claude could stay signed in to the previous account.
   */
  desktopFileList(...dirs) {
    const out = new Set(DESKTOP_FILES);
    for (const d of dirs) for (const part of U.ls(path.join(d, 'Partitions'))) {
      for (const f of ['Cookies', 'Cookies-journal', path.join('Network', 'Cookies'), path.join('Network', 'Cookies-journal')]) {
        const rel = path.join('Partitions', part, f);
        if (U.exists(path.join(d, rel))) out.add(rel);
      }
    }
    return [...out];
  }

  /**
   * An earlier version could "switch" against a folder Claude no longer uses: nothing was moved,
   * but the new account was marked active. That leaves an empty safety copy behind. Undo it, so
   * the login that is really in Claude is treated as the Main account again.
   */
  repairDesktopState(base = P.root) {
    const backup = path.join(base, 'desktop', '_original-backup');
    if (!U.exists(backup) || this.desktopHasLoginFiles(backup)) return false;
    if (this.accounts.some(a => a.service === 'desktop' && this.desktopHasLoginFiles(a.dir))) return false;
    fs.rmSync(backup, { recursive: true, force: true });
    const main = this.accounts.find(a => a.service === 'desktop' && a.isDefault);
    if (main) this.active.desktop = main.id;
    return true;
  }

  swapDesktopFiles(current, target, sup = P.desktopSupport(), base = P.root) {
    const copy = (from, to) => { U.mkdirp(path.dirname(to)); fs.copyFileSync(from, to); };
    const rm = p => { try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
    // Never act on a folder that isn't Claude's: without its files nothing here is a login.
    if (!this.desktopHasLoginFiles(sup)) throw new Error(`Claude's login files were not found in ${P.short(sup)}. Nothing was changed.`);
    // One-time safety copy of the login you had before AccountDeck ever switched.
    const backup = path.join(base, 'desktop', '_original-backup');
    if (!this.desktopHasLoginFiles(backup)) {
      U.mkdirp(backup);
      for (const f of this.desktopFileList(sup)) if (U.exists(path.join(sup, f))) copy(path.join(sup, f), path.join(backup, f));
    }
    // Save the login that is in Claude right now.
    if (current) {
      U.mkdirp(current.dir);
      for (const f of this.desktopFileList(sup, current.dir)) {
        rm(path.join(current.dir, f));
        if (U.exists(path.join(sup, f))) copy(path.join(sup, f), path.join(current.dir, f));
      }
    }
    // Put the chosen account's login in place.
    if (this.desktopSlotHasLogin(target)) {
      for (const f of this.desktopFileList(sup, target.dir)) {
        rm(path.join(sup, f));
        if (U.exists(path.join(target.dir, f))) copy(path.join(target.dir, f), path.join(sup, f));
      }
    } else {
      // New account: sign out but keep the app's settings.
      for (const f of this.desktopFileList(sup)) if (f !== 'config.json') rm(path.join(sup, f));
      const cfgPath = path.join(sup, 'config.json');
      const cfg = U.readJSON(cfgPath);
      if (cfg) {
        delete cfg['oauth:tokenCacheV2'];
        delete cfg.lastKnownAccountUuid;
        U.writeJSON(cfg, cfgPath, { sort: false });
      }
    }
  }

  /**
   * Moves your most recently opened Code-tab chat into the new account's chat list, so it comes
   * up there and you can carry on. Claude keeps these per account in
   * claude-code-sessions\<account>\<organization>\local_*.json. A copy is kept in
   * %USERPROFILE%\.accountdeck\moved-chats. Returns the chat's title, or null.
   */
  carryLastChat(from, to, sup = P.desktopSupport(), base = P.root) {
    if (!from || !to || from === to) return null;
    const sessions = path.join(sup, 'claude-code-sessions');
    const chats = acc => {
      const out = [];
      for (const org of U.ls(path.join(sessions, acc))) {
        const dir = path.join(sessions, acc, org);
        for (const f of U.ls(dir)) if (f.startsWith('local_') && f.endsWith('.json')) {
          const j = U.readJSON(path.join(dir, f)); if (j) out.push({ path: path.join(dir, f), json: j });
        }
      }
      return out;
    };
    const last = chats(from).filter(c => c.json.isArchived !== true)
      .sort((x, y) => (Number(y.json.lastFocusedAt) || 0) - (Number(x.json.lastFocusedAt) || 0))[0];
    if (!last) return null;
    const toDir = path.join(sessions, to);
    const newest = org => Math.max(0, ...U.ls(path.join(toDir, org)).filter(f => f.startsWith('local_')).map(f => U.mtime(path.join(toDir, org, f))));
    const orgs = U.ls(toDir).filter(o => U.isDir(path.join(toDir, o))).sort((x, y) => newest(y) - newest(x));
    if (!orgs.length) return null;
    const name = path.basename(last.path);
    const dest = path.join(toDir, orgs[0], name);
    if (U.exists(dest)) return null;
    const keep = path.join(base, 'moved-chats');
    U.mkdirp(keep);
    try { fs.copyFileSync(last.path, path.join(keep, name)); } catch {}
    const json = { ...last.json, lastFocusedAt: Date.now() };
    try { fs.writeFileSync(dest, JSON.stringify(json), 'utf8'); } catch { return null; }
    try { fs.unlinkSync(last.path); } catch {}
    return json.title || 'your last chat';
  }

  /** The Claude account id behind a Claude Desktop slot (null until it has signed in once). */
  desktopUuid(a) {
    const cfg = this.isActive(a) ? path.join(P.desktopSupport(), 'config.json') : path.join(a.dir, 'config.json');
    return (U.readJSON(cfg) || {}).lastKnownAccountUuid || null;
  }

  snapshot() {
    return {
      services: SERVICES, info: SERVICE_INFO,
      accounts: this.accounts.map(a => ({ ...a, active: this.isActive(a), detail: this.details[a.id] || '', signedIn: !!this.signedIn[a.id],
        shortDir: P.short(this.configDir(a)) })),
      settings: this.settings, switching: this.switching,
      desktopFolder: P.short(P.desktopSupport()), desktopKind: P.desktopInstallKind(),
    };
  }
}

module.exports = { AppModel, SERVICES, SERVICE_INFO, DESKTOP_FILES };
