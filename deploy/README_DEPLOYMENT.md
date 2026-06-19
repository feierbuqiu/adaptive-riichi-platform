# MVP Deployment Notes

This MVP is designed for the cheapest practical AWS setup first:

- one small EC2 instance in `ap-east-1` Hong Kong
- Docker Compose
- Caddy for HTTPS
- SQLite WAL on the EC2 disk
- no RDS, no NAT Gateway, no CDN dependency for the first public test

## Server Files

Deploy the repository root, not only `adaptive-test-app/`, because the app mounts these root-level assets:

- `private-data/practice-bank/bank.config.json`
- the private practice JSONL source named by that config
- optional private examination assets required by your deployment
- `svg-tiles/simple_tiles/`

The SQLite database is stored at:

```text
adaptive-test-app/data/app.sqlite
```

Do not place `adaptive-test-app/data/` under a public web root.

## First Server Setup

Install Docker and Docker Compose on the EC2 instance, then from the repository root:

```bash
node adaptive-test-app/scripts/generate-secrets.mjs admin
cp adaptive-test-app/.env.example adaptive-test-app/.env
```

Paste the generated secrets into `adaptive-test-app/.env`, replace `ADMIN_PASSWORD` with a long unique password, and add the generated TOTP secret to an authenticator app.

Validate and start:

```bash
docker compose config --quiet
docker compose up -d --build --force-recreate
docker compose logs -f
```

Keep `EXAM_ENABLED=false` while only practice mode is public. Verify that `/exam` and the exam APIs return `403` after deployment.

## DNS

For the first MVP test, use simple DNS records:

```text
example.com        A  <EC2 public IPv4>  DNS only
admin.example.com  A  <EC2 public IPv4>  DNS only initially
```

After Caddy has obtained certificates and admin login is verified, the public
and administrative hosts can be placed behind an approved reverse proxy. Keep
app-level administrator password, TOTP, CSRF, and session checks enabled even
when an additional edge control is used.

## EC2 Security Group

Minimum inbound rules:

```text
80/tcp   0.0.0.0/0
443/tcp  0.0.0.0/0
22/tcp   your current admin IP only
```

If using AWS Systems Manager Session Manager, remove SSH from public inbound rules after SSM is working.

## Backups

Manual low-cost backup command:

```bash
mkdir -p adaptive-test-app/data/backups
docker compose exec -T app node scripts/backup-db.mjs /var/lib/adaptive-test/backups/app-YYYYMMDD-HHMMSS.sqlite
```

Download the backup file periodically. For longer tests, add a daily cron job and optionally sync the backup directory to a cheap S3 bucket.

## Updating

```bash
docker compose config --quiet
docker compose build app
docker compose up -d --force-recreate app caddy
docker compose ps
```

Do not delete `adaptive-test-app/data/` unless intentionally wiping all attempts, generated access codes, sessions, and admin data.
