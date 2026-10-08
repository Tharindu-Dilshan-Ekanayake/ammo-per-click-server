const { BUX_ITEMS, SAVE_FIELD, isKept, itemForSku } = require('./catalog')

/**
 * What a saved game may contain, and the cleaning every save gets on the way in.
 *
 * The game is a single-player clicker at heart: Ammo and Wins are counted in the
 * browser, and the server cannot replay every click to check them. What it can do is
 * refuse anything malformed, keep numbers finite and inside JavaScript's exact range,
 * keep lists short and made of short strings - and above all refuse Bux items the
 * account never paid for. Those are the ones worth cheating for, and those it knows
 * for certain: the purchase webhook told it (see routes.js).
 */

/** Numbers in a save: finite, not negative, at most this. */
const MAX_NUMBER = Number.MAX_SAFE_INTEGER * 1e6
const MAX_LIST = 200
const MAX_ID = 40

const NUMBERS = ['ammo', 'rebirths', 'wins', 'bestWall', 'spaceBest', 'caveBest', 'bossLevel']
const LISTS = ['owned', 'ownedPets', 'equippedPets', 'unlockedTrainers', 'ownedPasses']
const STRINGS = ['equipped']
const BOOLEANS = ['opAutoOwned', 'autoWins']

const cleanNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_NUMBER) : 0

const cleanList = (value) =>
  Array.isArray(value)
    ? [...new Set(value.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID))].slice(
        0,
        MAX_LIST,
      )
    : []

/** A running boost `{ multiplier, until }`, or null. */
function cleanBoost(value) {
  if (!value || typeof value !== 'object') return null
  const multiplier = cleanNumber(value.multiplier)
  const until = cleanNumber(value.until)
  if (![2, 4, 8].includes(multiplier) || !until) return null
  return { multiplier, until }
}

/** The ids of every Bux item of each kind the account owns, from its SKUs. */
function ownedByKind(entitlements) {
  const out = {}
  for (const sku of entitlements) {
    const item = itemForSku(sku)
    if (!item || !isKept(item)) continue
    ;(out[item.kind] ??= new Set()).add(item.id)
  }
  return out
}

/** Every Bux item id that needs a purchase behind it, by save field. */
const BUX_IDS = (() => {
  const out = {}
  for (const item of BUX_ITEMS) {
    if (!isKept(item)) continue
    ;(out[SAVE_FIELD[item.kind]] ??= new Set()).add(item.id)
  }
  return out
})()

/**
 * A save as the client sent it, made safe to store: every field typed and bounded,
 * nothing unknown kept, and any Bux item the account has not bought taken out.
 *
 * Returns null if `input` is not an object at all.
 *
 * @param {unknown} input
 * @param {string[]} entitlements SKUs this account has bought
 */
function sanitizeProgress(input, entitlements = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const out = {}
  for (const key of NUMBERS) out[key] = cleanNumber(input[key])
  for (const key of LISTS) out[key] = cleanList(input[key])
  for (const key of STRINGS) out[key] = typeof input[key] === 'string' ? input[key].slice(0, MAX_ID) : null
  for (const key of BOOLEANS) out[key] = input[key] === true
  out.boost = cleanBoost(input.boost)
  out.rebirths = Math.floor(out.rebirths)
  out.bossLevel = Math.max(1, Math.floor(out.bossLevel))

  // Strip what was never paid for.
  const owned = ownedByKind(entitlements)
  for (const [kind, field] of Object.entries(SAVE_FIELD)) {
    const sold = BUX_IDS[field]
    if (!sold) continue
    out[field] = out[field].filter((id) => !sold.has(id) || owned[kind]?.has(id))
  }
  // A pet that is not owned cannot be following you, nor a gun in your hand.
  out.equippedPets = out.equippedPets.filter((id) => out.ownedPets.includes(id))
  if (out.equipped && !out.owned.includes(out.equipped)) out.equipped = out.owned[0] ?? null
  if (!out.equipped) delete out.equipped
  return out
}

/**
 * A stored save, with everything the account has bought added in. A purchase made
 * on another device - or one whose webhook landed after the last save - shows up
 * here, which is what makes a pass follow the account rather than the browser.
 */
function withEntitlements(progress, entitlements = []) {
  const out = { ...progress }
  const owned = ownedByKind(entitlements)
  for (const [kind, field] of Object.entries(SAVE_FIELD)) {
    const ids = owned[kind]
    if (!ids) continue
    out[field] = [...new Set([...(out[field] ?? []), ...ids])]
  }
  return out
}

module.exports = { sanitizeProgress, withEntitlements }
