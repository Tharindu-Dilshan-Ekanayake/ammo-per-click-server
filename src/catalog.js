/**
 * Every Bux product the game sells, by SKU: what kind of thing it is and the id the
 * game knows it by.
 *
 * Must match the client's game/catalog.js (and the IAPs in the Bloxity admin panel).
 * This copy is the one that counts: it is how the purchase webhook knows what a SKU
 * grants, and how a save is checked for Bux items nobody paid for.
 *
 * kind:
 *   gun / trainer / pet / pass  kept for good. Recorded against the account when the
 *                               webhook arrives, and handed back with every load.
 *   ammo                        spent on arrival. Recorded for the books only; the
 *                               Ammo itself travels with the rest of the save.
 */
const BUX_ITEMS = [
  { sku: 'gun_phantom_blaster', kind: 'gun', id: 'phantom' },
  { sku: 'gun_celestial_minigun', kind: 'gun', id: 'celestial' },
  { sku: 'target_vip_250x', kind: 'trainer', id: 'vip-1' },
  { sku: 'target_vip_1000x', kind: 'trainer', id: 'vip-2' },
  { sku: 'egg_exclusive', kind: 'pet', id: 'exclusive' },
  { sku: 'vip_wins_pad', kind: 'pass', id: 'vipWins' },
  { sku: 'pass_2x_power', kind: 'pass', id: 'power2x' },
  { sku: 'pass_2x_wins', kind: 'pass', id: 'wins2x' },
  { sku: 'pass_auto_wins', kind: 'pass', id: 'autoWins' },
  { sku: 'ammo_pack_100k', kind: 'ammo', id: 'ammo100k' },
  { sku: 'ammo_pack_1m', kind: 'ammo', id: 'ammo1m' },
  { sku: 'ammo_pack_10m', kind: 'ammo', id: 'ammo10m' },
]

const BY_SKU = new Map(BUX_ITEMS.map((item) => [item.sku, item]))

/** Which list in a save each kind of item lives in. */
const SAVE_FIELD = {
  gun: 'owned',
  trainer: 'unlockedTrainers',
  pet: 'ownedPets',
  pass: 'ownedPasses',
}

/** The catalogue entry for `sku`, or null if the game does not sell it. */
const itemForSku = (sku) => BY_SKU.get(sku) ?? null

/** Whether this kind of item is kept (and so has to be checked in saves). */
const isKept = (item) => item.kind in SAVE_FIELD

module.exports = { BUX_ITEMS, SAVE_FIELD, itemForSku, isKept }
