// AccountDeck Dashboard (renderer). Talks to the app only through window.deck (see preload.js).
'use strict';
let S = null;                 // app state from the main process
let page = 'home';            // home | account:<id> | mcp | settings
let tab = 'overview';
const cache = { env: {}, chats: {}, stats: null, mcp: {} };
const picked = new Set();     // chat ids or MCP ids or env parts, per page

// ------------------------------------------------------------------ helpers
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Safe { constructor(s) { this.__html = s; } toString() { return this.__html; } }
const raw = s => (s instanceof Safe ? s : new Safe(String(s ?? '')));
const piece = v => (v instanceof Safe ? v.__html : Array.isArray(v) ? v.map(piece).join('') : v === false || v == null ? '' : esc(v));
/** HTML template: values are escaped unless they are themselves templates (Safe). */
const h = (strings, ...vals) => new Safe(strings.reduce((o, s, i) => o + s + (i < vals.length ? piece(vals[i]) : ''), ''));
const fmtNum = n => (n == null ? '–' : Number(n).toLocaleString());
const ago = ms => { const s = (Date.now() - ms) / 1000; if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`; return new Date(ms).toLocaleDateString(); };
const kb = n => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const short = s => (s <= 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`);
const level = p => (p >= 85 ? 'hi' : p >= 60 ? 'mid' : '');
const info = s => S.info[s];
const acc = id => S.accounts.find(a => a.id === id);
const accountsFor = s => S.accounts.filter(a => a.service === s);
const visibleServices = () => S.settings.order.filter(s => accountsFor(s).length);

const ICONS = {
  desktop: '<rect x="2" y="3" width="12" height="9" rx="1.5"/><path d="M5.5 14h5"/>',
  claude: '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.5-2 1.5M8 10h3.5"/>',
  codex: '<path d="M5.5 3c-1.5 0-2 .7-2 2v1.3c0 .8-.5 1.2-1.5 1.2 1 0 1.5.4 1.5 1.2V11c0 1.3.5 2 2 2M10.5 3c1.5 0 2 .7 2 2v1.3c0 .8.5 1.2 1.5 1.2-1 0-1.5.4-1.5 1.2V11c0 1.3-.5 2-2 2"/>',
  chatgpt: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  home: '<path d="M2.5 7.5L8 3l5.5 4.5V13a1 1 0 01-1 1h-9a1 1 0 01-1-1z"/>',
  plug: '<path d="M6 2v3M10 2v3M4 5h8v2a4 4 0 01-8 0zM8 11v3"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5"/>',
  folder: '<path d="M2 4.5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1z"/>',
  cpu: '<rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6h2.5M1.5 10h2.5M12 6h2.5M12 10h2.5"/>',
  shield: '<path d="M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z"/>',
  puzzle: '<path d="M3 5h3a1.5 1.5 0 113 0h3v3a1.5 1.5 0 110 3v3H3z"/>',
  sparkle: '<path d="M8 2l1.4 4.6L14 8l-4.6 1.4L8 14l-1.4-4.6L2 8l4.6-1.4z"/>',
  bolt: '<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/>',
  book: '<path d="M3 2.5h7.5a1.5 1.5 0 011.5 1.5v9.5H4.5A1.5 1.5 0 013 12z"/>',
  terminal: '<path d="M3 4.5l3 3-3 3M8 11.5h5"/>',
  gauge: '<path d="M2.5 11a5.5 5.5 0 1111 0"/><path d="M8 11l2.5-3.5"/>',
  chat: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
};
const FACT_HUES = { user: '#2E7AF5', folder: '#20A5C8', cpu: '#8A5CF6', shield: '#1F9D55', plug: '#E8832E', puzzle: '#E0559A', sparkle: '#5B5FE0',
  bolt: '#D9A520', book: '#1A9C8C', terminal: '#6B7280', gauge: '#2DB37A', chat: '#1F9D55', globe: '#10A37F', clock: '#6B7280' };
