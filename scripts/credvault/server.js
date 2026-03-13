const express = require('/app/node_modules/.pnpm/express@5.2.1/node_modules/express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { execSync } = require('child_process');

const app = express();
const PORT = 18795;
const HOST = '0.0.0.0';
const SESSION_TTL_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;  // 15-minute lockout window
const LOGIN_MAX_ATTEMPTS = 5;
const DEFAULT_PASSWORD = 'DealFlowAI2026!';
const AUTH_FILE = '/home/node/.openclaw/workspace/scripts/credvault/auth.json';
const PRIMARY_CREDENTIALS_FILE = '/home/node/.openclaw/workspace/life/projects/apex/credentials.md';
const ACCESS_LOG = '/tmp/credvault-access.log';  // /var/log/ is read-only in container; using /tmp
const WORKSPACE_ROOT = '/home/node/.openclaw/workspace';
const CREDVAULT_DIR = '/home/node/.openclaw/workspace/scripts/credvault';
const AGENT_FILES = {
  Neo: PRIMARY_CREDENTIALS_FILE,
  Josh: '/home/node/.openclaw/workspace/life/projects/josh/credentials.md',
  Shared: PRIMARY_CREDENTIALS_FILE,
};

const ENV_VAR_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN',
  'GHL_API_KEY', 'GHL_PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN', 'STRIPE_SECRET_KEY',
  'CLOUDFLARE_API_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
]);

const LOG_NOISE_PATTERNS = [
  'browser failed', 'browser tool', 'service config', 'systemd', 'enoent', 'exec failed', 'diagnostic'
];

app.use(express.urlencoded({ extended: false, limit: '10mb' }));

function logAccess(req, action, detail) {
  try {
    const now = new Date().toISOString();
    const ip = req ? getIp(req) : 'local';
    const line = `${now} [${ip}] ${action} ${detail || ''}\n`;
    fs.appendFileSync(ACCESS_LOG, line);
  } catch { /* non-fatal */ }
}

const sessions = new Map();
const loginAttempts = new Map();

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
      const idx = part.indexOf('=');
      return idx === -1 ? [part, ''] : [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
    })
  );
}

function setCookie(res, name, value, options = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (options.httpOnly) cookie += '; HttpOnly';
  if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
  if (options.path) cookie += `; Path=${options.path}`;
  if (options.maxAge !== undefined) cookie += `; Max-Age=${options.maxAge}`;
  res.append('Set-Cookie', cookie);
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function redirect(res, location) {
  res.status(302).set('Location', location).end();
}

function pbkdf2Hash(password, salt) {
  const iterations = 120000;
  const digest = 'sha256';
  const keylen = 32;
  const derived = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString('hex');
  return `pbkdf2$${digest}$${iterations}$${salt}$${derived}`;
}

function ensureAuthFile() {
  ensureDir(AUTH_FILE);
  if (!fs.existsSync(AUTH_FILE)) {
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = pbkdf2Hash(DEFAULT_PASSWORD, salt);
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ algorithm: 'pbkdf2', passwordHash, createdAt: new Date().toISOString() }, null, 2));
  }
}

function loadAuthConfig() {
  ensureAuthFile();
  const raw = fs.readFileSync(AUTH_FILE, 'utf8');
  return JSON.parse(raw);
}

function verifyPassword(password) {
  const auth = loadAuthConfig();
  const parts = String(auth.passwordHash || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, iterations, salt, storedHex] = parts;
  const derived = crypto.pbkdf2Sync(password, salt, Number(iterations), Buffer.from(storedHex, 'hex').length, digest);
  const stored = Buffer.from(storedHex, 'hex');
  return stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
}

function getIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function canAttemptLogin(ip) {
  const now = Date.now();
  const entries = (loginAttempts.get(ip) || []).filter(ts => now - ts < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, entries);
  return entries.length < LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entries = (loginAttempts.get(ip) || []).filter(ts => now - ts < LOGIN_WINDOW_MS);
  entries.push(now);
  loginAttempts.set(ip, entries);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TTL_MS) sessions.delete(token);
  }
}

function getSession(req) {
  pruneSessions();
  const token = parseCookies(req).credvault_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.lastActivity > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  session.lastActivity = Date.now();
  return { token, ...session };
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    clearCookie(res, 'credvault_session');
    return redirect(res, '/login');
  }
  req.session = session;
  next();
}

function getFlash(req) {
  const cookies = parseCookies(req);
  if (!cookies.credvault_flash) return null;
  try {
    return JSON.parse(Buffer.from(cookies.credvault_flash, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function setFlash(res, type, message) {
  const payload = Buffer.from(JSON.stringify({ type, message }), 'utf8').toString('base64url');
  setCookie(res, 'credvault_flash', payload, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 60 });
}

function consumeFlash(req, res) {
  const flash = getFlash(req);
  if (flash) clearCookie(res, 'credvault_flash');
  return flash;
}

function readCredentialFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, readable: false, content: '', stats: null };
    const stats = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    return { exists: true, readable: true, content, stats };
  } catch {
    return { exists: fs.existsSync(filePath), readable: false, content: '', stats: null };
  }
}

