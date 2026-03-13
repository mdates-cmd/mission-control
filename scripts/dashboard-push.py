#!/usr/bin/env python3
"""
dashboard-push.py
Pushes updated index.html to GitHub Pages and sends Telegram alert if needed.
Called AFTER the ChatGPT Manager subagent has written the updated HTML.

Usage:
  python3 dashboard-push.py [--alerts "alert text"]
"""
import subprocess, sys, json, re, urllib.request, urllib.parse, os, datetime
from pathlib import Path

WS = Path('/home/node/.openclaw/workspace')
INDEX = WS / 'index.html'
DASHBOARD_SERVER = WS / 'dashboard-server/index.html'
CREDS = WS / 'life/projects/apex/credentials.md'
OC_CONFIG = Path('/home/node/.openclaw/openclaw.json')
BOSS_CHAT_ID = '5670293677'

def get_github_token():
    if CREDS.exists():
        m = re.search(r'github_pat_[A-Za-z0-9_]+', CREDS.read_text())
        return m.group(0) if m else None
    return None

def get_telegram_token():
    if OC_CONFIG.exists():
        c = json.loads(OC_CONFIG.read_text())
        return c.get('channels', {}).get('telegram', {}).get('botToken', '')
    return ''

def push_to_github(message='Dashboard: auto-refresh update'):
    token = get_github_token()
    if not token:
        print('ERROR: No GitHub token found')
        return False
    # Copy to dashboard-server
    DASHBOARD_SERVER.parent.mkdir(exist_ok=True)
    DASHBOARD_SERVER.write_text(INDEX.read_text())
    
    cmds = [
        f'cd {WS} && git add index.html dashboard-server/index.html',
        f'cd {WS} && git diff --cached --quiet || git commit -m "{message}"',
        f'cd {WS} && git push "https://neo:{token}@github.com/mdates-cmd/mission-control.git" master:main',
    ]
    for cmd in cmds:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if r.returncode not in (0, 1):  # 1 = nothing to commit, ok
            print(f'Git error: {r.stderr[:200]}')
            return False
    print('Pushed to GitHub Pages OK')
    return True

def send_telegram(message, chat_id=BOSS_CHAT_ID):
    token = get_telegram_token()
    if not token:
        print('No Telegram token')
        return
    url = f'https://api.telegram.org/bot{token}/sendMessage'
    data = json.dumps({'chat_id': chat_id, 'text': message, 'parse_mode': 'Markdown'}).encode()
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print(f'Telegram sent: {r.status}')
    except Exception as e:
        print(f'Telegram error: {e}')

if __name__ == '__main__':
    alerts = []
    for i, arg in enumerate(sys.argv):
        if arg == '--alerts' and i + 1 < len(sys.argv):
            alerts.append(sys.argv[i + 1])
    
    # Check for system alerts from collected data
    data_file = '/tmp/dashboard_data.json'
    if os.path.exists(data_file):
        with open(data_file) as f:
            data = json.load(f)
        sys_alerts = data.get('system', {}).get('alerts', [])
        alerts.extend(sys_alerts)
    
    # Push
    now = datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')
    success = push_to_github(f'Dashboard: auto-refresh {now}')
    
    # Alert if needed
    if alerts:
        msg = '⚠️ *Mission Control Alert*\n\n' + '\n'.join(f'• {a}' for a in alerts)
        msg += '\n\nDashboard: https://mdates-cmd.github.io/mission-control'
        send_telegram(msg)
        print(f'Alerts sent: {alerts}')
    elif not success:
        send_telegram('⚠️ Dashboard auto-refresh failed to push to GitHub. Check Neo logs.')
    
    print('Done.')