const svg = (name, cls = '') => raw(`<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`);
const tile = (name, hue) => raw(`<span class="tile" style="background:linear-gradient(${hue}cc,${hue})">${svg(name).__html}</span>`);
const avatar = (name, hue) => raw(`<span class="avatar" style="background:linear-gradient(${hue}99,${hue}f0)">${esc(String(name).trim().charAt(0).toUpperCase() || '?')}</span>`);

function toast(text) {
  const t = $('#toast'); t.textContent = text; t.classList.add('on');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('on'), 2800);
}
async function run(p, okText) {
  try { const v = await p; if (okText) toast(typeof okText === 'function' ? okText(v) : okText); return v; }
  catch (e) { toast(e.message); return undefined; }
}

// ------------------------------------------------------------------ navigation
function go(p) {
  if (p !== page) { picked.clear(); tab = 'overview'; }
  page = p; location.hash = p; render();
  $('#main').scrollTop = 0;
}
function renderNav() {
  const item = (p, icon, label, extra = '') => h`<button class="nav-i ${page === p ? 'on' : ''}" data-go="${p}">${svg(icon, 'ico')}<span class="t">${label}</span>${raw(extra)}</button>`;
  let out = item('home', 'home', 'Dashboard');
  for (const s of visibleServices()) {
    out += h`<div class="nav-h">${info(s).title}</div>`;
    for (const a of accountsFor(s)) out += item(`account:${a.id}`, s, a.name, a.active ? '<span class="dot" title="In use"></span>' : '');
  }
  out += '<div class="nav-h">Tools</div>' + item('mcp', 'plug', 'MCP connections') + item('settings', 'gear', 'Customize');
  $('#nav').innerHTML = out;
}

/**
 * Draws the current page. A soft render (live updates, timers) leaves the page alone when the
 * new content is identical to what is already shown, so background updates never flicker.
 */
let shown = { page: null, html: '' };
function render(soft = false) {
  if (!S) return;
  const main = $('#main');
  let html, after = null;
  if (page.startsWith('account:')) { const a = acc(page.slice(8)); if (!a) { page = 'home'; return render(soft); } html = accountPage(a); after = () => loadAccount(a); }
  else if (page === 'mcp') { html = mcpPage(); after = loadMcp; }
  else if (page === 'settings') html = settingsPage();
  else { html = homePage(); after = loadStats; }
  html = String(html);
  if (soft && shown.page === page && shown.html === html) return;
  shown = { page, html };
  renderNav();
  const scroll = main.scrollTop;
  main.innerHTML = html;
  if (soft) main.scrollTop = scroll;
  if (after) after();
}

// ------------------------------------------------------------------ pieces
function meter(u) {
  if (!u) return raw('<span class="meter"><span class="muted small">No usage yet</span></span>');
  const p = Math.round(u.percent), lv = level(u.percent);
  const reset = u.resetsAt ? `${u.estimated ? '~' : ''}${short((u.resetsAt - Date.now()) / 1000)}` : '—';
  return h`<span class="meter" title="${u.tip}"><span class="bar"><i class="${lv}" style="width:${Math.max(2, Math.min(100, p))}%"></i></span><span class="pct ${lv}">${p}%</span><span>${u.window === 'Weekly' ? 'wk' : '5h'} · ${reset}</span></span>`;
}
function trailing(a) {
  if (a.active && a.service !== 'chatgpt') return raw('<span class="pill">In use</span>');
  const label = a.service === 'chatgpt' ? 'Open' : 'Switch';
  return h`<button class="btn small" data-act="select" data-id="${a.id}" ${S.switching && a.service === 'desktop' ? 'disabled' : ''}>${label}</button>`;
}

