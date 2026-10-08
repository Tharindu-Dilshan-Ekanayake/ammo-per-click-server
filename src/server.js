const cors = require('cors')
const express = require('express')

const { attachRealtime, originIsAllowed } = require('./realtime')

const PORT = process.env.PORT || 3000

/**
 * Every browser origin allowed to open a lobby socket.
 *
 * Three sources, because three different things know a piece of the answer. The
 * Vite dev origins are constants and belong in the code. `CLIENT_ORIGIN` is what
 * Bloxity Legion sets to the game's own address, so on Legion the main one needs no
 * configuring at all. `ALLOWED_ORIGINS` is the comma-separated list for everything
 * else - preview builds, a phone on the Wi-Fi, a second front end.
 */
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.CLIENT_ORIGIN ? [process.env.CLIENT_ORIGIN.trim()] : []),
  ...(process.env.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? []),
]

// Express and the lobby room (Colyseus, over ws://host/ws-ish matchmaking - see
// realtime.js) share one HTTP server and port; Colyseus owns the Express app.
const realtime = attachRealtime({ allowedOrigins: ALLOWED_ORIGINS })
const { app } = realtime

app.use(
  cors({
    // A function, not the plain array, so a Legion-hosted build of this game is
    // trusted the same way the socket already trusts it - see originIsAllowed's
    // own comment in realtime.js for why that one extra case is safe.
    origin: (origin, callback) => callback(null, originIsAllowed(origin, ALLOWED_ORIGINS)),
    credentials: true,
  }),
)
app.use(express.json())

/**
 * Two paths, one answer.
 *
 * `/health` is the one Bloxity Legion polls: a new deploy is given no traffic until
 * it replies, and a pod that stops replying is replaced. `/api/health` is what
 * render.yaml points at and what everything in this repo already used. Keeping both
 * costs a line and means neither host has to be talked out of its own convention.
 */
const health = (_req, res) => res.json({ ok: true })
app.get('/health', health)
app.get('/api/health', health)

/**
 * Auth passthrough for the Bloxity SDK.
 *
 * The frontend will POST `{ token, user }` here from
 * `Legion.SDK.auth.authenticateWithServer('/api/legion-auth')`.
 *
 * NOTE: not wired up on the frontend yet — this milestone is login + avatar +
 * movement. When you do wire it, call `authenticateWithServer` from
 * `client/src/bloxity/BloxityProvider.jsx` inside the `onUserChanged` handler, right
 * after a non-null user arrives, and stash the returned accessToken for your own
 * API calls.
 */
app.post('/api/legion-auth', (req, res) => {
  console.log('[legion-auth] payload:', JSON.stringify(req.body, null, 2))

  // TODO: verify the Bloxity JWT here before trusting req.body.user.
  // Until that happens `req.body.user` is attacker-controlled — anyone can POST any
  // legionId they like. Verify `req.body.token` against Bloxity's public key /
  // introspection endpoint and derive the user from the *verified* claims, not from
  // the body.

  res.json({
    accessToken: 'stub',
    user: { legionId: req.body.user?._id },
  })
})

/**
 * Webhook for future Bux purchases.
 * Responds 200 immediately — the platform will retry on anything else, so do the
 * real work asynchronously rather than holding the response open.
 */
app.post('/api/legion-webhook', (req, res) => {
  console.log('[legion-webhook] payload:', JSON.stringify(req.body, null, 2))

  // TODO: verify x-legion-webhook-secret header, dedupe by transactionId, grant the item.

  res.sendStatus(200)
})

/** Open lobbies and how full they are. */
app.get('/api/lobbies', (_req, res) => {
  res.json({ lobbies: realtime.lobbies.list() })
})

realtime.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT} (lobbies over Colyseus)`)
})

/**
 * Let the host drain this process instead of cutting it off.
 *
 * A rolling deploy sends SIGTERM and then waits a while before killing what is
 * left. Node's default answer to SIGTERM is to die on the spot - and every player
 * in a lobby is holding a WebSocket open, so that drops all of them, mid-game, on
 * every single deploy. Colyseus's graceful shutdown closes the rooms first, which
 * gives each client an ordinary disconnect it already knows how to reconnect from
 * (see the retry backoff in the client's lobbyClient.js).
 *
 * Nothing is persisted on the way out because there is nothing to persist: lobbies
 * are in-memory and disposable by design.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received - draining lobbies`)
    realtime.close().then(
      () => process.exit(0),
      (error) => {
        console.error('graceful shutdown failed:', error)
        process.exit(1)
      },
    )
  })
}