function parseCredentials(content, filePath) {
  const lines = String(content || '').split(/\r?\n/);
  const entries = [];
  let section = 'General';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const bullet = line.match(/^\s*-\s*([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
    const inline = !bullet ? line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/) : null;
    const match = bullet || inline;
    if (match) {
      entries.push({ key: match[1].trim(), value: match[2], section, lineIndex: i, bullet: Boolean(bullet), filePath });
    }
  }
  return entries;
}

function parseFileEntries(filePath) {
  const file = readCredentialFile(filePath);
  return { ...file, entries: parseCredentials(file.content, filePath) };
}

function scanCredentialFiles() {
  const results = [];
  const projectRoot = '/home/node/.openclaw/workspace/life/projects';
  if (fs.existsSync(projectRoot)) {
    for (const dirent of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      results.push(path.join(projectRoot, dirent.name, 'credentials.md'));
    }
  }
  results.push('/home/node/.openclaw/workspace/credentials.md');
  return Array.from(new Set(results)).map(filePath => {
    const file = parseFileEntries(filePath);
    return {
      filePath,
      exists: file.exists,
      readable: file.readable,
      lastModified: file.stats ? file.stats.mtime.toISOString() : null,
      credentialCount: file.entries.length,
    };
  });
}

function maskValue(value) {
  const str = String(value || '');
  return `••••••••${str.slice(-4)}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function shortenPath(filePath) {
  return filePath.replace('/home/node/.openclaw/', '');
}

function ensureCredentialFile(filePath) {
  ensureDir(filePath);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '## Shared\n', 'utf8');
}

function backupFile(filePath) {
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
}

function saveCredential(agent, key, value) {
  const filePath = AGENT_FILES[agent] || PRIMARY_CREDENTIALS_FILE;
  ensureCredentialFile(filePath);
  backupFile(filePath);
  const parsed = parseFileEntries(filePath);
  const lines = String(parsed.content || '').split(/\r?\n/);
  const existing = parsed.entries.find(entry => entry.key === key);
  const sectionName = agent;

  if (existing) {
    lines[existing.lineIndex] = `${existing.bullet ? '- ' : ''}${key}: ${value}`;
  } else {
    let sectionLine = lines.findIndex(line => line.trim() === `## ${sectionName}`);
    if (sectionLine === -1) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(`## ${sectionName}`);
      lines.push(`- ${key}: ${value}`);
    } else {
      let insertAt = sectionLine + 1;
      while (insertAt < lines.length && !/^##\s+/.test(lines[insertAt])) insertAt++;
      lines.splice(insertAt, 0, `- ${key}: ${value}`);
    }
  }

  fs.writeFileSync(filePath, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
}

function deleteCredential(key) {
  const filePath = PRIMARY_CREDENTIALS_FILE;
  ensureCredentialFile(filePath);
  backupFile(filePath);
  const parsed = parseFileEntries(filePath);
  const lines = String(parsed.content || '').split(/\r?\n/);
  const remaining = lines.filter((_, idx) => !parsed.entries.some(entry => entry.key === key && entry.lineIndex === idx));
  fs.writeFileSync(filePath, remaining.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
}

function collectDashboardData() {
  const parsed = parseFileEntries(PRIMARY_CREDENTIALS_FILE);
  const fileStats = parsed.stats;
  const rows = parsed.entries.map(entry => ({
    agent: /shared/i.test(entry.section) ? 'Shared' : 'Neo',
    key: entry.key,
    value: entry.value,
    maskedValue: maskValue(entry.value),
    lastModified: fileStats ? fileStats.mtime.toISOString() : null,
  }));
  return { rows, lastUpdated: fileStats ? fileStats.mtime.toISOString() : null, scan: scanCredentialFiles() };
}

function renderNav(activeTab = 'credentials') {
  const tabs = [
    ['credentials', '/', 'Credentials'],
    ['agents', '/agents', 'Agents'],
    ['health', '/health', 'Health'],
    ['logs', '/logs', 'Logs'],
    ['files', '/files', 'Files'],
    ['actions', '/actions', 'Actions'],
    ['onboarding', '/onboarding', 'Onboarding'],
  ];
  return `<nav class="nav-shell"><div class="nav-scroll">${tabs.map(([id, href, label]) => `<a class="nav-tab ${activeTab === id ? 'active' : ''}" href="${href}">${escapeHtml(label)}</a>`).join('')}</div></nav>`;
}

function layout(title, body, flash, activeTab = 'credentials', extraHead = '') {
  const flashHtml = flash ? `<div class="flash ${escapeHtml(flash.type)}">${escapeHtml(flash.message)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  ${extraHead}
  <style>
    :root {
      --bg: #0a0e1a; --card: #111827; --border: #1f2937; --text: #f9fafb; --muted: #9ca3af; --accent: #e84c3d; --green: #10b981; --yellow: #f59e0b; --red: #ef4444;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, system-ui, sans-serif; background: var(--bg); color: var(--text); }
    a { color: inherit; text-decoration: none; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 10px 40px rgba(0,0,0,.25); }
    .flash { padding: 14px 16px; border-radius: 14px; margin-bottom: 18px; border: 1px solid transparent; }
    .flash.success { background: rgba(16,185,129,.12); color: #d1fae5; border-color: rgba(16,185,129,.35); }
    .flash.error { background: rgba(232,76,61,.12); color: #fecaca; border-color: rgba(232,76,61,.35); }
    .flash.warn { background: rgba(245,158,11,.12); color: #fde68a; border-color: rgba(245,158,11,.35); }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid var(--border); background: #0f172a; color: var(--text); border-radius: 12px; padding: 10px 14px; cursor: pointer; font-weight: 600; }
    .btn.primary { background: var(--accent); border-color: var(--accent); }
    .btn.green { background: var(--green); border-color: var(--green); color: #04130d; }
    .btn.small { padding: 8px 10px; font-size: 13px; }
    .btn.warn { background: #3b2a0c; border-color: #5d4120; color: #fde68a; }
    input, select, textarea { width: 100%; background: #0f172a; border: 1px solid var(--border); color: var(--text); border-radius: 12px; padding: 12px 14px; font-size: 15px; }
    textarea { min-height: 320px; resize: vertical; }
    label { display: block; margin-bottom: 8px; color: var(--muted); font-weight: 600; }
    .muted { color: var(--muted); }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 22px; }
    .title h1 { margin: 0; font-size: 32px; }
    .title p { margin: 6px 0 0; color: var(--muted); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 14px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: .04em; }
    tr:hover td { background: rgba(255,255,255,.015); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .section { padding: 20px; margin-bottom: 20px; }
    .grid { display: grid; gap: 18px; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
    .status-item { display: flex; justify-content: space-between; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--border); }
    .status-item:last-child { border-bottom: 0; }
    .dot { font-size: 18px; }
    .ok { color: var(--green); } .bad { color: var(--accent); } .warn-text { color: #fde68a; }
    .login { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: #0f172a; }
    .login-card { width: 100%; max-width: 420px; padding: 28px; }
    .login-card h1 { margin: 0 0 8px; font-size: 30px; }
    .login-card p { color: var(--muted); margin: 0 0 22px; }
    .field { margin-bottom: 16px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    .spacer { flex: 1; }
    .modal { position: fixed; inset: 0; background: rgba(2,6,23,.84); display: none; align-items: center; justify-content: center; padding: 20px; }
    .modal.open { display: flex; }
    .modal-card { width: 100%; max-width: 520px; padding: 24px; background: var(--card); border: 1px solid var(--border); border-radius: 18px; }
    .reveal-value { background: #0f172a; border: 1px solid var(--border); border-radius: 14px; padding: 14px; color: var(--accent); font-size: 15px; word-break: break-all; }
    .countdown { margin-top: 10px; color: var(--muted); font-size: 14px; }
    .nav-shell { margin: -24px -24px 22px; background: #0a0e1a; border-bottom: 1px solid #1f2937; position: sticky; top: 0; z-index: 10; }
    .nav-scroll { display: flex; gap: 8px; overflow-x: auto; padding: 0 24px; }
    .nav-tab { padding: 16px 14px; border-bottom: 3px solid transparent; color: #9ca3af; white-space: nowrap; font-weight: 600; }
    .nav-tab.active { color: #e84c3d; border-bottom-color: #e84c3d; }
    .badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 700; }
    .badge.success { background: rgba(16,185,129,.14); color: #a7f3d0; }
    .badge.error { background: rgba(239,68,68,.14); color: #fecaca; }
    .badge.warn { background: rgba(245,158,11,.14); color: #fde68a; }
    .pill { border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; display: inline-block; }
    .pill.ok { background: rgba(16,185,129,.14); color: #a7f3d0; }
    .pill.warn { background: rgba(245,158,11,.14); color: #fde68a; }
    .pill.bad { background: rgba(239,68,68,.14); color: #fecaca; }
    .metric-card { padding: 18px; }
    .metric-value { font-size: 30px; font-weight: 700; margin: 8px 0 6px; }
    .progress { height: 10px; background: #0f172a; border-radius: 999px; overflow: hidden; border: 1px solid var(--border); }
    .progress > span { display: block; height: 100%; background: var(--green); }
    .progress > span.warn { background: var(--yellow); }
    .progress > span.bad { background: var(--red); }
    .log-box { background: #09111f; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; }
    .log-line { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.04); font-family: 'JetBrains Mono', monospace; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
    .log-line.error { background: rgba(239,68,68,.08); }
    .log-line.warn { background: rgba(245,158,11,.08); }
    .crumbs { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .crumbs a { color: #cbd5e1; }
    .file-row { display: flex; justify-content: space-between; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--border); }
    .file-row:last-child { border-bottom: 0; }
    .action-card { padding: 18px; }
    .action-card h3 { margin: 10px 0 8px; }
    .action-output { margin-top: 14px; display: none; }
    .action-output.open { display: block; }
    .action-pre { background: #09111f; border: 1px solid var(--border); padding: 14px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; font-family: 'JetBrains Mono', monospace; font-size: 13px; }
    .inline-note { padding: 12px 14px; border-radius: 12px; background: rgba(245,158,11,.09); border: 1px solid rgba(245,158,11,.24); color: #fde68a; }
    @media (max-width: 820px) {
      .wrap { padding: 16px; }
      .nav-shell { margin: -16px -16px 18px; }
      .nav-scroll { padding: 0 16px; }
      .topbar { flex-direction: column; align-items: flex-start; }
      .grid-2, .grid-3, .grid-4 { grid-template-columns: 1fr; }
      table, thead, tbody, th, td, tr { display: block; }
      thead { display: none; }
      tr { border: 1px solid var(--border); border-radius: 14px; margin-bottom: 12px; overflow: hidden; }
      td { border-bottom: 1px solid var(--border); }
      td:last-child { border-bottom: 0; }
      td::before { content: attr(data-label); display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; margin-bottom: 6px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    ${activeTab ? renderNav(activeTab) : ''}
    ${flashHtml}
    ${body}
  </div>
</body>
</html>`;
}

function renderLogin(errorMessage) {
  return layout('Credential Vault Login', `
    <div class="login" style="margin:-24px;">
      <div class="card login-card">
        <div style="font-size:40px; margin-bottom:12px;">🔒</div>
        <h1>Credential Vault</h1>
        <p>Unlock secure access to Neo's workspace credentials.</p>
        ${errorMessage ? `<div class="flash error">${escapeHtml(errorMessage)}</div>` : ''}
        <form method="POST" action="/login">
          <div class="field">
            <label for="password">Master Password</label>
            <input id="password" name="password" type="password" required autofocus />
          </div>
          <button class="btn primary" type="submit" style="width:100%;">Unlock</button>
        </form>
      </div>
    </div>
  `, null, '');
}

function renderForm(mode, values, flash) {
  const isEdit = mode === 'edit';
  const title = isEdit ? 'Edit Credential' : 'Add Credential';
  return layout(title, `
    <div class="topbar">
      <div class="title">
        <h1>${escapeHtml(title)}</h1>
        <p>${isEdit ? 'Update an existing secret without exposing it in logs.' : 'Add a new credential to the vault.'}</p>
      </div>
    </div>
    <div class="card section" style="max-width:720px;">
      <form method="POST" action="/save">
        <div class="field">
          <label for="agent">Agent</label>
          <select id="agent" name="agent">
            <option value="Neo" ${values.agent === 'Neo' ? 'selected' : ''}>Neo</option>
            <option value="Josh" ${values.agent === 'Josh' ? 'selected' : ''}>Josh</option>
            <option value="Shared" ${values.agent === 'Shared' ? 'selected' : ''}>Shared</option>
          </select>
        </div>
        <div class="field">
          <label for="key">Key Name</label>
          <input id="key" name="key" value="${escapeHtml(values.key)}" required placeholder="GITHUB_TOKEN" ${isEdit ? 'readonly' : ''} />
        </div>
        <div class="field">
          <label for="value">Value</label>
          <input id="value" name="value" type="password" value="${escapeHtml(values.value)}" required />
        </div>
        <div class="row">
          <button class="btn primary" type="submit">Save</button>
          <a class="btn" href="/">Cancel</a>
        </div>
      </form>
    </div>
  `, flash, 'credentials');
}

function renderDashboard(data, flash) {
  const rowsHtml = data.rows.length ? data.rows.map(row => `
    <tr>
      <td data-label="Agent">${escapeHtml(row.agent)}</td>
      <td data-label="Key Name"><span class="mono">${escapeHtml(row.key)}</span></td>
      <td data-label="Value"><span class="mono">${escapeHtml(row.maskedValue)}</span></td>
      <td data-label="Last Modified">${escapeHtml(formatDate(row.lastModified))}</td>
      <td data-label="Actions">
        <div class="actions">
          <button class="btn small" type="button" onclick="openReveal('${encodeURIComponent(row.key)}')">Reveal</button>
          <a class="btn small" href="/edit?key=${encodeURIComponent(row.key)}">Edit</a>
          <form method="POST" action="/delete" onsubmit="return confirm('Delete ${escapeHtml(row.key)}?');">
            <input type="hidden" name="key" value="${escapeHtml(row.key)}" />
            <button class="btn small" type="submit">Delete</button>
          </form>
        </div>
      </td>
    </tr>`).join('') : '<tr><td colspan="5" class="muted">No credentials found yet.</td></tr>';

  const scanHtml = data.scan.map(item => `
    <div class="status-item">
      <div>
        <div><span class="dot ${item.exists && item.readable ? 'ok' : 'bad'}">●</span> <span class="mono">${escapeHtml(shortenPath(item.filePath))}</span></div>
        <div class="muted">Modified: ${escapeHtml(formatDate(item.lastModified))}</div>
      </div>
      <div class="muted">${item.exists && item.readable ? 'Readable' : item.exists ? 'Unreadable' : 'Missing'} · ${item.credentialCount} credentials</div>
    </div>`).join('');

  return layout('Credential Vault', `
    <div class="topbar">
      <div class="title">
        <h1>Credential Vault</h1>
        <p>Neo's Workspace · Last updated ${escapeHtml(formatDate(data.lastUpdated))}</p>
      </div>
      <div class="row">
        <a class="btn green" href="/add">Add New Credential</a>
        <a class="btn" href="/logout">Lock</a>
      </div>
    </div>

    <div class="card section">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:14px;">
        <h2 style="margin:0;">Credentials</h2>
        <div class="muted">${data.rows.length} total</div>
      </div>
      <div style="overflow:auto;">
        <table>
          <thead>
            <tr><th>Agent</th><th>Key Name</th><th>Value</th><th>Last Modified</th><th>Actions</th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>

    <div class="card section">
      <h2 style="margin-top:0;">Sync Status</h2>
      ${scanHtml}
    </div>

    <div id="revealModal" class="modal" aria-hidden="true">
      <div class="modal-card">
        <div class="row" style="justify-content:space-between; align-items:center;">
          <h2 style="margin:0;">Reveal Credential</h2>
          <button class="btn small" type="button" onclick="closeReveal()">Close</button>
        </div>
        <p class="muted">Re-enter the master password to reveal this value for 30 seconds.</p>
        <input type="hidden" id="revealKey" />
        <div class="field">
          <label for="revealPassword">Master Password</label>
          <input id="revealPassword" type="password" />
        </div>
        <div class="row">
          <button class="btn primary" type="button" onclick="submitReveal()">Reveal</button>
        </div>
        <div id="revealError" class="flash error" style="display:none; margin-top:16px;"></div>
        <div id="revealResult" style="display:none; margin-top:16px;">
          <div class="reveal-value mono" id="revealValue"></div>
          <div class="countdown" id="revealCountdown"></div>
        </div>
      </div>
    </div>

    <script>
      let timer = null;
      function openReveal(key) {
        document.getElementById('revealKey').value = decodeURIComponent(key);
        document.getElementById('revealPassword').value = '';
        document.getElementById('revealError').style.display = 'none';
        document.getElementById('revealResult').style.display = 'none';
        document.getElementById('revealModal').classList.add('open');
      }
      function closeReveal() {
        document.getElementById('revealModal').classList.remove('open');
        document.getElementById('revealResult').style.display = 'none';
        if (timer) clearInterval(timer);
      }
      async function submitReveal() {
        const key = document.getElementById('revealKey').value;
        const password = document.getElementById('revealPassword').value;
        const error = document.getElementById('revealError');
        const result = document.getElementById('revealResult');
        error.style.display = 'none';
        const resp = await fetch('/reveal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ key, password }).toString()
        });
        const data = await resp.json();
        if (!resp.ok) {
          error.textContent = data.error || 'Reveal failed';
          error.style.display = 'block';
          return;
        }
        result.style.display = 'block';
        document.getElementById('revealValue').textContent = data.value;
        let remaining = 30;
        document.getElementById('revealCountdown').textContent = 'Auto-hides in ' + remaining + 's';
        if (timer) clearInterval(timer);
        timer = setInterval(() => {
          remaining -= 1;
          document.getElementById('revealCountdown').textContent = 'Auto-hides in ' + remaining + 's';
          if (remaining <= 0) {
            clearInterval(timer);
            timer = null;
            document.getElementById('revealValue').textContent = '••••••••';
            document.getElementById('revealCountdown').textContent = 'Hidden again';
          }
        }, 1000);
      }
    </script>
  `, flash, 'credentials');
}

function safeExec(command, options = {}) {
  try {
    return {
      success: true,
      output: execSync(command, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim(),
    };
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim();
    return { success: false, output: output || 'Command failed' };
  }
}

function getTodayDateString(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function getOpenClawLogPath(offsetDays = 0) {
  return `/tmp/openclaw/openclaw-${getTodayDateString(offsetDays)}.log`;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getOpenClawBotToken() {
  try {
    const config = readJsonFile('/home/node/.openclaw/openclaw.json');
    return config?.channels?.telegram?.botToken || '';
  } catch {
    return '';
  }
}

function getGitHubTokenFromCredentials() {
  try {
    const content = fs.readFileSync(PRIMARY_CREDENTIALS_FILE, 'utf8');
    const match = content.match(/github_pat_[A-Za-z0-9_]+/);
    return match ? match[0] : '';
  } catch {
    return '';
  }
}

function parseOpenClawProcesses() {
  const result = safeExec('ps aux');
  if (!result.success) return [];
  return result.output.split(/\r?\n/).slice(1).map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) return null;
    const command = parts.slice(10).join(' ');
    if (!/openclaw|openclaw-gateway/i.test(command)) return null;
    return {
      user: parts[0], pid: parts[1], cpu: parts[2], mem: parts[3], stat: parts[7], command,
      name: command.includes('openclaw-gateway') ? 'openclaw-gateway' : 'openclaw',
      logFile: getOpenClawLogPath(0),
    };
  }).filter(Boolean);
}

function parseCronJobs() {
  const result = safeExec('openclaw cron list --json');
  if (!result.success) return { jobs: [], error: result.output };
  try {
    const parsed = JSON.parse(result.output || '[]');
    const jobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : [];
    return { jobs, error: '' };
  } catch {
    return { jobs: [], error: 'Failed to parse cron JSON output.' };
  }
}

function formatCronJob(job) {
  return {
    id: String(job.id ?? job.name ?? ''),
    name: String(job.name ?? job.id ?? 'Unnamed Job'),
    schedule: String(job.schedule ?? job.cron ?? '—'),
    model: String(job.model ?? job.agentModel ?? job.defaultModel ?? '—'),
    lastRun: String(job.lastRun ?? job.last_run ?? '—'),
    nextRun: String(job.nextRun ?? job.next_run ?? '—'),
    enabled: typeof job.enabled === 'boolean' ? job.enabled : !/disabled/i.test(String(job.status || 'enabled')),
    status: String(job.status ?? (job.enabled === false ? 'disabled' : 'enabled')),
  };
}

function parseMemInfo() {
  const raw = fs.readFileSync('/proc/meminfo', 'utf8');
  const map = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_()]+):\s+(\d+)/);
    if (m) map[m[1]] = Number(m[2]);
  }
  const totalMb = Math.round((map.MemTotal || 0) / 1024);
  const availableMb = Math.round((map.MemAvailable || 0) / 1024);
  const usedMb = totalMb - availableMb;
  const usedPct = totalMb ? Math.round((usedMb / totalMb) * 100) : 0;
  return { totalMb, availableMb, usedMb, usedPct, raw };
}

