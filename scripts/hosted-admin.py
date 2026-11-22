#!/usr/bin/env python3
"""Explicit hosted setup actions; secrets are read privately, never printed.

Requires SUPABASE_ACCESS_TOKEN and nonsecret hosted-admin.json project metadata.
OAuth setup additionally requires SUPABASE_ADMIN_KEY for that invocation only.
No test imports or executes this script. Production probes inspect metadata only.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = Path.home() / '.config' / 'streamline-mcp'
STATE_PATH = CONFIG_DIR / 'hosted-deployment.json'
CONFIG = json.loads((CONFIG_DIR / 'hosted-admin.json').read_text())
if set(CONFIG) != {'projectURL', 'userID'}:
    raise RuntimeError('hosted-admin.json must contain only projectURL and userID; never save an API key there.')
PROJECT_URL = CONFIG['projectURL'].rstrip('/')
REF = PROJECT_URL.split('//')[1].split('.')[0]
MANAGEMENT = f'https://api.supabase.com/v1/projects/{REF}'
CONSENT_ORIGIN = 'https://streamline-personal-auth.netlify.app'
CONSENT_PATH = '/consent.html'
STATE = json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {}

def save():
    fd = os.open(STATE_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(STATE, f, indent=2)

def request(url, method='GET', body=None, admin=False):
    headers = {'Content-Type': 'application/json'}
    if admin:
        key = os.environ.get('SUPABASE_ADMIN_KEY', '')
        if not key.startswith('sb_secret_'):
            raise RuntimeError('OAuth setup requires a temporary SUPABASE_ADMIN_KEY secret key in the environment. Revoke it after setup; do not save it in local MCP config.')
        headers.update(apikey=key, Authorization='Bearer ' + key)
    else:
        headers['Authorization'] = 'Bearer ' + os.environ['SUPABASE_ACCESS_TOKEN']
    req = urllib.request.Request(url, method=method, headers=headers,
        data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        # Error bodies may echo keys or private SQL. Never include them in logs.
        if urllib.parse.urlsplit(url).path.endswith('/database/query'):
            diagnostic = json.loads(error.read()).get('message', 'Database operation failed')
            for value in [os.environ.get('SUPABASE_ADMIN_KEY', ''), CONFIG['userID'], os.environ.get('SUPABASE_ACCESS_TOKEN', '')]:
                if value: diagnostic = diagnostic.replace(value, '[redacted]')
            raise RuntimeError(diagnostic[:1200]) from None
        raise RuntimeError(f'{method} {urllib.parse.urlsplit(url).path}: HTTP {error.code}') from None

def sql(query, read_only=True):
    return request(MANAGEMENT + '/database/query', 'POST', {'query': query, 'read_only': read_only})

def literal(value):
    return "'" + value.replace("'", "''") + "'"

def apply_schema():
    path = ROOT / 'migrations/202611220001_hosted_mcp.sql'
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    exists = sql("SELECT to_regprocedure('public.streamline_mcp_call(text,jsonb)') IS NOT NULL AS installed")[0]['installed']
    if exists:
        if STATE.get('migration_sha256') != digest:
            raise RuntimeError('Migration exists but its checkpoint differs. Inspect before proceeding; never rerun blindly.')
        print('Hosted migration already applied and checkpoint matches.')
        return
    sql(path.read_text(), False)
    STATE['migration_sha256'] = digest
    save()
    print('Applied hosted migration transactionally; connector remains disabled.')

def apply_recurrence():
    path = ROOT / 'migrations/202611220002_hosted_recurrence.sql'
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if STATE.get('recurrence_migration_sha256'):
        if STATE['recurrence_migration_sha256'] != digest:
            raise RuntimeError('Applied recurrence migration changed. Review before proceeding.')
        print('Recurrence migration already applied and checkpoint matches.')
        return
    # The transaction checks the old function body before replacing it.
    sql(path.read_text(), False)
    STATE['recurrence_migration_sha256'] = digest
    save()
    print('Applied guarded recurrence support and private-source task exclusion.')

def verify_consent_host():
    # Fail closed if hosting headers or assets differ from this reviewed checkout.
    for name in ['consent.html', 'consent.js', 'consent.css', 'consent-config.json']:
        with urllib.request.urlopen(CONSENT_ORIGIN + '/' + name, timeout=30) as response:
            if response.geturl() != CONSENT_ORIGIN + '/' + name:
                raise RuntimeError('Unexpected consent hosting redirect.')
            if response.read() != (ROOT / 'consent' / name).read_bytes():
                raise RuntimeError('Deploy the reviewed consent assets before configuring OAuth.')
            expected = {'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store'}
            if any(response.headers.get(k) != v for k, v in expected.items()):
                raise RuntimeError('Consent host is missing required security headers.')
            csp = response.headers.get('Content-Security-Policy', '')
            if "frame-ancestors 'none'" not in csp or "default-src 'none'" not in csp:
                raise RuntimeError('Consent host is missing its enforced CSP.')

def configure_auth():
    verify_consent_host()
    if not STATE.get('migration_sha256'):
        raise RuntimeError('Apply and verify database restrictions before enabling OAuth.')
    health = request(PROJECT_URL + '/auth/v1/health', admin=True)
    version = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', health.get('version', ''))
    if not version or tuple(map(int, version.groups())) < (2, 198, 0):
        raise RuntimeError('Supabase Auth v2.198.0+ is required to block OAuth credentials from account/MFA changes.')
    auth = request(MANAGEMENT + '/config/auth')
    changes = {'oauth_server_enabled': True, 'oauth_server_allow_dynamic_registration': False,
        'oauth_server_authorization_path': CONSENT_PATH, 'site_url': CONSENT_ORIGIN,
        'disable_signup': True}
    allow = {url for url in auth.get('uri_allow_list', '').split(',') if url and not url.startswith('https://rostehea.github.io')}
    allow.update([CONSENT_ORIGIN, CONSENT_ORIGIN + CONSENT_PATH, 'streamline://auth/callback'])
    changes['uri_allow_list'] = ','.join(sorted(allow))
    if 'auth_before' not in STATE:
        STATE['auth_before'] = {key: auth.get(key) for key in changes}
        save()
    request(MANAGEMENT + '/config/auth', 'PATCH', changes)
    if not STATE.get('client_id'):
        # Recover a possibly completed registration before attempting another.
        existing = request(PROJECT_URL + '/auth/v1/admin/oauth/clients', admin=True)
        candidates = existing.get('clients', []) if isinstance(existing, dict) else existing
        candidates = [c for c in candidates if c.get('client_name') == 'Streamline personal Claude connector']
        if len(candidates) > 1:
            raise RuntimeError('Multiple matching OAuth clients; inspect before choosing.')
        client = candidates[0] if candidates else request(PROJECT_URL + '/auth/v1/admin/oauth/clients', 'POST', {
            'client_name': 'Streamline personal Claude connector', 'client_uri': 'https://claude.ai',
            'redirect_uris': ['https://claude.ai/api/mcp/auth_callback'],
            'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code'],
            'scope': 'openid', 'token_endpoint_auth_method': 'none'}, admin=True)
        STATE['client_id'] = client['client_id']
        save()
    keys = request(MANAGEMENT + '/api-keys?reveal=true')
    publishable = next((k['api_key'] for k in keys if k.get('type') == 'publishable'), None)
    if not publishable:
        publishable = next((k['api_key'] for k in keys if k.get('name') == 'anon'), None)
    if not publishable or publishable.startswith('sb_secret_'):
        raise RuntimeError('A publishable/anon key is required.')
    # These values are public OAuth configuration, never service credentials.
    (ROOT / 'consent/consent-config.json').write_text(json.dumps({
        'projectURL': PROJECT_URL, 'publishableKey': publishable,
        'clientID': STATE['client_id'], 'consentOrigin': CONSENT_ORIGIN}, indent=2) + '\n')
    request(MANAGEMENT + '/secrets', 'POST', [
        {'name': 'MCP_PUBLISHABLE_KEY', 'value': publishable},
        {'name': 'MCP_OWNER_ID', 'value': CONFIG['userID']},
        {'name': 'MCP_CLIENT_ID', 'value': STATE['client_id']},
        {'name': 'MCP_WRITES_ENABLED', 'value': 'false'},
    ])
    sql('INSERT INTO streamline_mcp_private.settings(singleton,owner_id,client_id,enabled,writes_enabled) VALUES(true,'
        + literal(CONFIG['userID']) + '::uuid,' + literal(STATE['client_id'])
        + ',true,false) ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,client_id=excluded.client_id,enabled=true,writes_enabled=false', False)
    STATE['resource_url'] = PROJECT_URL + '/functions/v1/streamline-mcp'
    STATE['consent_url'] = CONSENT_ORIGIN + CONSENT_PATH
    STATE['consent_hosting_paused'] = False
    save()
    print('Configured owner-only OAuth, disabled public signup and dynamic registration, preserved native callback, and set read-only gates.')
    print('Public OAuth client ID:', STATE['client_id'])
    print('MCP URL:', STATE['resource_url'])

def status():
    print('Project:', REF)
    print('Hosted settings:', sql('SELECT enabled,writes_enabled FROM streamline_mcp_private.settings'))
    print('Guarded native functions:', sql('SELECT signature FROM streamline_mcp_private.guarded_functions'))
    print('OAuth restrictive policy count:', sql("SELECT count(*) FROM pg_policies WHERE policyname='streamline_block_oauth_direct'"))
    print('Recent tool metadata:', sql('SELECT tool,succeeded,count(*) FROM streamline_mcp_private.audit GROUP BY tool,succeeded ORDER BY tool'))

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['apply-schema', 'apply-recurrence', 'configure-auth', 'status', 'disable', 'enable-writes'])
parser.add_argument('--connection-verified', action='store_true', help='Required after a successful owner-authorized Claude connection test.')
args = parser.parse_args()
try:
    if args.action == 'apply-schema': apply_schema()
    elif args.action == 'apply-recurrence': apply_recurrence()
    elif args.action == 'configure-auth': configure_auth()
    elif args.action == 'status': status()
    elif args.action == 'disable':
        sql('UPDATE streamline_mcp_private.settings SET enabled=false,writes_enabled=false', False)
        print('All hosted data access revoked immediately; native/local clients unaffected.')
    elif args.action == 'enable-writes':
        if STATE.get('consent_hosting_paused'): raise RuntimeError('Migrate and verify consent hosting before enabling writes.')
        if not args.connection_verified: raise RuntimeError('Verify the owner-authorized Claude connection before enabling writes.')
        request(MANAGEMENT + '/secrets', 'POST', [{'name':'MCP_WRITES_ENABLED','value':'true'}])
        sql('UPDATE streamline_mcp_private.settings SET writes_enabled=true WHERE enabled', False)
        print('Guarded write tools enabled. Reconnect Claude to refresh its tool list.')
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