function homePage() {
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const services = visibleServices();
  const st = cache.stats;
  const needsTracking = !S.claudeTracking && S.accounts.some(a => a.service === 'claude');
  const cards = services.map(s => h`
    <section class="card">
      <div class="app-h">${tile(s, info(s).hue)}<h2>${info(s).title}</h2><span class="where">${info(s).where}</span></div>
      ${accountsFor(s).map(a => h`
        <div class="acc" data-go="account:${a.id}">
          ${avatar(a.name, info(s).hue)}
          <div class="who"><div class="name">${a.name}</div><div class="det">${a.detail}</div></div>
          ${s === 'claude' || s === 'codex' || s === 'desktop' ? meter(S.usage[a.id]) : ''}
          ${trailing(a)}
        </div>`)}
      <div class="add-row" data-act="add" data-service="${s}">${svg('plus', 'ico')} Add ${info(s).title} account</div>
    </section>`);
  const estimated = Object.values(S.usage).some(u => u.estimated);
  return h`<div class="page">
    <div class="head"><div class="grow"><h1>Dashboard</h1><div class="sub">${greet}. ${S.accounts.length} accounts across ${services.length} apps, all on this PC.</div></div>
      <div class="row"><button class="btn" data-act="terminal">${svg('terminal', 'ico')} New Terminal</button><button class="btn primary" data-act="add">${svg('plus', 'ico')} Add Account</button></div></div>
    <div class="card stats">
      <div class="stat"><div class="k">Accounts</div><div class="v">${fmtNum(S.accounts.length)}</div><div class="d">${services.length} apps</div></div>
      <div class="stat"><div class="k">Chats</div><div class="v">${fmtNum(st && st.chats)}</div><div class="d">Claude Code</div></div>
      <div class="stat"><div class="k">MCP</div><div class="v">${fmtNum(st && st.mcp)}</div><div class="d">connections</div></div>
      <div class="stat"><div class="k">Skills</div><div class="v">${fmtNum(st && st.skills)}</div><div class="d">Claude Code</div></div>
    </div>
    ${needsTracking ? raw(h`<div class="card notice">${tile('gauge', '#2DB37A')}<div class="grow"><div class="t">Track Claude Code limits</div>
      <div class="d">Adds a quiet status line hook that saves its limits on this PC. Accounts that already have a status line are left alone.</div></div>
      <button class="btn primary" data-act="track">Turn On</button></div>`) : ''}
    <div class="grid">${cards}</div>
    <div class="foot">
      ${estimated ? raw('<p>~ Claude Desktop readings are as recent as its last usage check; reset times are estimated.</p>') : ''}
      <p>A Claude Code login and a Claude Desktop login on the same Claude account share their limits.</p>
      <p>Claude Code and Codex switches apply to terminal windows opened after the switch.</p>
    </div>
    <div class="center"><a href="#" class="credit" data-credit>Made by <b>Nadim Sheikh</b></a></div>
  </div>`;
}

function accountPage(a) {
  const s = a.service, inf = info(s);
  const hasChats = s === 'claude' || s === 'desktop';
  if (!hasChats) tab = 'overview';
  const primary = a.active && s !== 'chatgpt'
    ? (a.signedIn ? raw('<span class="pill">In use</span>') : h`<button class="btn primary" data-act="signin" data-id="${a.id}">Sign in</button>`)
    : h`<button class="btn primary" data-act="select" data-id="${a.id}" ${S.switching && s === 'desktop' ? 'disabled' : ''}>${s === 'chatgpt' ? 'Open ChatGPT' : 'Switch to this account'}</button>`;
  const u = S.usage[a.id];
  return h`<div class="page">
    <div class="card hero">${avatar(a.name, inf.hue)}
      <div class="grow"><h1>${a.name}</h1><div class="sub">${inf.title} · ${a.detail}</div></div>
      <div class="row" style="flex-wrap:wrap">${primary}
        ${(s === 'claude' || s === 'codex') && a.active ? h`<button class="btn" data-act="signin" data-id="${a.id}">Sign in again</button>` : ''}
        <button class="btn" data-act="rename" data-id="${a.id}">Rename</button>
        <button class="btn" data-act="reveal" data-id="${a.id}">Show folder</button>
        ${a.isDefault ? '' : h`<button class="btn danger" data-act="remove" data-id="${a.id}">Remove</button>`}</div>
    </div>
    ${u ? raw(h`<div class="card sendbar"><div class="grow">${u.tip.split('\n').filter(l => !l.startsWith('From') ).join(' · ')}</div>${meter(u)}</div>`) : ''}
    ${hasChats ? raw(h`<div class="tabs"><button class="tab ${tab === 'overview' ? 'on' : ''}" data-tab="overview">Overview</button><button class="tab ${tab === 'chats' ? 'on' : ''}" data-tab="chats">Chats</button></div>`) : raw('<div style="height:14px"></div>')}
    <div id="pane"><div class="empty">Loading…</div></div>
  </div>`;
}

