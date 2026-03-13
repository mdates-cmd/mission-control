const express = require('/app/node_modules/.pnpm/express@5.2.1/node_modules/express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');

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
const AGENT_FILES = {
  Neo: PRIMARY_CREDENTIALS_FILE,
  Josh: '/home/node/.openclaw/workspace/life/projects/josh/credentials.md',
  Shared: PRIMARY_CREDENTIALS_FILE,
};

// Keys that map to container env vars and require restart to take effect
const ENV_VAR_KEYS = new Set([
  'ANTHROPIC_API_KEY','OPENAI_API_KEY','OPENROUTER_API_KEY','GITHUB_TOKEN',
  'GHL_API_KEY','GHL_PRIVATE_KEY','TELEGRAM_BOT_TOKEN','STRIPE_SECRET_KEY',
  'CLOUDFLARE_API_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY',
]);

function logAccess(req, action, detail) {
  try {
    const now = new Date().toISOString();
    const ip = getIp(req);
    const line = `${now} [${ip}] ${action} ${detail || ''}\n`;
    fs.appendFileSync(ACCESS_LOG, line);
  } catch { /* non-fatal */ }
}

const sessions = new Map();
const loginAttempts = new Map();

app.use(express.urlencoded({ extended: false }));

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
      entries.push({
        key: match[1].trim(),
        value: match[2],
        section,
        lineIndex: i,
        bullet: Boolean(bullet),
        filePath,
      });
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
  return {
    rows,
    lastUpdated: fileStats ? fileStats.mtime.toISOString() : null,
    scan: scanCredentialFiles(),
  };
}

function layout(title, body, flash) {
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
  <style>
    :root {
      --bg: #0a0e1a; --card: #111827; --border: #1f2937; --text: #f9fafb; --muted: #9ca3af; --accent: #e84c3d; --green: #10b981;
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
    input, select { width: 100%; background: #0f172a; border: 1px solid var(--border); color: var(--text); border-radius: 12px; padding: 12px 14px; font-size: 15px; }
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
    .status-item { display: flex; justify-content: space-between; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--border); }
    .status-item:last-child { border-bottom: 0; }
    .dot { font-size: 18px; }
    .ok { color: var(--green); } .bad { color: var(--accent); }
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
    @media (max-width: 820px) {
      .wrap { padding: 16px; }
      .topbar { flex-direction: column; align-items: flex-start; }
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
  `);
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
  `, flash);
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
        <div><span class="dot ${item.exists && item.readable ? 'ok' : 'bad'}">${item.exists && item.readable ? '●' : '●'}</span> <span class="mono">${escapeHtml(shortenPath(item.filePath))}</span></div>
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
  `, flash);
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
  const restartNote = needsRestart
    ? ` ⚠️ This key is a container environment variable — a container restart may be required for it to take effect.`
    : '';
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

ensureAuthFile();
ensureDir(PRIMARY_CREDENTIALS_FILE);
const server = http.createServer(app);
server.listen(PORT, HOST);