function parseLoadAvg() {
  const raw = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
  return { one: raw[0] || '0', five: raw[1] || '0', fifteen: raw[2] || '0' };
}

function parseDiskRoot() {
  const result = safeExec('df -h /');
  if (!result.success) return { used: '—', avail: '—', pct: 0, output: result.output };
  const lines = result.output.split(/\r?\n/);
  const parts = (lines[1] || '').trim().split(/\s+/);
  return { used: parts[2] || '—', avail: parts[3] || '—', pct: Number(String(parts[4] || '0').replace('%', '')) || 0, output: result.output };
}

function formatUptime() {
  const seconds = Math.floor(Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0] || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function extractLocalIp() {
  try {
    const raw = fs.readFileSync('/proc/net/fib_trie', 'utf8');
    const matches = raw.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
    const ip = matches.find(value => value !== '127.0.0.1' && !value.startsWith('0.') && !value.startsWith('255.')) || 'Unavailable';
    return ip;
  } catch {
    return 'Unavailable';
  }
}

function parseJsonLogLine(line) {
  try {
    const obj = JSON.parse(line);
    const message = obj['0'] || obj.message || obj.msg || JSON.stringify(obj);
    const levelId = Number(obj?._meta?.logLevelId ?? obj.level ?? 0);
    const time = obj.time || obj.timestamp || obj.ts || obj?._meta?.time || '';
    return { message: String(message), levelId, time: String(time || '') };
  } catch {
    const upper = line.toUpperCase();
    const levelId = upper.includes('ERROR') ? 5 : upper.includes('WARN') ? 4 : 3;
    return { message: line, levelId, time: '' };
  }
}

function readTailLines(filePath, lineCount) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split(/\r?\n/).filter(Boolean).slice(-lineCount);
}

