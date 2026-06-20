# MVP Deployment Notes

This MVP is designed for the cheapest practical AWS setup first:

- one small EC2 instance in `ap-east-1` Hong Kong
- Docker Compose
- Caddy for HTTPS
- SQLite WAL on the EC2 disk
- no RDS, no NAT Gateway, no CDN dependency for the first public test

## Server Files

Deploy the repository root, not only `app/`, because the app mounts these
root-level assets:

- `private-data/practice-bank/bank.config.json`
- the private practice JSONL source named by that config
- optional private examination assets required by your deployment
- `assets/mahjong-tiles/tiles/`

The SQLite database is stored at:

```text
private-data/app/app.sqlite
```

Do not place `private-data/app/` under a public web root.

## First Server Setup

Install Docker and Docker Compose on the EC2 instance, then from the repository root:

```bash
node app/scripts/generate-secrets.mjs admin
cp app/.env.example app/.env
```

Paste the generated secrets into `app/.env`, replace `ADMIN_PASSWORD` with a
long unique password, and add the generated TOTP secret to an authenticator
app.

Validate and start:

```bash
docker compose -f deploy/docker-compose.example.yml config --quiet
docker compose -f deploy/docker-compose.example.yml up -d --build --force-recreate
docker compose -f deploy/docker-compose.example.yml logs -f
```

Keep `EXAM_ENABLED=false` while only practice mode is public. Verify that `/exam` and the exam APIs return `403` after deployment.

## DNS

For the first MVP test, use simple DNS records:

```text
example.com        A  <EC2 public IPv4>  DNS only
admin.example.com  A  <EC2 public IPv4>  DNS only initially
```

After Caddy has obtained certificates and admin login is verified, the public
and administrative hosts can be placed behind an approved reverse proxy. Do
not enable browser challenges, CAPTCHA, Turnstile, or an access interstitial.
Keep app-level administrator password, TOTP, CSRF, rate limits, and session
checks enabled.

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
mkdir -p private-data/app/backups
docker compose -f deploy/docker-compose.example.yml exec -T app node scripts/backup-db.mjs /var/lib/adaptive-test/backups/app-YYYYMMDD-HHMMSS.sqlite
```

Download the backup file periodically. For longer tests, add a daily cron job and optionally sync the backup directory to a cheap S3 bucket.

## Updating

```bash
docker compose -f deploy/docker-compose.example.yml config --quiet
docker compose -f deploy/docker-compose.example.yml build app
docker compose -f deploy/docker-compose.example.yml up -d --force-recreate app caddy
docker compose -f deploy/docker-compose.example.yml ps
```

Do not delete `private-data/app/` unless intentionally wiping all attempts,
generated access codes, sessions, and administrator data.
