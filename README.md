# Mustard — Farcaster Miniapp

A Farcaster miniapp demo built with React + Vite (frontend) and Hono (backend).

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose
- Or, for local (non-Docker) development: Node.js 20+ and npm

## Quick start (Docker)

```bash
docker compose up --build
```

This starts:

- **Frontend** at http://localhost:5174 (nginx serving the built Vite app)
- **Backend** at http://localhost:3300 (Hono API)

The backend reaches services on the host machine via `host.docker.internal` (works out of the box on macOS/Windows). On Linux, uncomment the `extra_hosts` block in [docker-compose.yml](docker-compose.yml).

To stop:

```bash
docker compose down
```

## Local development (without Docker)

Install dependencies (run once in each workspace):

```bash
npm install --legacy-peer-deps
cd backend && npm install && cd ..
```

Run frontend and backend in separate terminals:

```bash
npm run dev          # frontend on http://localhost:5174
npm run dev:backend  # backend on http://localhost:3300
```

## Public URL for testing (ngrok)

The Notification Server (NS) and the Farcaster client reach your miniapp over the public internet — they **cannot call `localhost`**. To test anything that involves NS webhooks (or to load the manifest in a real client), you must expose your local app through a public tunnel. This repo wires up [ngrok](https://ngrok.com) for that, as the `ngrok` service in [docker-compose.yml](docker-compose.yml).

1. Create an ngrok account and claim a static domain (ngrok dashboard → **Domains**).
2. Copy `.env.example` to `.env` and fill in:

   ```bash
   NGROK_AUTHTOKEN=...                            # https://dashboard.ngrok.com/get-started/your-authtoken
   NGROK_DOMAIN=your-name.ngrok-free.dev          # the static domain you claimed
   PUBLIC_HOST=https://your-name.ngrok-free.dev   # must match NGROK_DOMAIN
   ```

3. Start the stack with `docker compose up --build`. The `ngrok` service tunnels the frontend at `https://<NGROK_DOMAIN>`, and nginx forwards `/webhook` to the backend — so NS can deliver webhooks to `https://<NGROK_DOMAIN>/webhook`.
4. Point the manifest at the public URL: every URL in [public/.well-known/farcaster.json](public/.well-known/farcaster.json) — including `webhookUrl` — must use `https://<NGROK_DOMAIN>`, not `localhost`. Give that `webhookUrl` to the Startale team so NS registers it.

The ngrok request inspector is at http://localhost:4040.

> Without a public URL, NS webhooks never reach your backend — there is no route from NS to `localhost`. Any tunnelling service works; ngrok is just what this repo ships with.

## Useful endpoints

- App: http://localhost:5174
- Farcaster manifest: http://localhost:5174/.well-known/farcaster.json
- Backend API: http://localhost:3300
