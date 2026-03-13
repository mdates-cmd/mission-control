#!/usr/bin/env python3
"""
dashboard-collect.py
Collects system health, workspace state, and operational data for the
Mission Control dashboard refresh. Outputs a structured JSON payload.
"""
import json, os, subprocess, re, datetime, glob
from pathlib import Path

WS = Path('/home/node/.openclaw/workspace')
LEDGER = WS / 'life/areas/finances/ledger.md'
MEMORY = WS / 'MEMORY.md'
DAILY_DIR = WS / 'memory'
INDEX = WS / 'index.html'

def run(cmd, shell=False):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10, shell=shell)
        return r.stdout.strip()
    except Exception as e:
        return f'error: {e}'

def collect_system():
    # Memory
    mem = {}
    for line in run(['cat', '/proc/meminfo']).splitlines():
        k, v = line.split(':')
        mem[k.strip()] = int(v.strip().split()[0])
    total_mb = mem.get('MemTotal', 0) // 1024
    avail_mb = mem.get('MemAvailable', 0) // 1024
    used_mb = total_mb - avail_mb
    mem_pct = round(used_mb / total_mb * 100, 1) if total_mb else 0

    # Disk
    disk_out = run('df -h / | tail -1', shell=True)
    disk_parts = disk_out.split()
    disk_used = disk_parts[2] if len(disk_parts) > 2 else '?'
    disk_avail = disk_parts[3] if len(disk_parts) > 3 else '?'
    disk_pct_str = disk_parts[4] if len(disk_parts) > 4 else '0%'
    disk_pct = int(disk_pct_str.replace('%', '')) if disk_pct_str != '0%' else 0

    # Load
    loadavg = run(['cat', '/proc/loadavg']).split()
    load1 = loadavg[0] if loadavg else '?'

    # OpenClaw processes
    ps_out = run('ps aux | grep openclaw | grep -v grep', shell=True)
    gateway_running = 'openclaw-gateway' in ps_out
    openclaw_running = bool(ps_out.strip())

    # Log errors in last 24h
    log_path = f'/tmp/openclaw/openclaw-{datetime.date.today().strftime("%Y-%m-%d")}.log'
    log_errors = 0
    if os.path.exists(log_path):
        with open(log_path) as f:
            content = f.read()
            log_errors = content.lower().count('error')

    # Uptime
    uptime_out = run(['cat', '/proc/uptime'])
    uptime_secs = float(uptime_out.split()[0]) if uptime_out else 0
    uptime_hours = round(uptime_secs / 3600, 1)

    alerts = []
    if mem_pct > 85:
        alerts.append(f'HIGH MEMORY: {mem_pct}% used')
    if disk_pct > 80:
        alerts.append(f'HIGH DISK: {disk_pct}% used')
    if not gateway_running:
        alerts.append('OPENCLAW GATEWAY NOT RUNNING')
    if log_errors > 50:
        alerts.append(f'HIGH ERROR COUNT: {log_errors} errors in logs today')

    return {
        'memory': {'total_mb': total_mb, 'used_mb': used_mb, 'avail_mb': avail_mb, 'pct': mem_pct},
        'disk': {'used': disk_used, 'avail': disk_avail, 'pct': disk_pct},
        'load': load1,
        'uptime_hours': uptime_hours,
        'openclaw_running': openclaw_running,
        'gateway_running': gateway_running,
        'log_errors_today': log_errors,
        'alerts': alerts,
    }

def collect_finances():
    if not LEDGER.exists():
        return {'seed_budget': 250, 'spent': 0, 'remaining': 250, 'api_spent': 175, 'api_budget': 200}
    ledger = LEDGER.read_text()
    # Parse budget lines
    seed = re.search(r'Seed Budget.*?\$([0-9.]+)', ledger)
    spent = re.search(r'\*\*Spent:\*\*.*?\$([0-9.]+)', ledger)
    remaining = re.search(r'\*\*Remaining:\*\*.*?\$([0-9.]+)', ledger)
    api_spent = re.search(r'AI API Spent.*?~?\$([0-9.]+)', ledger)
    api_budget = re.search(r'AI API Budget.*?\$([0-9]+)', ledger)
    return {
        'seed_budget': float(seed.group(1)) if seed else 250,
        'ops_spent': float(spent.group(1)) if spent else 0,
        'ops_remaining': float(remaining.group(1)) if remaining else 250,
        'api_spent': float(api_spent.group(1)) if api_spent else 175,
        'api_budget': float(api_budget.group(1)) if api_budget else 200,
        'api_remaining': (float(api_budget.group(1)) if api_budget else 200) - (float(api_spent.group(1)) if api_spent else 175),
    }

def collect_project_state():
    if not MEMORY.exists():
        return {}
    mem = MEMORY.read_text()
    # Extract active projects section
    projects_match = re.search(r'## Active Projects.*?(?=\n## |\Z)', mem, re.DOTALL)
    projects_text = projects_match.group(0)[:1000] if projects_match else ''
    # Check phase
    phase_a = '✅' if 'Phase A' in mem and 'live' in mem.lower() else '🔄'
    funnel_live = 'go.dealflowaiconsulting.com/sales-page' in mem
    return {
        'projects_summary': projects_text[:500],
        'funnel_live': funnel_live,
        'phase': 'A' if funnel_live else 'Pre-Launch',
    }

def collect_recent_activity():
    # Today's and yesterday's daily notes
    today = datetime.date.today()
    yesterday = today - datetime.timedelta(days=1)
    notes = []
    for d in [today, yesterday]:
        path = DAILY_DIR / f'{d.strftime("%Y-%m-%d")}.md'
        if path.exists():
            notes.append({'date': str(d), 'content': path.read_text()[:800]})
    # Git log - last 5 commits
    git_log = run('cd /home/node/.openclaw/workspace && git log --oneline -5 2>/dev/null', shell=True)
    return {
        'daily_notes': notes,
        'recent_commits': git_log,
    }

def collect_git_state():
    git_status = run('cd /home/node/.openclaw/workspace && git status --short 2>/dev/null', shell=True)
    last_push = run('cd /home/node/.openclaw/workspace && git log -1 --format="%ar" 2>/dev/null', shell=True)
    return {
        'uncommitted_files': len([l for l in git_status.splitlines() if l.strip()]),
        'last_push': last_push,
    }

if __name__ == '__main__':
    now_utc = datetime.datetime.utcnow()
    # ET = UTC-5 (EST) or UTC-4 (EDT). Mar 13 = EST
    et_offset = -5
    now_et = now_utc + datetime.timedelta(hours=et_offset)
    
    data = {
        'collected_at_utc': now_utc.isoformat(),
        'collected_at_et': now_et.strftime('%b %d, %Y %I:%M %p ET'),
        'system': collect_system(),
        'finances': collect_finances(),
        'projects': collect_project_state(),
        'activity': collect_recent_activity(),
        'git': collect_git_state(),
    }
    print(json.dumps(data, indent=2))