async function loadAccount(a) {
  const pane = $('#pane'); if (!pane) return;
  if (tab === 'chats') {
    if (!cache.chats[a.id]) { pane.innerHTML = '<div class="empty">Reading chats…</div>'; cache.chats[a.id] = await run(deck.chats(a.id)) || []; }
    if (page === `account:${a.id}` && tab === 'chats') pane.innerHTML = chatsPane(a);
    return;
  }
  const facts = await run(deck.environment(a.id)) || [];
  cache.env[a.id] = facts;
  if (page !== `account:${a.id}` || tab !== 'overview') return;
  pane.innerHTML = overviewPane(a, facts);
}

function overviewPane(a, facts) {
  const sendable = a.service === 'claude';
  const others = S.accounts.filter(x => x.service === 'claude' && x.id !== a.id);
  const cards = facts.map(f => h`<div class="card fact">${tile(f.icon, FACT_HUES[f.icon] || '#6B7280')}
    <div style="flex:1;min-width:0"><div class="k">${f.title}</div><div class="v">${f.value}</div>${f.detail ? raw(h`<div class="d">${f.detail}</div>`) : ''}</div>
    ${sendable && f.part && others.length ? h`<input type="checkbox" title="Send ${f.title}" data-pick="${f.part}" ${picked.has(f.part) ? 'checked' : ''}>` : ''}</div>`);
  let send = '';
  if (sendable && others.length) {
    send = h`<div class="section"><h2>Send setup to another account</h2>
      <div class="card sendbar"><div class="grow">Tick the parts above, then pick an account. Nothing it already has is replaced (except the model), and its old files are backed up first. Logins are never copied.</div>
      <select id="dest">${others.map(o => h`<option value="${o.id}">${o.name}</option>`)}</select>
      <button class="btn primary" data-act="envsend" data-id="${a.id}" ${picked.size ? '' : 'disabled'}>Send ${picked.size || ''}</button></div>
      <div id="sent"></div></div>`;
  }
  const note = a.service === 'desktop'
    ? raw(h`<p class="foot">Claude Desktop data folder in use: ${S.desktopFolder} (${S.desktopKind === 'msix' ? 'Microsoft Store install' : 'direct install'}).</p>`) : '';
  return h`<div class="facts">${cards}</div>${raw(send)}${note}`;
}

function chatsPane(a) {
  const folders = cache.chats[a.id] || [];
  const total = folders.reduce((n, f) => n + f.chats.length, 0);
  if (!total) return h`<div class="card empty">${a.service === 'desktop' ? 'No Code-tab chats for this account yet (it needs to have signed in once).' : 'No chats in this account yet.'}</div>`;
  const others = S.accounts.filter(x => x.service === a.service && x.id !== a.id);
  const bar = h`<div class="card sendbar" style="margin-bottom:14px"><div class="grow">${total} chats in ${folders.length} folders${picked.size ? ` · ${picked.size} selected` : ''}. Copies never overwrite a chat the other account already has.</div>
    ${others.length ? raw(h`<select id="dest">${others.map(o => h`<option value="${o.id}">${o.name}</option>`)}</select>
      <button class="btn primary" data-act="copychats" data-id="${a.id}" ${picked.size ? '' : 'disabled'}>Copy ${picked.size || ''} to account</button>`) : raw('<span class="muted small">Add another account to copy chats to it.</span>')}
  </div><div id="sent"></div>`;
  const list = folders.map((f, i) => {
    const all = f.chats.every(c => picked.has(c.id));
    return h`<div class="card folder"><label class="folder-h"><input type="checkbox" data-folder="${i}" ${all ? 'checked' : ''}><span class="n">${f.name}</span><span class="p">${f.path}</span><span class="tag">${f.chats.length}</span></label>
      ${f.chats.slice(0, 200).map(c => h`<label class="chat"><input type="checkbox" data-chat="${c.id}" ${picked.has(c.id) ? 'checked' : ''}><span class="t" title="${c.title}">${c.title}</span><span class="m">${ago(c.date)} · ${kb(c.size)}</span>
        ${a.service === 'claude' && c.sid ? h`<button class="btn small" data-act="resume" data-sid="${c.sid}" data-cwd="${c.folder}" title="Open in a terminal with claude --resume">Resume</button>` : ''}</label>`)}</div>`;
  });
  return bar + list.join('');
}

