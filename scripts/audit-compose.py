import json, sys, os

try:
    import yaml
except ImportError:
    print("NO_YAML")
    sys.exit(0)

base = yaml.safe_load(open('docker-compose.yml', encoding='utf-8'))
stg = yaml.safe_load(open('docker-compose.staging.yml', encoding='utf-8'))

print(f"{'service':<16} {'restart':<16} {'ports (staging)':<34} {'limits':<12}")
for name in base.get('services', {}):
    b = base['services'][name] or {}
    s = (stg.get('services', {}) or {}).get(name, {}) or {}
    restart = s.get('restart', b.get('restart', '-'))
    ports = s.get('ports', b.get('ports', []))
    limited = (b.get('deploy') or s.get('deploy') or {}).get('resources', {}).get('limits')
    ports_s = ','.join(str(p) for p in (ports or []))[:32] or '-'
    print(f"{name:<16} {str(restart):<16} {ports_s:<34} {json.dumps(limited) if limited else '-'}")

print()
print("env.example keys:")
want = ['ACME_CA','ACME_EMAIL','DOMAIN','JWT_SECRET','TOKEN_ENCRYPTION_KEY','INTERNAL_API_TOKEN',
        'MONITORING_BASIC_AUTH_HASH','GRAFANA_ADMIN_PASSWORD','POSTGRES_PASSWORD','MONITORING_BASIC_AUTH_USER']
have = set()
for line in open('.env.example', encoding='utf-8'):
    if '=' in line and not line.strip().startswith('#'):
        have.add(line.split('=', 1)[0].strip())
for k in want:
    print(f"  {k:<32} {'OK' if k in have else 'MISSING'}")