function getRecentErrors() {
  const files = [getOpenClawLogPath(-1), getOpenClawLogPath(0)];
  const errors = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const parsed = parseJsonLogLine(line);
      const messageLc = parsed.message.toLowerCase();
      if (parsed.levelId < 5) continue;
      if (LOG_NOISE_PATTERNS.some(p => messageLc.includes(p))) continue;
      errors.push({ time: parsed.time || new Date(fs.statSync(file).mtime).toISOString(), message: parsed.message.slice(0, 80) });
    }
  }
  return errors.slice(-10).reverse();
}

function getLogOptions() {
  const options = [
    { id: 'neo-today', label: 'Neo Today', path: getOpenClawLogPath(0) },
    { id: 'neo-yesterday', label: 'Neo Yesterday', path: getOpenClawLogPath(-1) },
    { id: 'credvault-access', label: 'Credvault Access', path: '/tmp/credvault-access.log' },
  ];
  if (fs.existsSync('/tmp/dashboard-refresh.log')) options.push({ id: 'dashboard-refresh', label: 'Dashboard Refresh', path: '/tmp/dashboard-refresh.log' });
  return options;
}

function getLogFileById(id) {
  return getLogOptions().find(item => item.id === id) || getLogOptions()[0];
}

function formatLogLine(line) {
  const parsed = parseJsonLogLine(line);
  const level = parsed.levelId >= 5 ? 'error' : parsed.levelId === 4 ? 'warn' : 'info';
  const text = `${parsed.time ? `[${parsed.time}] ` : ''}${parsed.message}`;
  return { level, text };
}

function sanitizeWorkspacePath(inputPath) {
  const relative = String(inputPath || '').replace(/^\/+/, '');
  const resolved = path.resolve(WORKSPACE_ROOT, relative);
  if (!resolved.startsWith(WORKSPACE_ROOT)) return null;
  return resolved;
}

function isBlockedFileName(name) {
  return name === '.git' || name === 'auth.json' || name === 'node_modules' || name.endsWith('.bak');
}

function isBlockedPath(filePath) {
  const base = path.basename(filePath);
  return /(^|\/)\.git(\/|$)/.test(filePath) || /(^|\/)node_modules(\/|$)/.test(filePath) || base === 'auth.json' || base.endsWith('.bak');
}

function relativeWorkspacePath(fullPath) {
  return path.relative(WORKSPACE_ROOT, fullPath) || '';
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)$/);
        if (!boundaryMatch) return resolve({ fields: {}, files: [] });
        const boundary = `--${boundaryMatch[1]}`;
        const body = Buffer.concat(chunks).toString('binary');
        const parts = body.split(boundary).slice(1, -1);
        const fields = {};
        const files = [];
        for (const part of parts) {
          const idx = part.indexOf('\r\n\r\n');
          if (idx === -1) continue;
          const header = part.slice(0, idx);
          let content = part.slice(idx + 4);
          content = content.replace(/\r\n$/, '');
          const nameMatch = header.match(/name="([^"]+)"/);
          if (!nameMatch) continue;
          const filenameMatch = header.match(/filename="([^"]*)"/);
          if (filenameMatch) {
            files.push({ fieldName: nameMatch[1], filename: path.basename(filenameMatch[1]), content: Buffer.from(content, 'binary') });
          } else {
            fields[nameMatch[1]] = Buffer.from(content, 'binary').toString('utf8');
          }
        }
        resolve({ fields, files });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function getHealthColor(value, warnAt, badAt) {
  if (value >= badAt) return 'bad';
  if (value >= warnAt) return 'warn';
  return 'ok';
}

function renderAgentsPage(flash) {
  const processes = parseOpenClawProcesses();
  const { jobs, error } = parseCronJobs();
  const cronJobs = jobs.map(formatCronJob);
  const processRows = processes.length ? processes.map(proc => `
    <tr>
      <td data-label="Process">${escapeHtml(proc.name)}</td>
      <td data-label="PID"><span class="mono">${escapeHtml(proc.pid)}</span></td>
      <td data-label="CPU">${escapeHtml(proc.cpu)}%</td>
      <td data-label="Memory">${escapeHtml(proc.mem)}%</td>
      <td data-label="Status"><span class="mono">${escapeHtml(proc.stat)}</span></td>
      <td data-label="Actions">
        <div class="actions">
          <form method="POST" action="/agents/restart" onsubmit="return confirm('Restart PID ${escapeHtml(proc.pid)}? This may be disruptive.');">
            <input type="hidden" name="pid" value="${escapeHtml(proc.pid)}" />
            <button class="btn small warn" type="submit">Restart</button>
          </form>
          <a class="btn small" href="/logs?log=neo-today&lines=100">View Logs</a>
        </div>
      </td>
    </tr>`).join('') : '<tr><td colspan="6" class="muted">No OpenClaw processes found.</td></tr>';

  const cronRows = cronJobs.length ? cronJobs.map(job => `
    <tr>
      <td data-label="Name">${escapeHtml(job.name)}</td>
      <td data-label="Schedule"><span class="mono">${escapeHtml(job.schedule)}</span></td>
      <td data-label="Model">${escapeHtml(job.model)}</td>
      <td data-label="Last Run">${escapeHtml(job.lastRun)}</td>
      <td data-label="Next Run">${escapeHtml(job.nextRun)}</td>
      <td data-label="Status"><span class="pill ${job.enabled ? 'ok' : 'bad'}">${job.enabled ? 'enabled' : 'disabled'}</span></td>
      <td data-label="Actions">
        <div class="actions">
          <form method="POST" action="/agents/cron/run">
            <input type="hidden" name="id" value="${escapeHtml(job.id)}" />
            <button class="btn small" type="submit">Run Now</button>
          </form>
          <form method="POST" action="/agents/cron/toggle">
            <input type="hidden" name="id" value="${escapeHtml(job.id)}" />
            <input type="hidden" name="enabled" value="${job.enabled ? '1' : '0'}" />
            <button class="btn small" type="submit">${job.enabled ? 'Disable' : 'Enable'}</button>
          </form>
        </div>
      </td>
    </tr>`).join('') : `<tr><td colspan="7" class="muted">${escapeHtml(error || 'No cron jobs found.')}</td></tr>`;

  return layout('Agent Manager', `
    <div class="topbar">
      <div class="title">
        <h1>Agent Manager</h1>
        <p>Manage running OpenClaw processes, cron jobs, and new agent workspaces.</p>
      </div>
      <a class="btn" href="/logout">Lock</a>
    </div>

    <div class="inline-note" style="margin-bottom:20px;">Restarts are managed by OpenClaw's supervisor. This may be disruptive.</div>

    <div class="card section">
      <h2 style="margin-top:0;">Running Processes</h2>
      <div style="overflow:auto;"><table><thead><tr><th>Process</th><th>PID</th><th>CPU</th><th>Memory</th><th>Status</th><th>Actions</th></tr></thead><tbody>${processRows}</tbody></table></div>
    </div>

    <div class="card section">
      <h2 style="margin-top:0;">Cron Jobs</h2>
      <div style="overflow:auto;"><table><thead><tr><th>Name</th><th>Schedule</th><th>Model</th><th>Last Run</th><th>Next Run</th><th>Status</th><th>Actions</th></tr></thead><tbody>${cronRows}</tbody></table></div>
    </div>

    <div class="card section">
      <h2 style="margin-top:0;">Deploy New Agent</h2>
      <form method="POST" action="/agents/deploy">
        <div class="grid-2">
          <div class="field"><label for="agentName">Agent Name</label><input id="agentName" name="agentName" required placeholder="FamilyOps" /></div>
          <div class="field"><label for="whoFor">Who is it for</label><input id="whoFor" name="whoFor" required placeholder="Josh" /></div>
          <div class="field"><label for="model">Which model</label>
            <select id="model" name="model">
              <option>Claude Sonnet 4.6</option>
              <option>GPT-5.4 OAuth</option>
              <option>MiniMax M2.5</option>
              <option>Gemini Flash</option>
            </select>
          </div>
          <div class="field"><label for="telegramToken">Telegram bot token</label><input id="telegramToken" name="telegramToken" type="password" /></div>
        </div>
        <div class="field"><label for="workspacePath">Workspace path</label><input id="workspacePath" name="workspacePath" placeholder="/home/node/.openclaw/workspace-familyops" /></div>
        <button class="btn primary" type="submit">Create Agent Workspace</button>
      </form>
    </div>
  `, flash, 'agents');
}

