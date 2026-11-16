// Runs the core (no Electron) against a fake Windows user profile in a temp folder.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-'));
process.env.ACCOUNTDECK_TEST_HOME = T;
const w = (p, v) => { fs.mkdirSync(path.dirname(path.join(T, p)), { recursive: true }); fs.writeFileSync(path.join(T, p), typeof v === 'string' ? v : JSON.stringify(v)); };
const r = p => JSON.parse(fs.readFileSync(path.join(T, p), 'utf8'));
const now = Math.floor(Date.now() / 1000);
const await0 = p => { if (p && p.catch) p.catch(() => {}); };

// Claude Code main account
w('.claude.json', { oauthAccount: { emailAddress: 'me@example.com', accountUuid: 'U1' }, mcpServers: { github: { command: 'npx', args: ['-y', '@x/github'], env: { TOKEN: 'secret' } } },
  projects: { 'C:\\code\\app': { mcpServers: { db: { type: 'http', url: 'https://db.example.com/mcp' } } } } });
w('.claude/settings.json', { model: 'opus', permissions: { allow: ['Bash(ls)'], defaultMode: 'acceptEdits' }, env: { SECRET_KEY: 'zzz' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo' }] }] } });
w('.claude/CLAUDE.md', '# me');
w('.claude/skills/pdf/SKILL.md', 'x');
w('.claude/projects/C--code-app/s1.jsonl', [JSON.stringify({ type: 'user', cwd: 'C:\\code\\app', message: { content: 'Fix the login bug' } }), JSON.stringify({ type: 'ai-title', aiTitle: 'Login fix' })].join('\n'));
w('.claude/projects/C--code-app/s2.jsonl', JSON.stringify({ type: 'user', cwd: 'C:\\code\\app', message: { content: [{ type: 'text', text: 'Second chat' }] } }));
w('.claude/.accountdeck-status/sessA.json', { session_id: 'sessA', rate_limits: { five_hour: { used_percentage: 42, resets_at: now + 7200 }, seven_day: { used_percentage: 10, resets_at: now + 86400 * 3 } } });
// Codex
w('.codex/auth.json', { tokens: { id_token: 'h.' + Buffer.from(JSON.stringify({ email: 'codex@example.com' })).toString('base64url') + '.s' } });
w('.codex/config.toml', 'model = "gpt-5"\n[mcp_servers.fs]\ncommand = "x"\n');
w('.codex/sessions/2026/11/14/rollout-2026-11-14T10-00-00-abc.jsonl', JSON.stringify({ type: 'event_msg', payload: { rate_limits: { primary: { used_percent: 77, window_minutes: 300, resets_at: now + 3600 }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: now + 86400 } } } }));
// Claude Desktop (direct install) with a Store copy that's older
w('AppData/Roaming/Claude/config.json', { lastKnownAccountUuid: 'U1', 'oauth:tokenCacheV2': 'enc', theme: 'dark' });
w('AppData/Roaming/Claude/Network/Cookies', 'cookieA');
w('AppData/Roaming/Claude/claude_desktop_config.json', { mcpServers: { files: { command: 'C:\\tools\\files.exe' } } });
w('AppData/Roaming/Claude/claude-code-sessions/U1/org1/local_1.json', { title: 'Desktop chat', cliSessionId: 'sessD', lastFocusedAt: 5, cwd: 'C:\\code\\app' });
w('AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/x.txt', 'x');

const P = require('../src/core/paths');
const { AppModel } = require('../src/core/model');
const { UsageStore, viewUsage, badgeText, SCRIPT, hookCommand } = require('../src/core/usage');
const D = require('../src/core/data');

assert.ok(P.desktopSupport().endsWith(path.join('Roaming', 'Claude')), 'direct install wins when it has the newer config: ' + P.desktopSupport());
assert.strictEqual(P.desktopCandidates().length, 2);

const m = new AppModel();
const byS = s => m.accountsFor(s);
assert.strictEqual(m.details['claude-default'], 'me@example.com');
assert.strictEqual(m.details['codex-default'], 'codex@example.com');
assert.strictEqual(m.details['desktop-default'], 'Open in Claude now');

const u = new UsageStore(m); u.refresh(true);
assert.strictEqual(u.usage['claude-default'].percent, 42);
assert.strictEqual(u.usage['codex-default'].percent, 77);
assert.strictEqual(u.usage['codex-default'].second.window, 'Weekly');
assert.strictEqual(viewUsage(u.usage['claude-default'], 'weekly').percent, 10);
assert.match(badgeText(u.usage['claude-default']), /^42% · (1|2)h$/);
assert.strictEqual(u.claudeTracking, false);

// Turn On tracking: existing settings kept, backup made, never over an existing statusLine
const skipped = u.enableClaudeTracking();
assert.deepStrictEqual(skipped, []);
const st = r('.claude/settings.json');
assert.strictEqual(st.model, 'opus'); assert.ok(st.statusLine.command.includes('claude-status.ps1'));
assert.ok(fs.existsSync(path.join(T, '.claude/settings.json.accountdeck-backup')));
assert.ok(fs.existsSync(path.join(T, '.accountdeck/claude-status.ps1')));
assert.strictEqual(u.enableClaudeTracking().length, 0);

// Add a Claude Code account; it gets its own folder (terminal sign-in is a no-op on macOS)
const work = m.add('claude', 'Work Ünal');
assert.strictEqual(work.id, 'claude-work-unal');
assert.ok(fs.existsSync(work.dir));
// Status line skipped when the account already has one
fs.writeFileSync(path.join(work.dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }));
assert.deepStrictEqual(u.enableClaudeTracking(), ['Work Ünal']);

// Environment cards: env var NAMES only
const facts = D.environment(byS('claude')[0], m);
const envFact = facts.find(f => f.title === 'Environment');
assert.strictEqual(envFact.detail, 'SECRET_KEY');
assert.ok(!JSON.stringify(facts).includes('zzz'));

// Env copy merges, backs up
const rep = D.envCopy(['model', 'permissions', 'mcp', 'skills', 'memory', 'env', 'hooks', 'plugins'], P.claudeHome, work.dir, path.join(T, '.claude.json'), path.join(work.dir, '.claude.json'));
const ws = JSON.parse(fs.readFileSync(path.join(work.dir, 'settings.json'), 'utf8'));
assert.strictEqual(ws.model, 'opus'); assert.strictEqual(ws.statusLine.command, 'mine');
assert.ok(fs.existsSync(path.join(work.dir, 'skills/pdf/SKILL.md')));
assert.ok(fs.readdirSync(work.dir).some(f => f.startsWith('settings.json.accountdeck-')));
console.log('env copy:', rep.join(' · '));

// MCP list never exposes values; send merges and skips existing
const mcp = D.mcpEntries(path.join(T, '.claude.json'), true);
assert.deepStrictEqual(mcp.map(e => e.id), ['user/github', 'project:C:\\code\\app/db', 'desktop/files']);
assert.ok(!JSON.stringify(mcp).includes('secret'));
const sent = D.mcpSend(path.join(T, '.claude.json'), mcp.map(e => e.id), path.join(work.dir, '.claude.json'));
assert.deepStrictEqual(sent, { added: 2, skipped: 1 });   // github already copied by env copy

// Chats + copy without overwrite
const chats = D.codeChats(path.join(P.claudeHome, 'projects'));
assert.strictEqual(chats.length, 2);
assert.ok(chats.some(c => c.title === 'Login fix'));
const g = D.group(chats); assert.strictEqual(g[0].name, 'app');
const c1 = D.copyCode(chats.map(c => c.id), path.join(P.claudeHome, 'projects'), path.join(work.dir, 'projects'));
assert.deepStrictEqual(c1, { copied: 2, skipped: 0 });
assert.deepStrictEqual(D.copyCode(chats.map(c => c.id), path.join(P.claudeHome, 'projects'), path.join(work.dir, 'projects')), { copied: 0, skipped: 2 });
assert.deepStrictEqual(D.copyCode([path.join(T, '.claude.json')], path.join(P.claudeHome, 'projects'), path.join(work.dir, 'projects')), { copied: 0, skipped: 1 });
assert.strictEqual(D.desktopChats('U1').length, 1);

// Claude Desktop swap: save current login, sign out for a new slot, then swap back
const sup = P.desktopSupport();
const main = m.byId('desktop-default');
const second = { id: 'desktop-two', service: 'desktop', name: 'Two', isDefault: false, dir: path.join(P.root, 'desktop', 'desktop-two') };
m.accounts.push(second);
m.swapDesktopFiles(main, second, sup);
assert.ok(fs.existsSync(path.join(P.root, 'desktop/_original-backup/Network/Cookies')));
assert.strictEqual(fs.readFileSync(path.join(main.dir, 'Network/Cookies'), 'utf8'), 'cookieA');
assert.ok(!fs.existsSync(path.join(sup, 'Network/Cookies')));
const cfg = r('AppData/Roaming/Claude/config.json');
assert.strictEqual(cfg.theme, 'dark'); assert.ok(!cfg['oauth:tokenCacheV2']); assert.ok(!cfg.lastKnownAccountUuid);
m.active.desktop = second.id;
// pretend the second account signed in
fs.writeFileSync(path.join(sup, 'Network/Cookies'), 'cookieB');
fs.writeFileSync(path.join(sup, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'U2', theme: 'light' }));
m.swapDesktopFiles(second, main, sup);
assert.strictEqual(fs.readFileSync(path.join(sup, 'Network/Cookies'), 'utf8'), 'cookieA');
assert.strictEqual(r('AppData/Roaming/Claude/config.json').lastKnownAccountUuid, 'U1');
assert.strictEqual(fs.readFileSync(path.join(second.dir, 'Network/Cookies'), 'utf8'), 'cookieB');

