# Adaptive Riichi Platform

An open-source Node.js platform for adaptive Riichi Mahjong examinations,
untimed practice, administration, response collection, ranking, and
anti-abuse analysis.

## Repository scope

This repository contains the reusable application and deployment framework.
It intentionally does **not** contain any production question bank, answer
key, research image, questionnaire response, examination result, practice
response, statistics export, database, backup, credential, or API token.

Private content is supplied at runtime through read-only mounts and environment
configuration. The public application must remain usable with independently
created data conforming to the documented schemas.

## Architecture

- Node.js modular monolith
- SQLite persistence
- Native HTML, CSS, and JavaScript clients
- Caddy reverse proxy
- Docker Compose deployment
- Server-side scoring, authorization, rate limiting, and audit controls

## Repository layout

```text
app/                     Application source, browser clients, scripts, and tests
assets/mahjong-tiles/   Public Mahjong SVG assets and demos
deploy/                  Public Caddy and Docker Compose templates
docs/                    Data contracts and signed-release evidence
examples/                Safe example runtime data
```

## Local checks

```bash
cd app
npm run check
npm test
```

Copy `app/.env.example` to `app/.env`, provide a private practice bank and any
optional examination assets, then use `deploy/docker-compose.example.yml` as
the deployment starting point.

## Data boundary

Never commit real question banks, answers, user data, SQLite files, `.env`
files, deployment archives, backups, SSH keys, or cloud credentials. The root
`.gitignore` uses an allowlist so unrelated workspace files remain private.

## Repository integrity

All commits and annotated tags on the default branch are expected to use SSH
signatures and appear as **Verified** on GitHub. Push access uses a separate SSH
authentication key.

## License

Application code is released under the MIT License. Third-party Mahjong SVG
assets retain the terms recorded in `assets/mahjong-tiles/NOTICE.md`.
