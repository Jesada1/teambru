# AI Timetable Engine — Offline / Docker Quick Start

Run the full scheduling UI + CSP engine locally with **no internet** after the image is built.

## 1-line start

```bash
docker compose up -d
```

## Open the app

**http://localhost:3000**

## Useful commands

```bash
# Build + start (first time)
docker compose up -d --build

# Follow logs
docker compose logs -f timetable

# Stop
docker compose down
```

## Offline notes

- The solver (`engine/solver.ts`) runs entirely inside the app — no cloud API calls.
- Compose sets `OFFLINE_MODE=true`, disables Next telemetry, and uses a local SQLite `DATABASE_URL`.
- Port mapping: **3000:3000**.
- After the image exists on the machine, `docker compose up -d` works without downloading packages again.

## Judges / demo credentials

No login is required for the default offline demo. Upload a CSV template from the UI (Small / Medium / Large) and click **Confirm & Generate Schedule**.