function renderHealthPage(flash) {
  const mem = parseMemInfo();
  const load = parseLoadAvg();
  const disk = parseDiskRoot();
  const uptime = formatUptime();
  const processes = parseOpenClawProcesses();
  const cronJobs = parseCronJobs().jobs.map(formatCronJob);
  const errors = getRecentErrors();
  const memColor = getHealthColor(mem.usedPct, 70, 85);
  const diskColor = getHealthColor(disk.pct, 65, 80);
  const loadColor = getHealthColor(Number(load.one), 1, 2);
  const processRows = processes.length ? processes.map(proc => `<tr><td data-label="Process">${escapeHtml(proc.name)}</td><td data-label="PID">${escapeHtml(proc.pid)}</td><td data-label="CPU">${escapeHtml(proc.cpu)}%</td><td data-label="Memory">${escapeHtml(proc.mem)}%</td><td data-label="Status">${escapeHtml(proc.stat)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">No OpenClaw processes found.</td></tr>';
  const errorRows = errors.length ? errors.map(err => `<tr><td data-label="Time">${escapeHtml(err.time)}</td><td data-label="Message" class="mono">${escapeHtml(err.message)}</td></tr>`).join('') : '<tr><td colspan="2"><span class="badge success">No errors in last 24h</span></td></tr>';
  const cronRows = cronJobs.length ? cronJobs.map(job => `<tr><td data-label="Name">${escapeHtml(job.name)}</td><td data-label="Schedule"><span class="mono">${escapeHtml(job.schedule)}</span></td><td data-label="Next Run">${escapeHtml(job.nextRun)}</td><td data-label="Status"><span class="pill ${job.enabled ? 'ok' : 'bad'}">${job.enabled ? 'enabled' : 'disabled'}</span></td></tr>`).join('') : '<tr><td colspan="4" class="muted">No cron jobs found.</td></tr>';

  return layout('System Health', `
    <div class="topbar">
      <div class="title">
        <h1>System Health</h1>
        <p>Auto-refreshing infrastructure view every 30 seconds.</p>
      </div>
    </div>

    <div class="grid-3" style="margin-bottom:20px;">
      <div class="card metric-card"><div class="muted">Memory</div><div class="metric-value">${mem.usedPct}%</div><div class="progress"><span class="${memColor}" style="width:${mem.usedPct}%;"></span></div></div>
      <div class="card metric-card"><div class="muted">Disk</div><div class="metric-value">${disk.pct}%</div><div class="progress"><span class="${diskColor}" style="width:${disk.pct}%;"></span></div></div>
      <div class="card metric-card"><div class="muted">Load Avg 1m</div><div class="metric-value">${escapeHtml(load.one)}</div><div class="pill ${loadColor}" style="margin-top:10px;">${loadColor.toUpperCase()}</div></div>
    </div>

    <div class="grid-2">
      <div class="card section">
        <h2 style="margin-top:0;">Server Stats</h2>
        <div class="status-item"><div>Memory</div><div>${mem.usedMb} MB / ${mem.totalMb} MB used</div></div>
        <div class="status-item"><div>CPU Load</div><div>${escapeHtml(load.one)} · ${escapeHtml(load.five)} · ${escapeHtml(load.fifteen)}</div></div>
        <div class="status-item"><div>Disk</div><div>${escapeHtml(disk.used)} used / ${escapeHtml(disk.avail)} free</div></div>
        <div class="status-item"><div>Uptime</div><div>${escapeHtml(uptime)}</div></div>
      </div>
      <div class="card section">
        <h2 style="margin-top:0;">Network</h2>
        <div class="status-item"><div>Hostname</div><div>${escapeHtml(os.hostname())}</div></div>
        <div class="status-item"><div>IP</div><div class="mono">${escapeHtml(extractLocalIp())}</div></div>
        <div class="inline-note" style="margin-top:14px;">Tailscale interface not active in this container. Access via host Tailscale.</div>
      </div>
    </div>

    <div class="card section">
      <h2 style="margin-top:0;">OpenClaw Processes</h2>
      <div style="overflow:auto;"><table><thead><tr><th>Process</th><th>PID</th><th>CPU</th><th>Memory</th><th>Status</th></tr></thead><tbody>${processRows}</tbody></table></div>
    </div>

    <div class="card section">
      <h2 style="margin-top:0;">Recent Errors</h2>
      <div style="overflow:auto;"><table><thead><tr><th>Time</th><th>Message</th></tr></thead><tbody>${errorRows}</tbody></table></div>
    </div>

    <div class="card section">
      <h2 style="margin-top:0;">Cron Jobs</h2>
      <div style="overflow:auto;"><table><thead><tr><th>Name</th><th>Schedule</th><th>Next Run</th><th>Status</th></tr></thead><tbody>${cronRows}</tbody></table></div>
    </div>
  `, flash, 'health', '<meta http-equiv="refresh" content="30">');
}

function renderLogsPage(req, flash) {
  const selected = String(req.query.log || 'neo-today');
  const linesCount = [50, 100, 200, 500].includes(Number(req.query.lines)) ? Number(req.query.lines) : 100;
  const filter = String(req.query.filter || '');
  const autorefresh = req.query.autorefresh === '1';
  const current = getLogFileById(selected);
  const rawLines = current && fs.existsSync(current.path) ? readTailLines(current.path, linesCount) : [];
  const formatted = rawLines.map(formatLogLine);
  const lineHtml = formatted.map(item => `<div class="log-line ${item.level}" data-line="${escapeHtml(item.text.toLowerCase())}">${escapeHtml(item.text)}</div>`).join('') || '<div class="log-line">No log lines found.</div>';
  const options = getLogOptions().map(option => `<option value="${option.id}" ${option.id === selected ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
  const lineOptions = [50, 100, 200, 500].map(count => `<option value="${count}" ${count === linesCount ? 'selected' : ''}>${count}</option>`).join('');
  const extraHead = autorefresh ? '<meta http-equiv="refresh" content="10">' : '';
  return layout('Log Viewer', `
    <div class="topbar">
      <div class="title"><h1>Log Viewer</h1><p>Inspect application logs without leaving the panel.</p></div>
    </div>
    <div class="card section">
      <form method="GET" action="/logs">
        <div class="grid-4">
          <div class="field"><label>Log File</label><select name="log">${options}</select></div>
          <div class="field"><label>Lines</label><select name="lines">${lineOptions}</select></div>
          <div class="field"><label>Search / Filter</label><input id="filterBox" name="filter" value="${escapeHtml(filter)}" placeholder="error, cron, gateway..." /></div>
          <div class="field"><label>&nbsp;</label><div class="row"><button class="btn primary" type="submit">Refresh</button><label style="display:flex;align-items:center;gap:8px;margin:0;"><input type="checkbox" name="autorefresh" value="1" ${autorefresh ? 'checked' : ''} style="width:auto;"> Auto-refresh</label></div></div>
        </div>
      </form>
      <div style="margin-top:12px;" class="muted">Raw endpoint: <a class="mono" href="/logs/raw?file=${encodeURIComponent(selected)}&lines=${linesCount}">/logs/raw</a></div>
      <div class="log-box" id="logBox" style="margin-top:16px; max-height:65vh; overflow:auto;">${lineHtml}</div>
    </div>
    <script>
      const filterBox = document.getElementById('filterBox');
      function applyFilter() {
        const needle = (filterBox.value || '').toLowerCase();
        document.querySelectorAll('.log-line').forEach(line => {
          line.style.display = !needle || line.dataset.line.includes(needle) ? '' : 'none';
        });
      }
      filterBox.addEventListener('input', applyFilter);
      applyFilter();
    </script>
  `, flash, 'logs', extraHead);
}

function renderFilesPage(targetPath, flash) {
  const relPath = relativeWorkspacePath(targetPath);
  const crumbs = ['<a href="/files">workspace</a>'];
  let currentAcc = '';
  for (const part of relPath.split(path.sep).filter(Boolean)) {
    currentAcc = currentAcc ? path.join(currentAcc, part) : part;
    crumbs.push(`<span>/</span><a href="/files?path=${encodeURIComponent(currentAcc)}">${escapeHtml(part)}</a>`);
  }

  if (!fs.existsSync(targetPath)) {
    return layout('File Manager', `<div class="card section"><h1>File Manager</h1><div class="flash error">Path not found.</div></div>`, flash, 'files');
  }

  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(targetPath, { withFileTypes: true })
      .filter(entry => !isBlockedFileName(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const parentRel = relPath ? path.dirname(relPath) === '.' ? '' : path.dirname(relPath) : '';
    const rows = [relPath ? `<div class="file-row"><div>📁 <a href="/files?path=${encodeURIComponent(parentRel)}">..</a></div><div class="muted">parent</div></div>` : '']
      .concat(entries.map(entry => {
        const childRel = path.join(relPath, entry.name);
        return `<div class="file-row"><div>${entry.isDirectory() ? '📁' : '📄'} <a href="/files?path=${encodeURIComponent(childRel)}">${escapeHtml(entry.name)}</a></div><div class="muted">${entry.isDirectory() ? 'folder' : 'file'}</div></div>`;
      })).join('');

    return layout('File Manager', `
      <div class="topbar"><div class="title"><h1>File Manager</h1><p>Browse the workspace safely. Root is locked to /home/node/.openclaw/workspace.</p></div></div>
      <div class="card section">
        <div class="crumbs">${crumbs.join('')}</div>
      </div>
      <div class="card section">
        <h2 style="margin-top:0;">Directory Listing</h2>
        ${rows || '<div class="muted">Folder is empty.</div>'}
      </div>
      <div class="card section">
        <h2 style="margin-top:0;">Upload File</h2>
        <form method="POST" action="/files/upload" enctype="multipart/form-data">
          <input type="hidden" name="path" value="${escapeHtml(relPath)}" />
          <div class="field"><label>Select File</label><input type="file" name="upload" required /></div>
          <button class="btn primary" type="submit">Upload</button>
        </form>
      </div>
    `, flash, 'files');
  }

  const content = fs.readFileSync(targetPath, 'utf8');
  return layout('File Manager', `
    <div class="topbar"><div class="title"><h1>File Viewer</h1><p>${escapeHtml(relPath || path.basename(targetPath))}</p></div></div>
    <div class="card section"><div class="crumbs">${crumbs.join('')}</div></div>
    <div class="card section">
      <form method="POST" action="/files/save" onsubmit="return document.getElementById('enableEditing').checked ? confirm('Save changes to ${escapeHtml(relPath)}?') : false;">
        <input type="hidden" name="path" value="${escapeHtml(relPath)}" />
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;"><input type="checkbox" id="enableEditing" style="width:auto;"> Enable editing</label>
        <textarea id="fileContent" name="content" class="mono" readonly>${escapeHtml(content)}</textarea>
        <div class="row" style="margin-top:14px;">
          <button id="saveBtn" class="btn primary" type="submit" style="display:none;">Save</button>
          <a class="btn" href="/files?path=${encodeURIComponent(path.dirname(relPath) === '.' ? '' : path.dirname(relPath))}">Back</a>
        </div>
      </form>
    </div>
    <script>
      const toggle = document.getElementById('enableEditing');
      const area = document.getElementById('fileContent');
      const saveBtn = document.getElementById('saveBtn');
      toggle.addEventListener('change', () => {
        area.readOnly = !toggle.checked;
        saveBtn.style.display = toggle.checked ? 'inline-flex' : 'none';
      });
    </script>
  `, flash, 'files');
}

function renderActionsPage(flash) {
  const actions = [
    ['💽', 'Check Disk Usage', 'Disk utilization and mount summary.', '/actions/disk'],
    ['⏱️', 'View Cron Jobs', 'Current cron jobs and schedules.', '/actions/cron-list'],
    ['🔄', 'Run Dashboard Refresh', 'Executes dashboard-update.py.', '/actions/dashboard-refresh'],
    ['📦', 'Run Backup Now', 'Git add/commit/push using GitHub token from credentials.', '/actions/backup'],
    ['📨', 'Test Telegram', 'Sends a test message to Boss via Telegram Bot API.', '/actions/test-telegram'],
    ['🔑', 'Check API Keys', 'Verifies Anthropic API key with a lightweight models request.', '/actions/check-keys'],
    ['🧹', 'Clear Temp Files', 'Deletes old /tmp/*.log files older than 24h.', '/actions/clear-tmp'],
    ['🧠', 'Memory Usage', 'Formatted /proc/meminfo summary.', '/actions/memory'],
    ['⚙️', 'OpenClaw Status', 'Runs openclaw gateway status.', '/actions/oc-status'],
    ['🚪', 'Restart Credvault', 'Runs credvault stop.sh then start.sh.', '/actions/restart-credvault'],
  ];
  const cards = actions.map(([icon, title, desc, endpoint], index) => `
    <div class="card action-card">
      <div style="font-size:28px;">${icon}</div>
      <h3>${escapeHtml(title)}</h3>
      <p class="muted">${escapeHtml(desc)}</p>
      <button class="btn primary" type="button" onclick="runAction('${endpoint}', this, 'result-${index}')">Run</button>
      <div id="result-${index}" class="action-output"></div>
    </div>`).join('');

  return layout('Quick Actions', `
    <div class="topbar"><div class="title"><h1>Quick Actions</h1><p>Run common maintenance and operational tasks.</p></div></div>
    <div class="grid-3">${cards}</div>
    <div class="card section" style="margin-top:20px;">
      <h2 style="margin-top:0;">Docker Actions</h2>
      <div class="inline-note">Docker commands are not available in this container. To enable Docker management, redeploy the admin panel on the host with: <span class="mono">-v /var/run/docker.sock:/var/run/docker.sock</span></div>
    </div>
    <script>
      async function runAction(endpoint, buttonEl, resultId) {
        const resultEl = document.getElementById(resultId);
        buttonEl.disabled = true;
        buttonEl.textContent = 'Running...';
        resultEl.classList.add('open');
        resultEl.innerHTML = '<div class="muted">Working...</div>';
        try {
          const resp = await fetch(endpoint, { method: 'POST' });
          const data = await resp.json();
          const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const badgeCls = data.success ? 'success' : 'error';
          const badgeTxt = data.success ? 'SUCCESS' : 'FAILED';
          resultEl.innerHTML = '<div class="badge ' + badgeCls + '">' + badgeTxt + '</div>' +
            '<div class="muted" style="margin:8px 0;">' + esc(data.timestamp) + '</div>' +
            '<pre class="action-pre">' + esc(data.output) + '</pre>';
        } catch (error) {
          resultEl.innerHTML = '<div class="badge error">FAILED</div><pre class="action-pre">' + String(error.message || error) + '</pre>';
        } finally {
          buttonEl.disabled = false;
          buttonEl.textContent = 'Run';
        }
      }
    </script>
  `, flash, 'actions');
}

function renderOnboardingPage(flash) {
  return layout('Agent Onboarding', `
    <div class="topbar"><div class="title"><h1>Agent Onboarding</h1><p>This panel will let you deploy agents for friends and family without touching the terminal.</p></div></div>
    <div class="card section">
      <h2 style="margin-top:0;">Coming Soon</h2>
      <ul>
        <li>Guided agent workspace creation</li>
        <li>Model and channel setup</li>
        <li>Telegram bot provisioning flow</li>
        <li>Role templates for family and business use</li>
        <li>Deployment checklist and supervisor integration</li>
      </ul>
    </div>
    <div class="card section">
      <h2 style="margin-top:0;">Preview Form</h2>
      <div class="grid-2">
        <div class="field"><label>Agent Name</label><input disabled placeholder="Mom Helper" /></div>
        <div class="field"><label>Who is it for</label><input disabled placeholder="Mom" /></div>
        <div class="field"><label>Model</label><select disabled><option>Claude Sonnet 4.6</option></select></div>
        <div class="field"><label>Telegram Bot Token</label><input disabled type="password" placeholder="••••••••" /></div>
      </div>
      <button class="btn" disabled>Deploy Agent</button>
    </div>
  `, flash, 'onboarding');
}

function jsonAction(res, success, output) {
  res.json({ success, output, timestamp: new Date().toISOString() });
}

app.get('/login', (req, res) => {
  if (getSession(req)) return redirect(res, '/');
  const flash = consumeFlash(req, res);
  res.send(renderLogin(flash && flash.type === 'error' ? flash.message : ''));
});

app.post('/login', (req, res) => {
  const ip = getIp(req);
  if (!canAttemptLogin(ip)) {
    logAccess(req, 'LOGIN_BLOCKED', 'rate limited');
    return res.status(429).send(renderLogin('Too many failed attempts. Locked out for 15 minutes.'));
  }
  const password = String(req.body.password || '');
  if (!verifyPassword(password)) {
    recordLoginFailure(ip);
    const attempts = (loginAttempts.get(ip) || []).length;
    logAccess(req, 'LOGIN_FAILED', `attempt ${attempts}/${LOGIN_MAX_ATTEMPTS}`);
    return res.status(401).send(renderLogin(`Incorrect password. ${LOGIN_MAX_ATTEMPTS - attempts} attempt(s) remaining.`));
  }
  clearLoginAttempts(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now(), lastActivity: Date.now(), ip });
  setCookie(res, 'credvault_session', token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000) });
  logAccess(req, 'LOGIN_OK', 'session started');
  redirect(res, '/');
});

