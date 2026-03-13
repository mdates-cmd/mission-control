#!/usr/bin/env python3
"""
dashboard-update.py
Main dashboard refresh script. Collects data, updates HTML sections, handles alerts.
Designed to run as an isolated cron task (ChatGPT Manager model preferred).

Steps:
1. Collect system/workspace data
2. Update dashboard HTML sections
3. Push to GitHub
4. Send Telegram alert if critical issues found
"""
import subprocess, json, os, re, sys, datetime, shutil, urllib.request
from pathlib import Path

WS = Path('/home/node/.openclaw/workspace')
INDEX = WS / 'index.html'
DASHBOARD_SERVER = WS / 'dashboard-server/index.html'
CREDS = WS / 'life/projects/apex/credentials.md'
OC_CONFIG = Path('/home/node/.openclaw/openclaw.json')
BOSS_CHAT_ID = '5670293677'

# ── Helpers ──────────────────────────────────────────────────────────────────

def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
    return r.stdout.strip()

def get_token(path, pattern):
    try:
        m = re.search(pattern, Path(path).read_text())
        return m.group(0) if m else None
    except Exception:
        return None

def send_telegram(message):
    try:
        config = json.loads(OC_CONFIG.read_text())
        bot_token = config.get('channels', {}).get('telegram', {}).get('botToken', '')
        if not bot_token:
            return
        url = f'https://api.telegram.org/bot{bot_token}/sendMessage'
        data = json.dumps({'chat_id': BOSS_CHAT_ID, 'text': message, 'parse_mode': 'Markdown'}).encode()
        req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10)
        print('[Telegram] Alert sent')
    except Exception as e:
        print(f'[Telegram] Error: {e}')

# ── Data Collection ───────────────────────────────────────────────────────────