// Carry last chat between Desktop accounts
fs.mkdirSync(path.join(sup, 'claude-code-sessions/U2/orgB'), { recursive: true });
fs.writeFileSync(path.join(sup, 'claude-code-sessions/U2/orgB/local_0.json'), '{}');
assert.strictEqual(m.carryLastChat('U1', 'U2', sup), 'Desktop chat');
assert.ok(fs.existsSync(path.join(sup, 'claude-code-sessions/U2/orgB/local_1.json')));
assert.ok(fs.existsSync(path.join(P.root, 'moved-chats/local_1.json')));

// The hook script prints nothing (no Write-Output / Write-Host)
assert.ok(!/Write-(Output|Host)/.test(SCRIPT));
console.log('hook command:', hookCommand());

// Terminal scripts: crafted names, folders and values can't add commands
{
  const W = require('../src/core/win');
  const evil = path.join(T, 'x"\r\ncalc.exe');
  const f = W.openTerminal({ title: 'a\r\ncalc & "b"', env: { CLAUDE_CONFIG_DIR: path.join(T, '100%') }, cwd: evil, commands: ['echo ' + W.echoSafe('n\r\ncalc & x')] });
  const txt = fs.readFileSync(f, 'utf8'), ls = txt.split('\r\n').filter(Boolean);
  assert.strictEqual(ls.length, 5, txt);                       // @echo, chcp, title, set, echo: no extra lines, no cd
  assert.ok(!ls.some(l => /^calc/i.test(l.trim())));
  assert.ok(txt.includes('100%%'));
  assert.throws(() => W.openTerminal({ title: 't', env: { 'A&B': 'x' } }));
  assert.throws(() => W.openTerminal({ title: 't', env: { A: 'x"\r\ncalc' } }));
  assert.throws(() => W.openTerminal({ title: 't', commands: ['a\ncalc'] }));
  assert.strictEqual(W.safeDir('relative\\dir'), false);
  const odd = m.add('codex', 'Li\nne\u0000 two');
  assert.ok(!/[\u0000-\u001f]/.test(odd.name)); await0(m.remove(odd.id, async () => {}));
}

// Rename / remove
m.rename(work.id, 'Work');
assert.strictEqual(m.byId(work.id).name, 'Work');
const stats = D.stats(m); console.log('stats:', stats);
assert.strictEqual(stats.chats, 4);

(async () => {
  const trashed = [];
  assert.ok(await m.remove(work.id, async p => trashed.push(p)));
  assert.deepStrictEqual(trashed, [work.dir]);
  assert.strictEqual(m.active.claude, 'claude-default');
  assert.strictEqual(await m.remove('claude-default', async () => {}), false);
  fs.rmSync(T, { recursive: true, force: true });
  console.log('ALL SMOKE TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