app.get('/logout', (req, res) => {
  const token = parseCookies(req).credvault_session;
  if (token) sessions.delete(token);
  clearCookie(res, 'credvault_session');
  logAccess(req, 'LOGOUT', '');
  redirect(res, '/login');
});

app.get('/status', (_req, res) => {
  const parsed = parseFileEntries(PRIMARY_CREDENTIALS_FILE);
  const authConfigured = fs.existsSync(AUTH_FILE);
  res.json({
    credentialsFile: PRIMARY_CREDENTIALS_FILE,
    exists: parsed.exists,
    readable: parsed.readable,
    lastModified: parsed.stats ? parsed.stats.mtime.toISOString() : null,
    credentialCount: parsed.entries.length,
    authConfigured,
  });
});

app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/status') return next();
  requireAuth(req, res, next);
});

app.get('/', (req, res) => {
  const flash = consumeFlash(req, res);
  res.send(renderDashboard(collectDashboardData(), flash));
});

app.get('/add', (req, res) => {
  const flash = consumeFlash(req, res);
  res.send(renderForm('add', { agent: 'Neo', key: '', value: '' }, flash));
});

app.get('/edit', (req, res) => {
  const flash = consumeFlash(req, res);
  const key = String(req.query.key || '');
  const parsed = parseFileEntries(PRIMARY_CREDENTIALS_FILE);
  const found = parsed.entries.find(entry => entry.key === key);
  if (!found) {
    setFlash(res, 'error', 'Credential not found.');
    return redirect(res, '/');
  }
  const agent = /shared/i.test(found.section) ? 'Shared' : 'Neo';
  res.send(renderForm('edit', { agent, key: found.key, value: found.value }, flash));
});