def collect():
    # System
    mem_info = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        k, v = line.split(':', 1)
        mem_info[k.strip()] = int(v.strip().split()[0])
    total_mb = mem_info.get('MemTotal', 0) // 1024
    avail_mb = mem_info.get('MemAvailable', 0) // 1024
    used_mb = total_mb - avail_mb
    mem_pct = round(used_mb / total_mb * 100, 1) if total_mb else 0

    disk_line = run("df -h / | tail -1").split()
    disk_used = disk_line[2] if len(disk_line) > 2 else '?'
    disk_avail = disk_line[3] if len(disk_line) > 3 else '?'
    disk_pct = int(disk_line[4].replace('%', '')) if len(disk_line) > 4 else 0

    load = run('cat /proc/loadavg').split()[0]

    uptime_secs = float(Path('/proc/uptime').read_text().split()[0])
    uptime_h = round(uptime_secs / 3600, 1)

    ps = run('ps aux | grep openclaw | grep -v grep')
    gateway_ok = 'openclaw-gateway' in ps

    # Log errors — only count genuine system errors, not browser tool timeouts
    log_path = f'/tmp/openclaw/openclaw-{datetime.date.today().strftime("%Y-%m-%d")}.log'
    log_errors = 0
    if os.path.exists(log_path):
        for line in Path(log_path).read_text().splitlines():
            try:
                entry = json.loads(line)
                meta = entry.get('_meta', {})
                level = meta.get('logLevelId', 0)
                msg = str(entry.get('0', ''))
                # Skip known non-critical noise
                skip_patterns = [
                    'browser failed', 'browser tool',  # browser timeouts (transient)
                    'service config', 'systemd', 'gateway service PATH',  # container env warnings
                    'diagnostic', 'openclaw doctor',  # startup diagnostics
                    'exec failed', 'tools] image failed', 'tools] read failed',  # tool errors (non-critical)
                    'pip: not found', 'ENOENT',  # missing optional files/tools
                ]
                if any(p.lower() in msg.lower() for p in skip_patterns):
                    continue
                # Count ERROR (5) and FATAL (6+) level entries only
                if level >= 5:
                    log_errors += 1
            except Exception:
                pass

    # Finances
    ledger_text = ''
    ledger_path = WS / 'life/areas/finances/ledger.md'
    if ledger_path.exists():
        ledger_text = ledger_path.read_text()
    api_spent_m = re.search(r'AI API Spent.*?~?\$([0-9.]+)', ledger_text)
    api_budget_m = re.search(r'AI API Budget.*?\$([0-9]+)', ledger_text)
    api_spent = float(api_spent_m.group(1)) if api_spent_m else 175.0
    api_budget = float(api_budget_m.group(1)) if api_budget_m else 200.0

    # Git
    last_commit = run(f'cd {WS} && git log -1 --format="%h %s" 2>/dev/null')
    last_push_rel = run(f'cd {WS} && git log -1 --format="%ar" 2>/dev/null')

    # Daily note (today)
    today_note = ''
    today_path = WS / f'memory/{datetime.date.today().strftime("%Y-%m-%d")}.md'
    if today_path.exists():
        today_note = today_path.read_text()[:600]

    # Alerts
    alerts = []
    if mem_pct > 85:
        alerts.append(f'HIGH MEMORY: {mem_pct}% ({used_mb}MB / {total_mb}MB)')
    if disk_pct > 80:
        alerts.append(f'HIGH DISK: {disk_pct}% ({disk_used} used, {disk_avail} free)')
    if not gateway_ok:
        alerts.append('OPENCLAW GATEWAY PROCESS NOT FOUND')
    if log_errors > 20:
        alerts.append(f'ELEVATED ERRORS: {log_errors} non-browser error events in today\'s log')
    if api_spent >= api_budget:
        alerts.append(f'API BUDGET EXHAUSTED: ${api_spent:.2f} of ${api_budget:.2f} used')
    elif api_budget - api_spent < 20:
        alerts.append(f'API BUDGET LOW: ${api_budget - api_spent:.2f} remaining')

    # ET time (UTC-5 for EST)
    now_utc = datetime.datetime.utcnow()
    now_et = now_utc + datetime.timedelta(hours=-5)
    et_str = now_et.strftime('%b %-d, %Y  %-I:%M %p ET')

    return {
        'mem_pct': mem_pct, 'mem_used_mb': used_mb, 'mem_total_mb': total_mb,
        'disk_used': disk_used, 'disk_avail': disk_avail, 'disk_pct': disk_pct,
        'load': load, 'uptime_h': uptime_h,
        'gateway_ok': gateway_ok, 'log_errors': log_errors,
        'api_spent': api_spent, 'api_budget': api_budget, 'api_remaining': api_budget - api_spent,
        'last_commit': last_commit, 'last_push_rel': last_push_rel,
        'today_note': today_note,
        'alerts': alerts,
        'et_str': et_str,
        'now_utc': now_utc.isoformat(),
    }

# ── HTML Patching ─────────────────────────────────────────────────────────────

def update_week_summary(html):
    """Update the Day N summary line in the mission header."""
    today = datetime.date.today()
    mission_start = datetime.date(2026, 3, 5)
    day_num = (today - mission_start).days  # Day 0 = Mar 5, Day 8 = Mar 13
    # Read CONTEXT.md for current priority and state
    context_path = WS / 'CONTEXT.md'
    priority = ''
    phase = ''
    if context_path.exists():
        ctx = context_path.read_text()
        m = re.search(r'#1 Priority Right Now\s*\n+(.+?)(?:\n\n|\n#)', ctx, re.DOTALL)
        if m:
            priority = m.group(1).strip().replace('\n', ' ')[:120]
        m2 = re.search(r'Project 1.*?\*\*Phase.*?\*\*(.*?)(?=\n\n|\n###)', ctx, re.DOTALL)
        if m2:
            phase = m2.group(1).strip()[:80]
    
    # Read git log for recent activity
    recent = run(f'cd {WS} && git log --oneline --since="48 hours ago" 2>/dev/null')
    commit_count = len([l for l in recent.splitlines() if l.strip()])
    
    # Build the summary line
    et_month = today.strftime('%b %-d ET')
    api_rem = 200 - 183  # fallback; ideally read from ledger
    ledger = (WS / 'life/areas/finances/ledger.md')
    if ledger.exists():
        m = re.search(r'AI API Remaining.*?~?\$([0-9.]+)', ledger.read_text())
        if m:
            api_rem = float(m.group(1))
    
    if priority:
        summary = f'<strong>Day {day_num} update ({et_month}):</strong> {priority}'
    else:
        summary = f'<strong>Day {day_num} update ({et_month}):</strong> {commit_count} commits in last 48h. API budget: ~${int(200-api_rem)}/$200 spent, ~${int(api_rem)} remaining.'
    
    html = re.sub(
        r'(<div class="week-summary">).*?(</div>)',
        rf'\g<1>{summary}\g<2>',
        html, flags=re.DOTALL, count=1
    )
    return html