// ------------------------------------------------------------------ MCP page
let mcpFrom = null;
function mcpPage() {
  const sources = S.accounts.filter(a => a.service === 'claude' || a.service === 'desktop');
  if (!mcpFrom || !acc(mcpFrom)) mcpFrom = (sources.find(a => a.service === 'claude') || sources[0] || {}).id;
  const dests = S.accounts.filter(a => a.service === 'claude' && a.id !== mcpFrom);
  return h`<div class="page">
    <div class="head"><div class="grow"><h1>MCP connections</h1><div class="sub">Every MCP server a Claude Code account can use: its own, its projects', and Claude Desktop's (shared by all Desktop accounts on this PC).</div></div></div>
    <div class="card sendbar" style="margin-bottom:14px"><span>From</span><select id="mcpfrom">${sources.map(a => h`<option value="${a.id}" ${a.id === mcpFrom ? 'selected' : ''}>${info(a.service).title} · ${a.name}</option>`)}</select>
      <div class="grow"></div>
      ${dests.length ? raw(h`<span>Send to</span><select id="dest">${dests.map(o => h`<option value="${o.id}">Claude Code · ${o.name}</option>`)}</select>
        <button class="btn primary" data-act="mcpsend" ${picked.size ? '' : 'disabled'}>Send ${picked.size || ''}</button>`) : raw('<span class="muted small">Add another Claude Code account to send connections to it.</span>')}
    </div>
    <div id="sent"></div>
    <div class="card" id="mcplist"><div class="empty">Loading…</div></div>
    <p class="foot">Sending adds connections the other account doesn't have by that name; existing ones are never replaced, and its .claude.json is backed up first. Settings stay on this PC.</p>
  </div>`;
}
async function loadMcp() {
  if (!mcpFrom) { $('#mcplist').innerHTML = '<div class="empty">No Claude accounts.</div>'; return; }
  const list = await run(deck.mcp(mcpFrom)) || [];
  cache.mcp[mcpFrom] = list;
  const el = $('#mcplist'); if (!el) return;
  if (!list.length) { el.innerHTML = '<div class="empty">No MCP connections yet.</div>'; return; }
  el.innerHTML = list.map(e => h`<label class="mcp"><input type="checkbox" data-pick="${e.id}" ${picked.has(e.id) ? 'checked' : ''}>
    <div style="flex:1;min-width:0"><div class="n">${e.name}</div><div class="s">${e.summary || '—'}${e.envNames.length ? ` · env: ${e.envNames.join(', ')}` : ''}</div></div>
    <span class="tag">${e.kind}</span><span class="tag" title="${e.project || ''}">${e.scope === 'project' ? 'Project: ' + (e.project || '').split(/[\\/]/).pop() : e.scope === 'desktop' ? 'Claude Desktop' : 'User'}</span></label>`).join('');
}