app.post('/save', (req, res) => {
  const agent = ['Neo', 'Josh', 'Shared'].includes(req.body.agent) ? req.body.agent : 'Neo';
  const key = String(req.body.key || '').trim();
  const value = String(req.body.value || '');
  if (!key || !/^[A-Za-z0-9_.-]+$/.test(key)) {
    setFlash(res, 'error', 'Key name is required and may only contain letters, numbers, dot, underscore, or dash.');
    return redirect(res, '/add');
  }
  if (!value) {
    setFlash(res, 'error', 'Credential value is required.');
    return redirect(res, key ? `/edit?key=${encodeURIComponent(key)}` : '/add');
  }
  saveCredential(agent, key, value);
  logAccess(req, 'CREDENTIAL_SAVED', `key=${key} agent=${agent}`);
  const needsRestart = ENV_VAR_KEYS.has(key.toUpperCase());
  const restartNote = needsRestart ? ' ⚠️ This key is a container environment variable — a container restart may be required for it to take effect.' : '';
  setFlash(res, needsRestart ? 'warn' : 'success', `Saved ${key} for ${agent}.${restartNote}`);
  redirect(res, '/');
});

app.post('/delete', (req, res) => {
  const key = String(req.body.key || '').trim();
  if (!key) {
    setFlash(res, 'error', 'Missing key to delete.');
    return redirect(res, '/');
  }
  deleteCredential(key);
  logAccess(req, 'CREDENTIAL_DELETED', `key=${key}`);
  setFlash(res, 'success', `Deleted ${key}.`);
  redirect(res, '/');
});

app.post('/reveal', (req, res) => {
  const key = String(req.body.key || '').trim();
  const password = String(req.body.password || '');
  if (!verifyPassword(password)) return res.status(401).json({ error: 'Invalid password.' });
  const parsed = parseFileEntries(PRIMARY_CREDENTIALS_FILE);
  const found = parsed.entries.find(entry => entry.key === key);
  if (!found) return res.status(404).json({ error: 'Credential not found.' });
  res.json({ value: found.value, expiresIn: 30 });
});

app.get('/agents', (req, res) => {
  const flash = consumeFlash(req, res);
  res.send(renderAgentsPage(flash));
});

app.post('/agents/restart', (req, res) => {
  const pid = String(req.body.pid || '').trim();
  if (!/^\d+$/.test(pid)) {
    setFlash(res, 'error', 'Invalid PID.');
    return redirect(res, '/agents');
  }
  const result = safeExec(`kill -HUP ${pid}`);
  logAccess(req, 'AGENT_RESTART', `pid=${pid} success=${result.success}`);
  setFlash(res, result.success ? 'success' : 'error', result.success ? `Sent HUP to PID ${pid}.` : result.output);
  redirect(res, '/agents');
});

app.post('/agents/cron/run', (req, res) => {
  const id = String(req.body.id || '').trim();
  const result = safeExec(`openclaw cron run ${JSON.stringify(id)}`);
  logAccess(req, 'CRON_RUN', `id=${id} success=${result.success}`);
  setFlash(res, result.success ? 'success' : 'error', result.success ? `Triggered cron job ${id}.` : result.output);
  redirect(res, '/agents');
});

app.post('/agents/cron/toggle', (req, res) => {
  const id = String(req.body.id || '').trim();
  const enabled = String(req.body.enabled || '') === '1';
  const action = enabled ? 'disable' : 'enable';
  const result = safeExec(`openclaw cron ${action} ${JSON.stringify(id)}`);
  logAccess(req, 'CRON_TOGGLE', `id=${id} action=${action} success=${result.success}`);
  setFlash(res, result.success ? 'success' : 'error', result.success ? `${action === 'disable' ? 'Disabled' : 'Enabled'} cron job ${id}.` : result.output);
  redirect(res, '/agents');
});

app.post('/agents/deploy', (req, res) => {
  const agentName = String(req.body.agentName || '').trim();
  const whoFor = String(req.body.whoFor || '').trim();
  const model = String(req.body.model || '').trim();
  const telegramToken = String(req.body.telegramToken || '').trim();
  let workspacePath = String(req.body.workspacePath || '').trim();
  const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  if (!workspacePath) workspacePath = `/home/node/.openclaw/workspace-${slug}`;
  if (!agentName || !whoFor) {
    setFlash(res, 'error', 'Agent name and owner are required.');
    return redirect(res, '/agents');
  }
  try {
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'SOUL.md'), `# SOUL.md\n\n- Name: ${agentName}\n- Who it serves: ${whoFor}\n- Model: ${model}\n- Purpose: Agent workspace created from the admin panel.\n`, 'utf8');
    fs.writeFileSync(path.join(workspacePath, 'AGENTS.md'), `# AGENTS.md\n\nThis workspace belongs to ${agentName}.\n\n## Quick Start\n- Serve: ${whoFor}\n- Model: ${model}\n- Telegram token provided: ${telegramToken ? 'yes' : 'no'}\n\nNext step: configure deployment on the host.\n`, 'utf8');
    logAccess(req, 'AGENT_DEPLOY', `name=${agentName} workspace=${workspacePath}`);
    setFlash(res, 'success', 'Agent workspace created. Note: Container deployment requires host-level Docker access. Next steps: review SOUL.md, wire up channels, and deploy from the host.');
  } catch (error) {
    setFlash(res, 'error', error.message || 'Failed to create workspace.');
  }
  redirect(res, '/agents');
});