def update_timestamp(html, et_str):
    """Update the 'Last Updated' display in the dashboard header."""
    # Pattern: id="last-updated" or similar — try a few common patterns
    html = re.sub(
        r'(<span[^>]*id=["\']last-updated["\'][^>]*>)[^<]*(</span>)',
        rf'\g<1>{et_str}\2', html
    )
    # Also try the subtitle/tagline area
    html = re.sub(
        r'(Updated[:\s]*<[^>]+>)[^<]*(</)',
        rf'\g<1>{et_str}\2', html
    )
    return html

def update_system_health(html, d):
    """Update the system health section metrics."""
    mem_color = 'var(--red)' if d['mem_pct'] > 85 else ('var(--yellow)' if d['mem_pct'] > 70 else 'var(--green)')
    disk_color = 'var(--red)' if d['disk_pct'] > 80 else ('var(--yellow)' if d['disk_pct'] > 65 else 'var(--green)')
    gw_color = 'var(--green)' if d['gateway_ok'] else 'var(--red)'
    gw_text = 'Running' if d['gateway_ok'] else 'DOWN'

    # Replace health metric values — look for id-tagged spans or specific patterns
    replacements = [
        (r'id="health-mem"[^>]*>[^<]*', f'id="health-mem">{d["mem_pct"]}%'),
        (r'id="health-disk"[^>]*>[^<]*', f'id="health-disk">{d["disk_pct"]}%'),
        (r'id="health-load"[^>]*>[^<]*', f'id="health-load">{d["load"]}'),
        (r'id="health-gateway"[^>]*>[^<]*', f'id="health-gateway">{gw_text}'),
        (r'id="health-uptime"[^>]*>[^<]*', f'id="health-uptime">{d["uptime_h"]}h'),
        (r'id="health-errors"[^>]*>[^<]*', f'id="health-errors">{d["log_errors"]}'),
    ]
    for pattern, replacement in replacements:
        html = re.sub(pattern, replacement, html)
    return html

def update_api_costs(html, d):
    """Update the API cost cards using stable id= attributes."""
    api_spent = d['api_spent']
    api_rem = d['api_remaining']
    # Color based on remaining budget
    rem_color = 'var(--red)' if api_rem < 20 else ('var(--yellow)' if api_rem < 50 else 'var(--green)')
    
    updates = {
        'api-spend-value': f'~${api_spent:.0f}',
        'api-remaining-value': f'~${api_rem:.0f}',
        'api-total-cost': f'~${api_spent:.0f}',
    }
    for elem_id, new_val in updates.items():
        html = re.sub(
            rf'(id="{elem_id}"[^>]*>)[^<]*(</)',
            rf'\g<1>{new_val}\2', html
        )
    # Update total note
    html = re.sub(
        r'(id="api-total-note"[^>]*>)[^<]*(</)',
        rf'\g<1>{"&#9888;&#65039;" if api_rem < 20 else ""} ~${api_rem:.0f} remaining this cycle\2', html
    )
    return html

def get_recent_git_activity():
    """Get git commits since last dashboard update."""
    try:
        log = run(f'cd {WS} && git log --oneline --since="6 hours ago" 2>/dev/null')
        if log.strip():
            lines = [l.strip() for l in log.strip().splitlines() if l.strip()]
            # Strip commit hashes, return clean messages
            msgs = [re.sub(r'^[a-f0-9]+ ', '', l) for l in lines[:5]]
            return msgs
    except Exception:
        pass
    return []