// ------------------------------------------------------------------ settings
function settingsPage() {
  const order = S.settings.order, hidden = new Set(S.settings.hidden || []);
  const rows = order.map((s, i) => h`<div class="set">${tile(s, info(s).hue)}<div class="grow"><div>${info(s).title}</div><div class="d">${accountsFor(s).length} account(s) · ${info(s).where}</div></div>
    <button class="arrow" data-move="${s}" data-by="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="arrow" data-move="${s}" data-by="1" ${i === order.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
    <input type="checkbox" data-show="${s}" ${hidden.has(s) ? '' : 'checked'} title="Show in tray menu"></div>`);
  const seg = [['auto', 'Auto'], ['5h', '5-hour'], ['weekly', 'Weekly']].map(([v, l]) => h`<button class="${S.settings.limit === v ? 'on' : ''}" data-limit="${v}">${l}</button>`);
  return h`<div class="page">
    <div class="head"><div class="grow"><h1>Customize</h1><div class="sub">What the tray menu shows. Hidden apps keep their accounts. Use the arrows to change the order.</div></div></div>
    <div class="section"><h2>Show in menu</h2><div class="card">${rows}</div></div>
    <div class="section"><h2>Usage</h2><div class="card">
      <div class="set"><div class="grow"><div>Limit to show</div><div class="d">Auto shows the 5-hour limit, or the weekly one when that's the only one in use.</div></div><div class="seg">${seg}</div></div>
      <div class="set"><div class="grow"><div>Usage on menu rows</div><div class="d">% used and time to reset next to each account.</div></div><input type="checkbox" data-setting="usageOnRows" ${S.settings.usageOnRows !== false ? 'checked' : ''}></div>
      <div class="set"><div class="grow"><div>Claude Code limits</div><div class="d">${S.claudeTracking ? 'On for every Claude Code account.' : 'Adds a quiet status line hook; never replaces a status line you already have.'}</div></div>
        ${S.claudeTracking ? raw('<span class="pill">On</span>') : raw('<button class="btn" data-act="track">Turn On</button>')}</div>
    </div></div>
    <div class="section"><h2>App</h2><div class="card">
      <div class="set"><div class="grow"><div>Bring last chat when switching Claude Desktop</div><div class="d">Moves your most recent Code-tab chat to the account you switch to.</div></div><input type="checkbox" data-setting="carryChat" ${S.settings.carryChat ? 'checked' : ''}></div>
      <div class="set"><div class="grow"><div>Start with Windows</div><div class="d">Starts in the tray when you sign in.</div></div><input type="checkbox" data-login ${S.launchAtLogin ? 'checked' : ''}></div>
    </div></div>
    <p class="foot">AccountDeck ${S.version}. Everything stays on this PC: account folders live in %USERPROFILE%\\.accountdeck. Passwords and tokens are never shown, copied or sent anywhere.</p>
    <div class="center"><a href="#" class="credit" data-credit>Made by <b>Nadim Sheikh</b></a></div>
  </div>`;
}

// ------------------------------------------------------------------ dialogs
function dialog(html, onSubmit) {
  const m = $('#modal');
  m.innerHTML = `<form class="card dialog">${html}</form>`; m.hidden = false;
  const form = m.querySelector('form');
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  form.addEventListener('submit', async e => { e.preventDefault(); const data = Object.fromEntries(new FormData(form)); close(); await onSubmit(data); });
  form.querySelector('[data-cancel]').addEventListener('click', close);
  m.onclick = e => { if (e.target === m) close(); };
  const first = form.querySelector('input[type=text], select, button.primary'); if (first) first.focus();
}
function addDialog(service) {
  dialog(h`<h2>New account</h2><p>Give it a name you'll recognise, like "Work" or "Personal".</p>
    <label>App</label><select name="service">${S.services.map(s => h`<option value="${s}" ${s === service ? 'selected' : ''}>${info(s).title}</option>`)}</select>
    <label>Name</label><input type="text" name="name" maxlength="40" required placeholder="Work">
    <p class="small" style="margin-top:10px">Claude Code and Codex open a terminal to sign in. Claude Desktop restarts and asks you to sign in. ChatGPT opens its own browser window.</p>
    <div class="row"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Add</button></div>`,
  async d => { const id = await run(deck.add(d.service, d.name)); if (id) { await refresh(); go(`account:${id}`); } });
}
function confirmDialog(title, message, button, danger, fn) {
  dialog(h`<h2>${title}</h2><p>${message}</p><div class="row"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary" ${danger ? 'style="background:var(--bad)"' : ''}>${button}</button></div>`, fn);
}

