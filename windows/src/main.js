// AccountDeck for Windows — tray app + Dashboard window.
'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog, Notification } = require('electron');
const path = require('path');
const { AppModel, SERVICE_INFO } = require('./core/model');
const { UsageStore, viewUsage, badgeText, tooltip } = require('./core/usage');
const D = require('./core/data');
const W = require('./core/win');

const CREDIT_URL = 'https://x.com/Nadim_404';
const ASSETS = path.join(__dirname, '..', 'assets');

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('com.nadimsheikh.accountdeck');

let model, usage, tray, win, quitting = false;

// ------------------------------------------------------------------ window
function showWindow(page) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    if (page) win.webContents.send('navigate', page);
    return;
  }
  win = new BrowserWindow({
    width: 1120, height: 760, minWidth: 760, minHeight: 520,
    title: 'AccountDeck', icon: path.join(ASSETS, 'app-icon.png'),
    backgroundColor: '#f6f5f2', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'), page ? { hash: page } : undefined);
  win.once('ready-to-show', () => win.show());
  // Development only: ACCOUNTDECK_SHOT=<file.png> saves a screenshot of each page and quits.
  if (process.env.ACCOUNTDECK_SHOT) win.webContents.on('console-message', (_e, lvl, msg, line, src) => console.log('[page]', msg, src + ':' + line));
  if (process.env.ACCOUNTDECK_SHOT) win.webContents.once('did-finish-load', () => shootPages(process.env.ACCOUNTDECK_SHOT));
  // External links (the credit) open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  // Closing the window keeps AccountDeck in the tray.
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
}
async function shootPages(base) {
  const pages = (process.env.ACCOUNTDECK_SHOT_PAGES || 'home').split(',');
  for (const p of pages) {
    await win.webContents.executeJavaScript(`location.hash=${JSON.stringify(p)}; location.reload(); 0`);
    await new Promise(r => setTimeout(r, 1800));
    if (process.env.ACCOUNTDECK_DEBUG) console.log('[dom]', p, await win.webContents.executeJavaScript(`JSON.stringify({len: document.querySelector('#main').innerHTML.length, op: getComputedStyle(document.querySelector('.page')||document.body).opacity, anim: (document.querySelector('.page')||{}).getAnimations ? document.querySelector('.page').getAnimations().map(a=>a.playState+':'+a.currentTime) : null, vis: document.visibilityState})`));
    const img = await win.webContents.capturePage();
    require('fs').writeFileSync(base.replace(/\.png$/, `-${p.replace(/[^a-z0-9]+/gi, '_')}.png`), img.toPNG());
  }
  quitting = true; app.quit();
}
function push() {
  if (process.env.ACCOUNTDECK_DEBUG) console.log('[push]', JSON.stringify(Object.fromEntries(Object.entries(usage.usage).map(([k, v]) => [k, Math.round(v.percent)]))));
  if (win && !win.isDestroyed()) win.webContents.send('state', state());
}
function state() {
  const snap = model.snapshot();
  const u = {};
  for (const [id, x] of Object.entries(usage.usage)) {
    const v = viewUsage(x, model.settings.limit);
    u[id] = { ...v, badge: badgeText(v), tip: tooltip(v) };
  }
  return { ...snap, usage: u, claudeTracking: usage.claudeTracking, launchAtLogin: app.getLoginItemSettings().openAtLogin, version: app.getVersion() };
}

// ------------------------------------------------------------------ tray
function trayImage() {
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray-16.png'));
  for (const [s, f] of [[1.25, 'tray-20.png'], [1.5, 'tray-24.png'], [2, 'tray-32.png'], [2.5, 'tray-40.png'], [3, 'tray-48.png']]) {
    img.addRepresentation({ scaleFactor: s, buffer: nativeImage.createFromPath(path.join(ASSETS, f)).toPNG() });
  }
  return img;
}

function buildMenu() {
  usage.refresh();
  const items = [{ label: 'Open Dashboard', click: () => showWindow(), }, { type: 'separator' }];
  const hidden = new Set(model.settings.hidden || []);
  const order = model.order().filter(s => !hidden.has(s));
  if (!order.length) items.push({ label: 'All apps are hidden (Customize to show them)', enabled: false });
  for (const s of order) {
    const info = SERVICE_INFO[s];
    items.push({ label: `${info.title}  ·  ${info.where}`, enabled: false });
    const list = model.accountsFor(s);
    for (const a of list) {
      const u = viewUsage(usage.usage[a.id], model.settings.limit);
      const badge = model.settings.usageOnRows !== false && u ? `   ${badgeText(u)}` : '';
      const detail = model.details[a.id] && model.details[a.id] !== 'Not signed in' ? '' : '  (not signed in)';
      items.push({
        label: `${a.name}${detail}${badge}`,
        type: 'checkbox',
        checked: model.isActive(a),
        enabled: !(s === 'desktop' && model.switching),
        toolTip: u ? tooltip(u) : (model.details[a.id] || ''),
        click: () => { onSelect(a); },
      });
    }
    items.push({ label: `Add ${info.title} Account…`, click: () => showWindow(`add:${s}`) });
    items.push({ type: 'separator' });
  }
  items.push({
    label: 'Customize', submenu: [
      ...model.order().map(s => ({ label: `Show ${SERVICE_INFO[s].title}`, type: 'checkbox', checked: !hidden.has(s),
        click: m => { const h = new Set(model.settings.hidden || []); if (m.checked) h.delete(s); else h.add(s); model.saveSettings({ hidden: [...h] }); } })),
      { type: 'separator' },
      { label: 'Limit to show', enabled: false },
      ...[['auto', 'Auto'], ['5h', '5-hour'], ['weekly', 'Weekly']].map(([v, l]) => ({ label: `   ${l}`, type: 'radio', checked: model.settings.limit === v, click: () => model.saveSettings({ limit: v }) })),
      { type: 'separator' },
      { label: 'Show usage on rows', type: 'checkbox', checked: model.settings.usageOnRows !== false, click: m => model.saveSettings({ usageOnRows: m.checked }) },
      { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: m => setLaunchAtLogin(m.checked) },
      { type: 'separator' },
      { label: 'Change order…', click: () => showWindow('settings') },
    ],
  });
  items.push({ label: 'New Terminal', click: () => model.openTerminal() });
  items.push({ type: 'separator' });
  items.push({ label: 'Made by Nadim Sheikh', click: () => shell.openExternal(CREDIT_URL) });
  items.push({ label: 'Quit AccountDeck', click: () => { quitting = true; app.quit(); } });
  return Menu.buildFromTemplate(items);
}
function refreshTray() {
  if (!tray) return;
  const parts = ['desktop', 'claude', 'codex'].map(s => `${SERVICE_INFO[s].title}: ${model.activeName(s)}`);
  tray.setToolTip(`AccountDeck\n${parts.join('\n')}`.slice(0, 127));
}

async function onSelect(a) {
  if (a.service === 'desktop' && !model.isActive(a)) {
    // Ask first: switching restarts Claude.
    const r = await dialog.showMessageBox(win && win.isVisible() ? win : null, {
      type: 'question', buttons: ['Restart Claude', 'Cancel'], defaultId: 0, cancelId: 1,
      title: 'AccountDeck', message: `Switch Claude to "${a.name}"?`, detail: model.desktopConfirmText(a), noLink: true,
    });
    if (r.response !== 0) { refreshTray(); return; }
    return model.select(a, { confirmed: true });
  }
  return model.select(a);
}

function setLaunchAtLogin(on) {
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  push(); refreshTray();
}

function notify(text) {
  if (win && !win.isDestroyed() && win.isVisible()) { win.webContents.send('toast', text); return; }
  if (Notification.isSupported()) new Notification({ title: 'AccountDeck', body: text, silent: true, icon: path.join(ASSETS, 'app-icon.png') }).show();
}

// ------------------------------------------------------------------ live usage
// Usage changes when Claude Code's status line hook or Codex writes a file. Those folders are
// watched, so the menu and Dashboard update within about a second instead of on a timer.
let watchers = [], watchTimer = null, watchKey = '';
// Claude and Codex write to these folders many times a second while they are open. A file event
// only re-reads usage (at most once every 5 seconds), and the Dashboard is only told when a
// number actually changed, so it never redraws for nothing.
let lastUsageRead = 0, lastUsageSig = '';
function usageSig() {
  const o = {};
  for (const [id, x] of Object.entries(usage.usage)) {
    o[id] = [Math.round(x.percent * 10), x.resetsAt || 0, x.window, x.second ? Math.round(x.second.percent * 10) : -1, x.second ? x.second.resetsAt || 0 : 0, !!x.estimated];
  }
  return JSON.stringify([o, usage.claudeTracking]);
}
/** Re-reads usage; pushes to the Dashboard and tray only when it changed. Returns whether it did. */
function refreshUsage() {
  lastUsageRead = Date.now();
  if (!usage.refresh(true)) return false;
  const sig = usageSig();
  if (sig === lastUsageSig) return false;
  lastUsageSig = sig; push(); refreshTray();
  return true;
}
function onUsageFile() {
  if (watchTimer) return;                                            // one read is already queued
  const wait = Math.max(700, 5000 - (Date.now() - lastUsageRead));
  watchTimer = setTimeout(() => { watchTimer = null; refreshUsage(); }, wait);
}
function watchUsage() {
  const fs = require('fs'), P = require('./core/paths');
  const targets = [];
  for (const a of model.accounts) {
    if (a.service === 'claude') targets.push([path.join(usage.claudeDir(a), '.accountdeck-status'), false], [usage.claudeDir(a), false]);
    if (a.service === 'codex') targets.push([path.join(usage.codexDir(a), 'sessions'), true]);
  }
  targets.push([P.desktopSupport(), false]);
  const live = targets.filter(([d]) => fs.existsSync(d));          // folders appear once an app is used; re-checked every 15 s
  const key = JSON.stringify(live);
  if (key === watchKey) return;
  watchKey = key;
  for (const w of watchers) try { w.close(); } catch {}
  watchers = [];
  for (const [dir, recursive] of live) {
    try {
      const w = fs.watch(dir, { recursive, persistent: false }, (_ev, file) => {
        const f = String(file || '');
        if (!f || f.endsWith('.json') || f.endsWith('.jsonl')) { if (process.env.ACCOUNTDECK_DEBUG) console.log('[watch]', dir, f); onUsageFile(); }
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch { /* folder not there yet; the 15-second check below still covers it */ }
  }
}

// ------------------------------------------------------------------ IPC
function account(id) { const a = model.byId(id); if (!a) throw new Error('Unknown account'); return a; }
function handle(name, fn) { ipcMain.handle(name, async (_e, ...args) => { try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message }; } }); }

function setupIPC() {
  handle('state', () => { usage.refresh(); return state(); });
  handle('refresh', () => { model.refresh(); usage.refresh(true); push(); refreshTray(); return state(); });
  handle('select', async (id, confirmed) => { await model.select(account(id), { confirmed: !!confirmed }); return state(); });
  handle('desktopConfirmText', id => model.desktopConfirmText(account(id)));
  handle('add', (service, name) => { const a = model.add(service, name); return a && a.id; });
  handle('signIn', id => model.signIn(account(id)));
  handle('rename', (id, name) => model.rename(id, name));
  handle('remove', id => model.remove(id, p => shell.trashItem(p)));
  handle('reveal', id => { const a = account(id); shell.openPath(model.configDir(a)); });
  handle('openTerminal', () => model.openTerminal());
  handle('saveSettings', patch => {
    const allowed = {}; for (const k of ['order', 'hidden', 'limit', 'carryChat', 'usageOnRows']) if (k in patch) allowed[k] = patch[k];
    model.saveSettings(allowed); return state();
  });
  handle('setLaunchAtLogin', on => setLaunchAtLogin(!!on));
  handle('enableTracking', () => { const skipped = usage.enableClaudeTracking(); push(); refreshTray(); return skipped; });
  handle('stats', () => D.stats(model));
  handle('environment', id => D.environment(account(id), model));
  handle('chats', id => {
    const a = account(id);
    if (a.service === 'claude') return D.group(D.codeChats(require('path').join(model.configDir(a), 'projects')));
    if (a.service === 'desktop') { const u = model.desktopUuid(a); return u ? D.group(D.desktopChats(u)) : []; }
    return [];
  });
  handle('copyChats', (fromId, ids, toId) => {
    const from = account(fromId), to = account(toId);
    if (from.service === 'claude' && to.service === 'claude') {
      return D.copyCode(ids, path.join(model.configDir(from), 'projects'), path.join(model.configDir(to), 'projects'));
    }
    if (from.service === 'desktop' && to.service === 'desktop') {
      const u = model.desktopUuid(to); if (!u) throw new Error(`${to.name} has not signed in to Claude Desktop yet`);
      const r = D.copyDesktop(ids, u); if (!r) throw new Error(`${to.name} has no chat list yet. Open a Code chat in that account once.`);
      return r;
    }
    throw new Error('Chats can only be copied between accounts of the same app');
  });
  handle('resumeChat', (accountId, sid, cwd) => {
    const a = account(accountId);
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) throw new Error('Not a chat id');
    W.openTerminal({ title: `Claude Code - ${a.name}`, env: { CLAUDE_CONFIG_DIR: a.isDefault ? null : a.dir }, cwd, commands: [`claude --resume ${sid}`] });
  });
  handle('mcp', id => { const a = account(id); return D.mcpEntries(a.service === 'claude' ? model.claudeState(a) : null, a.service === 'claude'); });
  handle('mcpSend', (fromId, ids, toId) => {
    const from = account(fromId), to = account(toId);
    if (to.service !== 'claude') throw new Error('Connections can be sent to Claude Code accounts');
    return D.mcpSend(from.service === 'claude' ? model.claudeState(from) : null, ids, model.claudeState(to));
  });
  handle('envCopy', (fromId, parts, toId) => {
    const from = account(fromId), to = account(toId);
    if (from.service !== 'claude' || to.service !== 'claude') throw new Error('Setup can be sent between Claude Code accounts');
    return D.envCopy(parts.filter(p => D.PARTS.includes(p)), model.configDir(from), model.configDir(to), model.claudeState(from), model.claudeState(to));
  });
  handle('openCredit', () => shell.openExternal(CREDIT_URL));
}

// ------------------------------------------------------------------ start
app.whenReady().then(async () => {
  model = new AppModel();
  usage = new UsageStore(model);
  usage.refresh(true); lastUsageSig = usageSig(); lastUsageRead = Date.now();
  W.cleanRunScripts();
  model.on('changed', () => { push(); refreshTray(); watchUsage(); });
  model.on('toast', notify);
  model.on('confirm', c => { const a = model.byId(c.id); if (a) onSelect(a); });
  setupIPC();

  tray = new Tray(trayImage());
  refreshTray();
  // Both clicks open the menu, rebuilt each time so usage and countdowns are current.
  tray.on('click', () => tray.popUpContextMenu(buildMenu()));
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  tray.on('double-click', () => showWindow());

  model.syncEnv().catch(() => {});
  watchUsage();
  // Backup check (and countdowns): every 15 s while the Dashboard is open, every minute otherwise.
  let tick = 0;
  setInterval(() => {
    tick++;
    watchUsage();
    const visible = win && !win.isDestroyed() && win.isVisible();
    if (visible || tick % 4 === 0) refreshUsage();
    // Countdown texts ("resets in 2h 14m") move on once a minute even when no number changed.
    if (visible && tick % 4 === 0) push();
  }, 15000);
  setInterval(() => model.refresh(), 5 * 60000);

  // The Dashboard opens first, except when Windows starts AccountDeck at sign-in.
  if (!process.argv.includes('--hidden')) showWindow();
});
app.on('second-instance', () => showWindow());
app.on('window-all-closed', e => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; });