def prepend_activity_log(html, d, alerts):
    """Add a new activity log entry at the top — meaningful content from git log."""
    alert_badge = '<span class="badge badge-yellow" style="margin-left:8px;">Alert</span>' if alerts else '<span class="badge badge-green" style="margin-left:8px;">OK</span>'
    
    # Get recent git activity to show something meaningful
    git_activity = get_recent_git_activity()
    
    if git_activity:
        activity_text = f'New commits: ' + ' &bull; '.join(git_activity[:3])
    elif alerts:
        activity_text = '&#9888;&#65039; ' + '; '.join(alerts)
    else:
        activity_text = f'System healthy &mdash; mem {d["mem_pct"]}% &bull; disk {d["disk_pct"]}% &bull; load {d["load"]}'
    
    if alerts:
        activity_text += ' &mdash; &#9888;&#65039; ' + '; '.join(alerts)
    
    new_entry = f'''      <div class="log-entry">
        <div class="log-time">{d["et_str"]}</div>
        <div class="log-agent">AUTO</div>
        <div class="log-action">
          Auto-refresh &mdash; API budget: ${d["api_spent"]:.0f} / ${d["api_budget"]:.0f} &bull; {activity_text}
          {alert_badge}
        </div>
      </div>
'''
    html = re.sub(
        r'(<!-- UPDATE: Add new entries at TOP[^\n]*\n)',
        rf'\g<1>{new_entry}',
        html, count=1
    )
    return html

def trim_activity_log(html, max_entries=25):
    """Keep only the last max_entries log entries."""
    entries = re.findall(r'<div class="log-entry">.*?</div>\s*</div>', html, re.DOTALL)
    if len(entries) > max_entries:
        # Remove oldest entries (they appear last in the HTML)
        oldest = entries[max_entries:]
        for entry in oldest:
            html = html.replace(entry, '', 1)
    return html

# ── Push ──────────────────────────────────────────────────────────────────────

def push_to_github(message):
    token = get_token(str(CREDS), r'github_pat_[A-Za-z0-9_]+')
    if not token:
        print('[GitHub] No token found')
        return False
    DASHBOARD_SERVER.parent.mkdir(exist_ok=True)
    shutil.copy(INDEX, DASHBOARD_SERVER)
    for cmd in [
        f'cd {WS} && git add index.html dashboard-server/index.html',
        f'cd {WS} && git diff --cached --quiet || git commit -m "{message}"',
        f'cd {WS} && git push "https://neo:{token}@github.com/mdates-cmd/mission-control.git" master:main',
    ]:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if r.returncode > 1:
            print(f'[GitHub] Error: {r.stderr[:200]}')
            return False
    print('[GitHub] Push OK')
    return True

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f'[dashboard-update] Starting at {datetime.datetime.utcnow().isoformat()}')
    
    d = collect()
    print(f'[dashboard-update] Collected: mem={d["mem_pct"]}% disk={d["disk_pct"]}% gateway={d["gateway_ok"]} alerts={d["alerts"]}')

    # Read current HTML
    html = INDEX.read_text()

    # Apply updates
    html = update_timestamp(html, d['et_str'])
    html = update_week_summary(html)
    html = update_system_health(html, d)
    html = update_api_costs(html, d)
    html = prepend_activity_log(html, d, d['alerts'])
    html = trim_activity_log(html)

    # Write
    INDEX.write_text(html)
    print('[dashboard-update] HTML updated')

    # Push
    commit_msg = f'Dashboard: auto-refresh {datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")}'
    pushed = push_to_github(commit_msg)

    # Alert
    if d['alerts']:
        alert_lines = '\n'.join(f'&#x2022; {a}' for a in d['alerts'])
        msg = (
            f'⚠️ *Mission Control Alert*\n\n'
            f'{chr(10).join("• " + a for a in d["alerts"])}\n\n'
            f'Dashboard: https://mdates-cmd.github.io/mission-control'
        )
        send_telegram(msg)
    elif not pushed:
        send_telegram('⚠️ Dashboard refresh failed to push to GitHub. Check Neo.')

    print(f'[dashboard-update] Done. Alerts: {len(d["alerts"])}. Pushed: {pushed}')
    return 0 if pushed else 1

if __name__ == '__main__':
    sys.exit(main())
