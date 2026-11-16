// Windows-only actions: user environment variables, closing/opening Claude Desktop, opening
// browsers and terminals. On other systems (tests on a Mac) these do nothing or log.
'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const P = require('./paths');
const { exists, ls } = require('./util');

// With a test profile (ACCOUNTDECK_TEST_HOME) nothing real is touched: no environment variables,
// no processes ended, no terminals or browsers opened.
const isWin = process.platform === 'win32' && !P.testing;
const log = (...a) => { if (process.env.ACCOUNTDECK_DEBUG) console.log('[win]', ...a); };

/** Runs a PowerShell script (passed base64-encoded so quoting can't break it). */
function ps(script, { timeout = 30000 } = {}) {
  return new Promise(resolve => {
    if (!isWin) { log('ps skipped:', script.slice(0, 120)); return resolve({ ok: true, out: '' }); }
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || '').trim(), err: err ? String(stderr || err.message) : '' });
      });
  });
}
const psq = s => "'" + String(s).replace(/'/g, "''") + "'";

/**
 * Sets (or removes, when value is null) a per-user environment variable. .NET writes it to
 * HKCU\Environment and broadcasts WM_SETTINGCHANGE, so Explorer and terminals opened after this
 * see the new value. AccountDeck's own process.env is updated too, for windows it opens itself.
 */
async function setUserEnv(name, value) {
  if (value == null) delete process.env[name]; else process.env[name] = value;
  const v = value == null ? '$null' : psq(value);
  return ps(`[Environment]::SetEnvironmentVariable(${psq(name)}, ${v}, 'User')`);
}
async function getUserEnv(name) {
  if (!isWin) return process.env[name] ?? null;
  const r = await ps(`[Environment]::GetEnvironmentVariable(${psq(name)}, 'User')`);
  return r.out ? r.out : null;
}

// ---- Claude Desktop process ----
// Claude Desktop's process is claude.exe. Claude Code's CLI can also be claude.exe
// (%USERPROFILE%\.local\bin\claude.exe), so processes are matched by install folder, never by name alone.
const DESKTOP_FILTER = `Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like '*\\AnthropicClaude\\*' -or $_.Path -like '*\\WindowsApps\\Claude_*' -or $_.Path -like '*\\WindowsApps\\Anthropic*' -or $_.Path -like '*\\Programs\\Claude\\*' -or $_.Path -like '*\\Anthropic\\Claude\\*') }`;

async function desktopRunning() {
  const r = await ps(`@(${DESKTOP_FILTER}).Count`);
  return isWin ? Number(r.out || 0) > 0 : false;
}

/** Path of the running Claude Desktop executable, if any (to reopen the same one later). */
async function desktopExePath() {
  const r = await ps(`(${DESKTOP_FILTER} | Select-Object -First 1).Path`);
  return r.out || null;
}

/**
 * Closes Claude Desktop. First asks politely (close its windows), then ends it if it is still
 * running after a few seconds (Claude keeps running in the tray when its window is closed).
 * Returns true once no Claude Desktop process is left.
 */
async function quitDesktop() {
  if (!isWin) return true;
  if (!(await desktopRunning())) return true;
  await ps(`${DESKTOP_FILTER} | ForEach-Object { try { [void]$_.CloseMainWindow() } catch {} }`);
  for (let i = 0; i < 8; i++) { await sleep(500); if (!(await desktopRunning())) { await sleep(1000); return true; } }
  await ps(`${DESKTOP_FILTER} | Stop-Process -Force -ErrorAction SilentlyContinue`);
  for (let i = 0; i < 40; i++) { await sleep(500); if (!(await desktopRunning())) { await sleep(1200); return true; } }
  return false;
}

/** Opens Claude Desktop: the Store app through its AppID, or the installed claude.exe. */
async function launchDesktop(lastExe) {
  if (!isWin) return true;
  // Store / MSIX install: ask Windows for the Start menu entry's AppID.
  if (!lastExe || /\\WindowsApps\\/i.test(lastExe)) {
    const r = await ps(`(Get-StartApps | Where-Object { $_.AppID -like 'Claude_*!*' -or $_.AppID -like 'Anthropic*Claude*!*' } | Select-Object -First 1).AppID`);
    if (r.out) { spawn('explorer.exe', [`shell:AppsFolder\\${r.out}`], { detached: true, stdio: 'ignore' }).unref(); return true; }
  }
  const candidates = [
    path.join(P.localAppData, 'AnthropicClaude', 'claude.exe'),          // direct installer's launcher (keeps updates working)
    path.join(P.localAppData, 'Programs', 'Claude', 'Claude.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Claude', 'Claude.exe'),
    lastExe,
  ].filter(Boolean);
  const exe = candidates.find(exists);
  if (!exe) {
    // Last try: any Start menu entry named Claude.
    const r = await ps(`(Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1).AppID`);
    if (r.out) { spawn('explorer.exe', [`shell:AppsFolder\\${r.out}`], { detached: true, stdio: 'ignore' }).unref(); return true; }
    return false;
  }
  spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();
  return true;
}

// ---- Browsers (ChatGPT) ----
function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = P.localAppData;
  const list = [
    ['Google Chrome', path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Google Chrome', path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Google Chrome', path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Brave', path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
    ['Brave', path.join(la, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
    ['Microsoft Edge', path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Microsoft Edge', path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
  ];
  const hit = list.find(([, p]) => exists(p));
  return hit ? { name: hit[0], exe: hit[1] } : null;
}
function openChatGPT(profileDir) {
  const b = findBrowser();
  if (!b) return null;
  fs.mkdirSync(profileDir, { recursive: true });
  if (isWin) spawn(b.exe, [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', 'https://chatgpt.com'],
    { detached: true, stdio: 'ignore' }).unref();
  return b.name;
}

// ---- Terminals ----
/**
 * Opens a new console window running `commands` with the given environment changes
 * (value null = remove). Writes a small .cmd script to %USERPROFILE%\.accountdeck\run and
 * starts it with cmd.exe, so paths with spaces or accents survive. Old scripts are cleaned up
 * on the next start.
 */
function openTerminal({ title, env = {}, commands = [], cwd }) {
  const dir = path.join(P.root, 'run');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now().toString(36)}.cmd`);
  const lines = ['@echo off', 'chcp 65001 >nul', `title ${String(title).replace(/[&|<>^%]/g, ' ')}`];
  for (const [k, v] of Object.entries(env)) lines.push(v == null ? `set "${k}="` : `set "${k}=${String(v).replace(/%/g, '%%')}"`);
  if (cwd && exists(cwd)) lines.push(`cd /d ${cmdq(cwd)}`);
  lines.push(...commands);
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
  log('terminal script:', file, '\n' + lines.join('\n'));
  if (!isWin) return file;
  spawn('cmd.exe', ['/k', cmdq(file)], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, cwd: P.home }).unref();
  return file;
}
function cleanRunScripts() {
  const dir = path.join(P.root, 'run');
  for (const f of ls(dir)) { const p = path.join(dir, f); try { if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p); } catch {} }
}
/** Quotes a value for cmd.exe. */
const cmdq = s => '"' + String(s).replace(/"/g, '') + '"';
/** Escapes text for `echo` in a batch file. */
const echoSafe = s => String(s).replace(/[\^&|<>%"]/g, c => (c === '%' ? '%%' : c === '"' ? "'" : '^' + c));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { isWin, ps, setUserEnv, getUserEnv, quitDesktop, launchDesktop, desktopRunning, desktopExePath, findBrowser, openChatGPT, openTerminal, cleanRunScripts, cmdq, echoSafe, sleep };