// ------------------------------------------------------------------ actions
async function refresh() { S = await deck.state(); }
async function select(id) {
  const a = acc(id); if (!a) return;
  if (a.service === 'desktop' && !a.active) {
    const msg = await run(deck.desktopConfirmText(id));
    confirmDialog(`Switch Claude to "${a.name}"?`, msg, 'Restart Claude', false, () => run(deck.select(id, true)));
    return;
  }
  await run(deck.select(id));
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-go],[data-act],[data-tab],[data-credit],[data-move],[data-limit]');
  if (!t) return;
  if (t.dataset.credit !== undefined) { e.preventDefault(); deck.openCredit(); return; }
  if (t.dataset.act) e.stopPropagation();
  if (t.dataset.go && !e.target.closest('[data-act]')) return go(t.dataset.go);
  if (t.dataset.tab) { tab = t.dataset.tab; picked.clear(); return render(); }
  if (t.dataset.move) {
    const order = S.settings.order.slice(), i = order.indexOf(t.dataset.move), j = i + Number(t.dataset.by);
    if (j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j], order[i]];
    S = await run(deck.saveSettings({ order })) || S; return render();
  }
  if (t.dataset.limit) { S = await run(deck.saveSettings({ limit: t.dataset.limit })) || S; return render(); }
  const id = t.dataset.id;
  switch (t.dataset.act) {
    case 'select': return select(id);
    case 'add': return addDialog(t.dataset.service || 'claude');
    case 'terminal': return run(deck.openTerminal(), 'Opened a terminal with the active accounts');
    case 'signin': return run(deck.signIn(id));
    case 'reveal': return run(deck.reveal(id));
    case 'rename': {
      const a = acc(id);
      return dialog(h`<h2>Rename account</h2><label>Name</label><input type="text" name="name" maxlength="40" required value="${a.name}">
        <div class="row"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Rename</button></div>`,
      d => run(deck.rename(id, d.name)));
    }
    case 'remove': {
      const a = acc(id);
      return confirmDialog(`Remove "${a.name}"?`, 'Its saved login folder moves to the Recycle Bin, so you can restore it from there.', 'Move to Recycle Bin', true,
        async () => { if (await run(deck.remove(id))) go('home'); });
    }
    case 'track': {
      const skipped = await run(deck.enableTracking());
      if (skipped) toast(skipped.length ? `Turned on. Skipped (already have a status line): ${skipped.join(', ')}` : 'Claude Code limits turned on. They show after the next message.');
      return;
    }
    case 'envsend': {
      const dest = $('#dest').value;
      const lines = await run(deck.envCopy(id, [...picked], dest));
      if (lines) { $('#sent').innerHTML = h`<div class="card result">Sent to ${acc(dest).name}: ${lines.join(' · ')}.</div>`; picked.clear(); loadAccount(acc(id)); }
      return;
    }
    case 'copychats': {
      const dest = $('#dest').value;
      const r = await run(deck.copyChats(id, [...picked], dest));
      if (r) { delete cache.chats[dest]; picked.clear(); $('#pane').innerHTML = chatsPane(acc(id));
        $('#sent').innerHTML = h`<div class="card result">Copied ${r.copied} chat${r.copied === 1 ? '' : 's'} to ${acc(dest).name}${r.skipped ? ` · ${r.skipped} skipped (already there)` : ''}.</div>`; }
      return;
    }
    case 'resume': { e.preventDefault(); const a = acc(page.slice(8)); return run(deck.resumeChat(a.id, t.dataset.sid, t.dataset.cwd), 'Opening the chat in a terminal'); }
    case 'mcpsend': {
      const dest = $('#dest').value;
      const r = await run(deck.mcpSend(mcpFrom, [...picked], dest));
      if (r) { picked.clear(); render(); setTimeout(() => { const el = $('#sent'); if (el) el.innerHTML = h`<div class="card result">Sent to ${acc(dest).name}: ${r.added} added${r.skipped ? `, ${r.skipped} skipped (it already has them)` : ''}.</div>`; }, 0); }
      return;
    }
  }
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'mcpfrom') { mcpFrom = t.value; picked.clear(); return render(); }
  if (t.dataset.pick) { t.checked ? picked.add(t.dataset.pick) : picked.delete(t.dataset.pick); return updateSendButtons(); }
  if (t.dataset.chat) { t.checked ? picked.add(t.dataset.chat) : picked.delete(t.dataset.chat); return rerenderChats(); }
  if (t.dataset.folder) {
    const a = acc(page.slice(8)); const f = (cache.chats[a.id] || [])[Number(t.dataset.folder)];
    for (const c of f.chats) t.checked ? picked.add(c.id) : picked.delete(c.id);
    return rerenderChats();
  }
  if (t.dataset.show) {
    const hidden = new Set(S.settings.hidden || []); t.checked ? hidden.delete(t.dataset.show) : hidden.add(t.dataset.show);
    S = await run(deck.saveSettings({ hidden: [...hidden] })) || S; return;
  }
  if (t.dataset.setting) { S = await run(deck.saveSettings({ [t.dataset.setting]: t.checked })) || S; return; }
  if (t.dataset.login !== undefined) { await run(deck.setLaunchAtLogin(t.checked)); }
});
function updateSendButtons() {
  for (const b of document.querySelectorAll('[data-act=envsend],[data-act=mcpsend]')) { b.disabled = !picked.size; b.textContent = `Send ${picked.size || ''}`; }
}
function rerenderChats() {
  const a = acc(page.slice(8)); const scroll = $('#main').scrollTop;
  $('#pane').innerHTML = chatsPane(a); $('#main').scrollTop = scroll;
}