app.get('/health', (req, res) => {
  const flash = consumeFlash(req, res);
  res.send(renderHealthPage(flash));
});

app.get('/logs', (req, res) => {
  const flash = consumeFlash(req, res);
  res.send(renderLogsPage(req, flash));
});

app.get('/logs/raw', (req, res) => {
  const selected = String(req.query.file || 'neo-today');
  const linesCount = [50, 100, 200, 500].includes(Number(req.query.lines)) ? Number(req.query.lines) : 100;
  const current = getLogFileById(selected);
  const raw = current && fs.existsSync(current.path) ? readTailLines(current.path, linesCount).join('\n') : '';
  res.type('text/plain').send(raw);
});

app.get('/files', (req, res) => {
  const flash = consumeFlash(req, res);
  const target = sanitizeWorkspacePath(String(req.query.path || ''));
  if (!target || isBlockedPath(target)) {
    return res.send(layout('File Manager', '<div class="card section"><div class="flash error">Access denied.</div></div>', flash, 'files'));
  }
  res.send(renderFilesPage(target, flash));
});

app.post('/files/save', (req, res) => {
  const target = sanitizeWorkspacePath(String(req.body.path || ''));
  const content = String(req.body.content || '');
  if (!target || isBlockedPath(target) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    setFlash(res, 'error', 'Invalid file path.');
    return redirect(res, '/files');
  }
  try {
    fs.copyFileSync(target, `${target}.bak`);
    fs.writeFileSync(target, content, 'utf8');
    logAccess(req, 'FILE_SAVE', `path=${relativeWorkspacePath(target)}`);
    setFlash(res, 'success', `Saved ${relativeWorkspacePath(target)}.`);
  } catch (error) {
    setFlash(res, 'error', error.message || 'Failed to save file.');
  }
  redirect(res, `/files?path=${encodeURIComponent(relativeWorkspacePath(target))}`);
});

app.post('/files/upload', async (req, res) => {
  try {
    const { fields, files } = await parseMultipart(req);
    const targetDir = sanitizeWorkspacePath(String(fields.path || ''));
    if (!targetDir || isBlockedPath(targetDir) || !fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      setFlash(res, 'error', 'Invalid upload directory.');
      return redirect(res, '/files');
    }
    const file = files.find(item => item.fieldName === 'upload');
    if (!file || !file.filename || isBlockedFileName(file.filename)) {
      setFlash(res, 'error', 'Invalid upload file.');
      return redirect(res, `/files?path=${encodeURIComponent(relativeWorkspacePath(targetDir))}`);
    }
    const dest = path.join(targetDir, file.filename);
    if (!dest.startsWith(WORKSPACE_ROOT) || isBlockedPath(dest)) {
      setFlash(res, 'error', 'Upload blocked by security policy.');
      return redirect(res, `/files?path=${encodeURIComponent(relativeWorkspacePath(targetDir))}`);
    }
    fs.writeFileSync(dest, file.content);
    logAccess(req, 'FILE_UPLOAD', `path=${relativeWorkspacePath(dest)}`);
    setFlash(res, 'success', `Uploaded ${file.filename}.`);
    redirect(res, `/files?path=${encodeURIComponent(relativeWorkspacePath(targetDir))}`);
  } catch (error) {
    setFlash(res, 'error', error.message || 'Upload failed.');
    redirect(res, '/files');
  }
});

app.get('/actions', (req, res) => {
  const flash = consumeFlash(req, res);
  res.send(renderActionsPage(flash));
});

app.post('/actions/disk', (req, res) => {
  logAccess(req, 'ACTION_DISK', '');
  const result = safeExec('df -h');
  jsonAction(res, result.success, result.output);
});

app.post('/actions/cron-list', (req, res) => {
  logAccess(req, 'ACTION_CRON_LIST', '');
  const result = safeExec('openclaw cron list');
  jsonAction(res, result.success, result.output);
});

app.post('/actions/dashboard-refresh', (req, res) => {
  logAccess(req, 'ACTION_DASHBOARD_REFRESH', '');
  const result = safeExec('python3 /home/node/.openclaw/workspace/scripts/dashboard-update.py');
  jsonAction(res, result.success, result.output);
});

app.post('/actions/backup', (req, res) => {
  logAccess(req, 'ACTION_BACKUP', '');
  const token = getGitHubTokenFromCredentials();
  if (!token) return jsonAction(res, false, 'GitHub token not found in credentials.md');
  const remote = `https://neo:${token}@github.com/mdates-cmd/mission-control.git`;
  const cmd = `cd ${WORKSPACE_ROOT} && git add -A && git commit -m "Manual backup $(date)" && git push ${remote} HEAD:main`;
  const result = safeExec(cmd, { shell: '/bin/bash' });
  jsonAction(res, result.success, result.output);
});

app.post('/actions/test-telegram', (_req, res) => {
  logAccess(_req, 'ACTION_TEST_TELEGRAM', '');
  const token = getOpenClawBotToken();
  if (!token) return jsonAction(res, false, 'Telegram bot token not found in openclaw.json');
  const payload = new URLSearchParams({ chat_id: '5670293677', text: 'Test message from Admin Panel' }).toString();
  const request = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) },
  }, response => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      const ok = response.statusCode >= 200 && response.statusCode < 300;
      jsonAction(res, ok, data);
    });
  });
  request.on('error', error => jsonAction(res, false, error.message));
  request.write(payload);
  request.end();
});

app.post('/actions/check-keys', (_req, res) => {
  logAccess(_req, 'ACTION_CHECK_KEYS', '');
  const parsed = parseFileEntries(PRIMARY_CREDENTIALS_FILE);
  const anthropic = parsed.entries.find(entry => entry.key === 'ANTHROPIC_API_KEY');
  if (!anthropic) return jsonAction(res, false, 'ANTHROPIC_API_KEY not found in credentials.md');
  const request = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/models',
    method: 'GET',
    headers: { 'x-api-key': anthropic.value, 'anthropic-version': '2023-06-01' },
  }, response => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      const ok = response.statusCode >= 200 && response.statusCode < 300;
      jsonAction(res, ok, ok ? 'Anthropic key valid (models endpoint reachable).' : `Anthropic key invalid. HTTP ${response.statusCode}\n${data}`);
    });
  });
  request.on('error', error => jsonAction(res, false, error.message));
  request.end();
});

app.post('/actions/clear-tmp', (req, res) => {
  logAccess(req, 'ACTION_CLEAR_TMP', '');
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  let deleted = 0;
  const details = [];
  try {
    for (const name of fs.readdirSync('/tmp')) {
      if (!name.endsWith('.log')) continue;
      if (name === 'credvault.log' || name === 'credvault.pid') continue;
      const filePath = path.join('/tmp', name);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        deleted += 1;
        details.push(name);
      }
    }
    jsonAction(res, true, deleted ? `Deleted ${deleted} log file(s):\n${details.join('\n')}` : 'No temp log files older than 24h found.');
  } catch (error) {
    jsonAction(res, false, error.message || 'Clear tmp failed.');
  }
});

app.post('/actions/memory', (req, res) => {
  logAccess(req, 'ACTION_MEMORY', '');
  const mem = parseMemInfo();
  jsonAction(res, true, `MemTotal: ${mem.totalMb} MB\nMemAvailable: ${mem.availableMb} MB\nMemUsed: ${mem.usedMb} MB\nUsage: ${mem.usedPct}%`);
});

app.post('/actions/oc-status', (req, res) => {
  logAccess(req, 'ACTION_OC_STATUS', '');
  const result = safeExec('openclaw gateway status');
  jsonAction(res, result.success, result.output);
});

app.post('/actions/restart-credvault', (req, res) => {
  logAccess(req, 'ACTION_RESTART_CREDVAULT', '');
  const stopResult = safeExec(`bash ${CREDVAULT_DIR}/stop.sh`);
  const startResult = safeExec(`bash ${CREDVAULT_DIR}/start.sh`);
  const success = stopResult.success && startResult.success;
  jsonAction(res, success, `STOP:\n${stopResult.output || '(no output)'}\n\nSTART:\n${startResult.output || '(no output)'}`);
});

app.get('/onboarding', (req, res) => {
  const flash = consumeFlash(req, res);
  res.send(renderOnboardingPage(flash));
});

ensureAuthFile();
ensureDir(PRIMARY_CREDENTIALS_FILE);
const server = http.createServer(app);
server.listen(PORT, HOST);
