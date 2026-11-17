// Where things live on Windows. All paths derive from the user profile so tests can point
// them at a temporary folder (ACCOUNTDECK_TEST_HOME).
'use strict';
const os = require('os');
const path = require('path');
const { exists, ls, mtime, isDir } = require('./util');

const home = process.env.ACCOUNTDECK_TEST_HOME || os.homedir();
const testing = !!process.env.ACCOUNTDECK_TEST_HOME;
const appData = testing ? path.join(home, 'AppData', 'Roaming') : (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'));
const localAppData = testing ? path.join(home, 'AppData', 'Local') : (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'));

const root = path.join(home, '.accountdeck');

/**
 * Claude Desktop's data folder (Electron "userData").
 *  • Direct .exe installer: %APPDATA%\Claude
 *  • Microsoft Store / WinGet / MSIX installer: Windows redirects the app's %APPDATA% writes to
 *    %LOCALAPPDATA%\Packages\Claude_<publisher id>\LocalCache\Roaming\Claude
 *    (publisher id reported as "pzs8sxrjxfjjc"; matched with a wildcard here, not assumed).
 *  • Newer Store builds: %LOCALAPPDATA%\Claude-Data\claude_<publisher id>
 * When several exist, the one whose config.json or cookies changed most recently is the one
 * Claude is using. Old, empty folders from earlier versions are left behind by Claude's updates.
 */
function desktopCandidates() {
  const out = [];
  const pkgRoot = path.join(localAppData, 'Packages');
  for (const name of ls(pkgRoot)) {
    if (!/^Claude_/i.test(name) && !/^Anthropic\.Claude_/i.test(name)) continue;
    for (const sub of [['LocalCache', 'Roaming', 'Claude'], ['LocalCache', 'Local', 'Claude']]) {
      const p = path.join(pkgRoot, name, ...sub);
      if (isDir(p)) out.push({ dir: p, kind: 'msix', pkg: name });
    }
  }
  // Newer Store builds (seen on Claude 5.x) keep everything in %LOCALAPPDATA%\Claude-Data\<package name>.
  const dataRoot = path.join(localAppData, 'Claude-Data');
  for (const name of ls(dataRoot)) {
    const p = path.join(dataRoot, name);
    if (isDir(p)) out.push({ dir: p, kind: 'msix', pkg: name });
  }
  const direct = path.join(appData, 'Claude');
  if (isDir(direct)) out.push({ dir: direct, kind: 'direct' });
  return out;
}
function desktopSupport() {
  const c = desktopCandidates();
  if (!c.length) return path.join(appData, 'Claude');
  const score = x => Math.max(mtime(path.join(x.dir, 'config.json')), mtime(path.join(x.dir, 'Network', 'Cookies')), mtime(path.join(x.dir, 'Cookies')));
  c.sort((a, b) => score(b) - score(a));
  return c[0].dir;
}
function desktopInstallKind() {
  const sup = desktopSupport();
  const c = desktopCandidates().find(x => x.dir === sup);
  return c ? c.kind : 'direct';
}

const claudeHome = path.join(home, '.claude');
const codexHome = path.join(home, '.codex');
function short(p) { return p && p.startsWith(home) ? '%USERPROFILE%' + p.slice(home.length) : p; }

module.exports = { home, root, appData, localAppData, desktopSupport, desktopCandidates, desktopInstallKind, claudeHome, codexHome, short, testing, exists };
