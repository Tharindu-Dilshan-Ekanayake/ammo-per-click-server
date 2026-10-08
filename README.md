# +1 Power Per Click — server

The multiplayer half of the game: lobby matchmaking and the position/swing relay
that lets players in the same lobby see each other. It is a Colyseus server on an
Express app, both on one port (see `src/realtime.js`).

The game plays fine without it. The client retries in the background and stays solo
until it connects, so the server being down or asleep costs nothing but company.

## Running it locally

```bash
npm install
npm run dev      # nodemon, restarts on save
npm start        # plain node
npm test         # the lobby matchmaking tests
```

It listens on `http://localhost:3000` unless `PORT` says otherwise.

## Environment

Copy `.env.example` for the full notes. The short version:

| variable | who sets it | what it does |
| --- | --- | --- |
| `PORT` | the host | port to listen on |
| `ALLOWED_ORIGINS` | you | comma-separated browser origins allowed to open a lobby socket |

`ALLOWED_ORIGINS` is the one that bites. Browsers always send an `Origin` header, and
`verifyClient` in `src/realtime.js` refuses any origin it does not recognise. The two
Vite dev origins are built in; every other one — the deployed game, a Netlify preview
URL, your phone on the Wi-Fi — has to be listed here or the socket is rejected with a
401 the player never sees. Origins are exact: scheme, host and port must match, and
there is no trailing slash.

The game is served from Netlify, so at minimum:

```
ALLOWED_ORIGINS=https://clicperpower.netlify.app
```

Netlify gives every branch and pull request its own origin
(`https://<branch>--clicperpower.netlify.app`,
`https://deploy-preview-<n>--clicperpower.netlify.app`). Those are separate origins and
are refused unless listed too, so add the ones you actually test from.

## Deploying to Bloxity Legion

This is the game's own hosting — one platform for both the client and this server,
already partly wired up (`/api/legion-auth`, `/api/legion-webhook`). Legion runs a
Docker image, not the source directly, so the moving parts are the `Dockerfile` at
the repo root and `.github/workflows/deploy.yml`, not `render.yaml`.

**One-time setup**, in this repo's GitHub settings:

| where | name | value |
| --- | --- | --- |
| Secrets and variables → Actions → **Secrets** | `LEGION_DEPLOY_TOKEN` | the deploy token from the Bloxity hosting page's "My Games" |
| Secrets and variables → Actions → **Variables** | `LEGION_GAME_ID` | this game's id, from the same page |

The deploy token is shown once and cannot be retrieved again — if it is lost,
generate a new one from the same page; the old one still works until then, so there
is no rush. It belongs only in that GitHub secret. If it ever ends up committed to a
file, deleting the line is not enough — regenerate it, because the old value stays
in the git history regardless.

**Then it deploys itself.** Push to `main` and the workflow builds an image, pushes
it to `ghcr.io`, and asks Legion to roll it out to the **prod** channel. Push to
`dev` and it goes to the **dev (playtest)** channel instead. Nothing else triggers
it.

**The first push only** — GHCR makes a new package private by default, and Legion
cannot pull a private image. On GitHub: your profile → **Packages** →
`power-per-click-server` → Package settings → **Change visibility → Public**. Do
this once, right after the first successful workflow run.

Legion sets `PORT`, `NODE_ENV`, `CLIENT_ORIGIN` (the game's own address, so
`ALLOWED_ORIGINS` below is usually not needed on this host), `JWT_SECRET`,
`MONGODB_URI`, `BLOXITY_GAME_ID`, `BLOXITY_CHANNEL` and `POD_NAME` on the running
container — none of these belong in `.env` or anywhere else in this repo.

## Deploying to Render

`render.yaml` is a Blueprint, so the service is defined here rather than in a
dashboard. In Render: **New → Blueprint**, pick this repo, and it reads the file. It
will ask for `ALLOWED_ORIGINS`; if you do not know the game's address yet, put
anything and correct it afterwards under the service's **Environment** tab.

Then point the client at it. In Netlify — **Site configuration → Environment
variables** — set

```
VITE_SERVER_URL=https://power-per-click-server.onrender.com
```

and **trigger a new deploy**. Vite bakes its environment into the bundle at build
time, so a variable added after a build does nothing to that build; the site keeps
whatever address it was built with until it is rebuilt. You can check which one a
deploy actually shipped by searching its `assets/index-*.js` for `onrender.com`.

Use the `https://` address, not `http://`. The client turns it into the socket URL by
swapping the scheme (`lobbyClient.js`), so `http://` becomes `ws://` — and a browser on
an HTTPS page blocks a plain `ws://` connection as mixed content, silently.

### What the free plan means here

- **It sleeps.** After about 15 minutes with no traffic the instance spins down, and
  the next request waits roughly a minute while it starts. The client's reconnect
  backoff (`RETRY_MS` in `lobbyClient.js`) keeps trying, so the player is dropped into
  a lobby when it wakes rather than being left offline — they just play solo until then.
- **One instance.** Lobbies live in this process's memory (`src/lobbies.js`), so a
  second instance would be a second, separate set of lobbies and two players could be
  "online" without ever meeting. Scaling past one needs a shared Colyseus driver and
  presence (Redis) first — do not raise the instance count before that.

## Not done yet

- `POST /api/legion-auth` trusts `req.body.user` without verifying the Bloxity token.
- `POST /api/legion-webhook` does not check its secret header or dedupe by transaction.

Both are marked in `src/server.js`. Neither is reachable from the client yet, but
neither should stay this way once Bux purchases are wired up.
