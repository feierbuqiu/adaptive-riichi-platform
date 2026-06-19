# Riichi Mahjong Practice and Assessment App

One service hosting two isolated subsystems:

- `/practice`: open, untimed practice with server-side selection and scoring.
- `/exam`: adaptive assessment, disabled until `EXAM_ENABLED=true`.
- `/admin`: administration and practice-data exports, available only on an admin hostname in production.

This implementation intentionally avoids external npm dependencies for the first deploy:

- Node.js HTTP server
- built-in `node:sqlite`
- server-side scoring, timing, sessions, and admin APIs
- static user/admin frontends

Run and verify locally:

```powershell
cd adaptive-test-app
npm test
npm run check
node src/server.js
```

Default development credentials are created only when `NODE_ENV !== production`:

- user access code: `DEMO-TEST-CODE`
- admin username: `admin`
- admin password: `DevOnly-ChangeMe!`

Production must set the secrets in `.env`; never put that file into the image or a public directory. The practice bank and SVG tile directory are mounted read-only by the root Compose file.

Recommended production deploy:

```powershell
node scripts/generate-secrets.mjs admin
```

Copy `.env.example` to `.env`, paste the generated secrets, set a strong `ADMIN_PASSWORD`, then run the root-level Docker Compose file:

```powershell
docker compose up -d --build
```

Before every update, back up `adaptive-test-app/data/app.sqlite`. Then validate and recreate the containers so the new read-only mounts are active:

```bash
docker compose config --quiet
docker compose build app
docker compose up -d --force-recreate app caddy
docker compose ps
```

Required practice mounts are a private directory containing `bank.config.json`
and its configured JSONL source, plus `svg-tiles/simple_tiles/`. See
`docs/PRACTICE_BANK_SCHEMA.md` at the repository root. Keep
`EXAM_ENABLED=false` until the exam is explicitly opened.