// ------------------------------------------------------------------ start
deck.on('state', s => {
  const before = S && JSON.stringify(S.accounts.map(a => [a.id, a.active, a.name, a.detail]));
  S = s;
  // Re-render unless the user is in the middle of picking things on a page.
  const after = JSON.stringify(S.accounts.map(a => [a.id, a.active, a.name, a.detail]));
  if (picked.size || !$('#modal').hidden) { if (before !== after) renderNav(); return; }
  if (before !== after) return render(true);
  if (page === 'home') render(true);
  else if (page.startsWith('account:')) updateLimitStrip();
});
deck.on('toast', toast);
deck.on('navigate', p => {
  if (p.startsWith('add:')) { if (page === 'home' || !S) {} addDialog(p.slice(4)); return; }
  go(p);
});

/** Refreshes only the usage strip of an account page, so a live update doesn't reload the page. */
function updateLimitStrip() {
  const a = acc(page.slice(8)); const el = document.querySelector('.hero + .sendbar'); const u = a && S.usage[a.id];
  if (el && u) el.outerHTML = h`<div class="card sendbar"><div class="grow">${u.tip.split('\n').filter(l => !l.startsWith('From')).join(' · ')}</div>${meter(u)}</div>`.__html;
  else if (!el && u) render();
}
async function loadStats() { cache.stats = await run(deck.stats()) || cache.stats; if (page === 'home') { const v = document.querySelectorAll('.stat .v'); if (v.length === 4 && cache.stats) { v[1].textContent = fmtNum(cache.stats.chats); v[2].textContent = fmtNum(cache.stats.mcp); v[3].textContent = fmtNum(cache.stats.skills); } } }

(async () => {
  await refresh();
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith('add:')) { page = 'home'; render(); addDialog(hash.slice(4)); }
  else { page = hash && (hash === 'mcp' || hash === 'settings' || hash.startsWith('account:')) ? hash : 'home'; render(); }
  setInterval(() => { if (picked.size || !$('#modal').hidden) return; if (page === 'home') render(true); else if (page.startsWith('account:')) updateLimitStrip(); }, 30000);   // countdowns
})();
