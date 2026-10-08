const crypto = require('node:crypto')
const express = require('express')

const { requireUser, verifyToken } = require('./auth')
const { isKept, itemForSku, SAVE_FIELD } = require('./catalog')
const { sanitizeProgress, withEntitlements } = require('./progress')

/** Least time between two saves from one account; anything faster is turned away. */
const MIN_SAVE_GAP_MS = 1000
/** A save is a few kilobytes; anything near this is not one. */
const MAX_BODY = '64kb'

/**
 * The slug Bloxity puts in every webhook for this game, when we know it. A webhook
 * for some other game is refused rather than granted here.
 */
const GAME_SLUG = process.env.BLOXITY_GAME_SLUG || process.env.BLOXITY_GAME_ID || ''

/**
 * Optional shared secret for the purchase webhook. When it is set, a webhook without
 * a matching `x-legion-webhook-secret` header is refused; see the README for why it
 * matters and how to set it.
 */
const WEBHOOK_SECRET = process.env.LEGION_WEBHOOK_SECRET || ''

/** Constant-time string comparison, so the secret cannot be guessed a byte at a time. */
function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Bloxity ids sometimes travel with a "legion_" prefix; saves are keyed without it. */
const plainUserId = (id) => String(id).replace(/^legion_/, '')

/**
 * Every Bux item an account owns, as the ids the game uses, by save field - so the
 * client can add them to whatever it is holding, whichever copy of the save wins.
 */
function granted(entitlements) {
  const out = Object.fromEntries(Object.values(SAVE_FIELD).map((field) => [field, []]))
  for (const sku of entitlements) {
    const item = itemForSku(sku)
    if (item && isKept(item)) out[SAVE_FIELD[item.kind]].push(item.id)
  }
  return out
}

/**
 * The game's HTTP API, mounted on the same Express app (and port) as Colyseus.
 *
 *   GET  /api/progress         the signed-in player's save, with their purchases in it
 *   PUT  /api/progress         store it
 *   POST /api/progress/beacon  store it, from a page that is closing (see below)
 *   POST /api/legion-webhook   Bloxity telling us a purchase went through
 *
 * The first two are the player's own browser, carrying their Bloxity token (see
 * auth.js). The webhook is Bloxity's server talking to ours, and can arrive at any
 * pod of the game - so it touches only the database, never a pod's memory.
 *
 * @param {import('express').Application} app
 * @param {Awaited<ReturnType<import('./store').openStore>>} store
 */
function mountRoutes(app, store) {
  const json = express.json({ limit: MAX_BODY })

  app.get('/api/progress', requireUser, async (req, res) => {
    try {
      const [save, entitlements] = await Promise.all([
        store.getSave(req.user.id),
        store.getEntitlements(req.user.id),
      ])
      res.json({
        progress: save ? withEntitlements(save.progress, entitlements) : null,
        rev: save?.rev ?? 0,
        granted: granted(entitlements),
      })
    } catch (error) {
      console.error('[progress] load failed:', error)
      res.status(500).json({ error: 'could not load your progress' })
    }
  })

  /** userId -> time of their last accepted save. Per pod, which is plenty for a rate limit. */
  const lastSave = new Map()

  /** The shared half of both ways of saving: cleaned, then stored. Answers { status, body }. */
  async function storeSave(user, input) {
    const now = Date.now()
    if (now - (lastSave.get(user.id) ?? 0) < MIN_SAVE_GAP_MS) return { status: 429, body: { error: 'saving too often' } }
    lastSave.set(user.id, now)
    const entitlements = await store.getEntitlements(user.id)
    const progress = sanitizeProgress(input, entitlements)
    if (!progress) return { status: 400, body: { error: 'no progress in that request' } }
    const rev = await store.putSave(user.id, progress, user.username)
    return { status: 200, body: { rev } }
  }

  app.put('/api/progress', requireUser, json, async (req, res) => {
    try {
      const { status, body } = await storeSave(req.user, req.body?.progress)
      res.status(status).json(body)
    } catch (error) {
      console.error('[progress] save failed:', error)
      res.status(500).json({ error: 'could not save your progress' })
    }
  })

  /**
   * The last save from a page that is closing, sent with navigator.sendBeacon.
   *
   * A beacon cannot carry an Authorization header, and as `text/plain` it needs no
   * CORS preflight - which is the point: a closing page will not wait for one. So
   * the token comes in the body, `{ token, progress }`, and is checked exactly like
   * the header would have been. Nobody reads the answer.
   */
  app.post('/api/progress/beacon', express.text({ type: '*/*', limit: MAX_BODY }), async (req, res) => {
    let body
    try {
      body = JSON.parse(req.body)
    } catch {
      return res.status(400).end()
    }
    try {
      const user = await verifyToken(body?.token)
      if (!user) return res.status(401).end()
      const { status } = await storeSave(user, body.progress)
      res.status(status).end()
    } catch (error) {
      console.error('[progress] beacon save failed:', error)
      res.status(500).end()
    }
  })

  /**
   * Bloxity's purchase webhook: POST JSON { transactionId, userId, username, gameSlug,
   * sku, productName, productPrice, metadata, timestamp }.
   *
   * Anything but a 2xx makes Bloxity refund the player, so the answers are chosen:
   * 2xx once the purchase is safely recorded (or was already - a retry), 4xx for a
   * purchase this game cannot honour (unknown SKU, someone else's game), and 5xx if
   * the database is down - a refund is the right outcome when we could not record it.
   */
  app.post('/api/legion-webhook', json, async (req, res) => {
    if (WEBHOOK_SECRET && !sameSecret(req.get('x-legion-webhook-secret'), WEBHOOK_SECRET)) {
      console.warn('[webhook] refused: wrong or missing secret')
      return res.status(401).json({ error: 'bad secret' })
    }
    const body = req.body ?? {}
    const { transactionId, userId, sku } = body
    if (typeof transactionId !== 'string' || !transactionId || typeof userId !== 'string' || !userId) {
      return res.status(400).json({ error: 'transactionId and userId are required' })
    }
    if (GAME_SLUG && body.gameSlug && body.gameSlug !== GAME_SLUG) {
      console.warn(`[webhook] refused: for game "${body.gameSlug}", this is "${GAME_SLUG}"`)
      return res.status(400).json({ error: 'wrong game' })
    }
    const item = itemForSku(sku)
    if (!item) {
      console.warn(`[webhook] refused: unknown sku "${sku}" - add it to src/catalog.js`)
      return res.status(400).json({ error: 'unknown sku' })
    }

    const purchase = {
      _id: transactionId.slice(0, 200),
      userId: plainUserId(userId),
      username: typeof body.username === 'string' ? body.username.slice(0, 64) : '',
      sku: item.sku,
      kind: item.kind,
      itemId: item.id,
      price: typeof body.productPrice === 'number' ? body.productPrice : null,
      gameSlug: typeof body.gameSlug === 'string' ? body.gameSlug : null,
      paidAt: typeof body.timestamp === 'string' ? body.timestamp : null,
      receivedAt: new Date(),
    }
    try {
      const fresh = await store.recordPurchase(purchase, isKept(item))
      console.log(
        `[webhook] ${fresh ? 'recorded' : 'repeat of'} ${purchase._id}: ${purchase.username || purchase.userId} bought ${item.sku}`,
      )
      res.json({ ok: true, duplicate: !fresh })
    } catch (error) {
      console.error('[webhook] could not record purchase:', error)
      res.status(500).json({ error: 'could not record purchase' })
    }
  })
}

module.exports = { mountRoutes }
