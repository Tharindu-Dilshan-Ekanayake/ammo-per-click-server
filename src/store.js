const { MongoClient } = require('mongodb')

/**
 * Where saves and purchases live.
 *
 * On Bloxity Legion that is the game's own managed MongoDB: every game and channel
 * gets an isolated database and a user scoped to it, handed over as MONGODB_URI.
 * Nothing to provision - read the variable and connect. Every pod of the game shares
 * it, which is what lets a save made on one pod be loaded on another, and a purchase
 * webhook land on any pod at all.
 *
 * Without MONGODB_URI (local development) the same interface is backed by memory, so
 * the game runs end to end on a laptop; it simply forgets everything on restart.
 *
 * Three collections:
 *   saves         { _id: userId, progress, rev, username, updatedAt }
 *   entitlements  { _id: userId, skus: [sku...] }          - kept Bux items bought
 *   purchases     { _id: transactionId, userId, sku, ... }  - every webhook, once
 */

function memoryStore() {
  const saves = new Map()
  const entitlements = new Map()
  const purchases = new Map()
  return {
    kind: 'memory',
    async getSave(userId) {
      return saves.get(userId) ?? null
    },
    async putSave(userId, progress, username) {
      const rev = (saves.get(userId)?.rev ?? 0) + 1
      saves.set(userId, { progress, rev, username, updatedAt: new Date() })
      return rev
    },
    async getEntitlements(userId) {
      return [...(entitlements.get(userId) ?? [])]
    },
    async topSaves(field, limit) {
      return [...saves.values()]
        .filter((save) => save.username && save.progress?.[field] > 0)
        .sort((a, b) => b.progress[field] - a.progress[field])
        .slice(0, limit)
        .map((save) => ({ username: save.username, value: save.progress[field] }))
    },
    async recordPurchase(purchase, keep) {
      if (purchases.has(purchase._id)) return false
      purchases.set(purchase._id, purchase)
      if (keep) {
        const set = entitlements.get(purchase.userId) ?? new Set()
        set.add(purchase.sku)
        entitlements.set(purchase.userId, set)
      }
      return true
    },
    async close() {},
  }
}

async function mongoStore(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 })
  await client.connect()
  // The URI names this game's own database; `db()` with no argument uses it.
  const db = client.db()
  const saves = db.collection('saves')
  const entitlements = db.collection('entitlements')
  const purchases = db.collection('purchases')
  await purchases.createIndex({ userId: 1 })
  // One per leaderboard (see routes.js), so the boards never scan every save.
  await Promise.all(['wins', 'rebirths', 'bossLevel'].map((field) => saves.createIndex({ [`progress.${field}`]: -1 })))

  return {
    kind: 'mongo',
    async getSave(userId) {
      return saves.findOne({ _id: userId })
    },
    async putSave(userId, progress, username) {
      // One atomic step, so two tabs saving at once still get two distinct revisions.
      const doc = await saves.findOneAndUpdate(
        { _id: userId },
        { $set: { progress, username, updatedAt: new Date() }, $inc: { rev: 1 } },
        { upsert: true, returnDocument: 'after', projection: { rev: 1 } },
      )
      return doc.rev
    },
    async getEntitlements(userId) {
      const doc = await entitlements.findOne({ _id: userId })
      return doc?.skus ?? []
    },
    /** The `limit` best saves by `progress[field]`, as `{ username, value }`. */
    async topSaves(field, limit) {
      const key = `progress.${field}`
      const docs = await saves
        .find({ username: { $nin: ['', null] }, [key]: { $gt: 0 } }, { projection: { username: 1, [key]: 1 } })
        .sort({ [key]: -1 })
        .limit(limit)
        .toArray()
      return docs.map((doc) => ({ username: doc.username, value: doc.progress[field] }))
    },
    /**
     * Records one webhook. Returns false if this transaction was already recorded -
     * Bloxity retries a webhook that did not get a 2xx, and a retry must not grant
     * twice. The transaction id is the document id, so the database itself refuses
     * the duplicate even when two pods receive the retry at the same moment.
     */
    async recordPurchase(purchase, keep) {
      try {
        await purchases.insertOne(purchase)
      } catch (error) {
        if (error?.code === 11000) return false
        throw error
      }
      if (keep) {
        await entitlements.updateOne({ _id: purchase.userId }, { $addToSet: { skus: purchase.sku } }, { upsert: true })
      }
      return true
    },
    async close() {
      await client.close()
    },
  }
}

/** Connects to MONGODB_URI if set, otherwise falls back to memory (and says so). */
async function openStore() {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    console.warn('[store] MONGODB_URI is not set - saves and purchases are kept in memory only')
    return memoryStore()
  }
  const store = await mongoStore(uri)
  console.log('[store] connected to MongoDB')
  return store
}

module.exports = { openStore, memoryStore }
