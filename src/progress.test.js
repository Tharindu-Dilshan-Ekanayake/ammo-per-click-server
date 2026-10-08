const assert = require('node:assert/strict')
const { test } = require('node:test')

const { sanitizeProgress, withEntitlements } = require('./progress')

test('rejects anything that is not a save', () => {
  assert.equal(sanitizeProgress(null), null)
  assert.equal(sanitizeProgress('ammo'), null)
  assert.equal(sanitizeProgress([1, 2]), null)
})

test('keeps numbers finite, positive and whole where they must be', () => {
  const out = sanitizeProgress({ ammo: -5, wins: Infinity, rebirths: 2.7, bossLevel: 0, bestWall: '9' })
  assert.equal(out.ammo, 0)
  assert.equal(out.wins, 0)
  assert.equal(out.rebirths, 2)
  assert.equal(out.bossLevel, 1)
  assert.equal(out.bestWall, 0)
})

test('drops Bux items that were never bought, keeps the ones that were', () => {
  const save = {
    owned: ['starter', 'space', 'phantom', 'celestial'],
    equipped: 'celestial',
    ownedPasses: ['power2x', 'wins2x'],
    unlockedTrainers: ['target-1', 'vip-2'],
    ownedPets: ['common', 'exclusive'],
    equippedPets: ['exclusive', 'common'],
  }
  const out = sanitizeProgress(save, ['gun_phantom_blaster', 'pass_2x_wins'])
  assert.deepEqual(out.owned, ['starter', 'space', 'phantom'])
  assert.deepEqual(out.ownedPasses, ['wins2x'])
  assert.deepEqual(out.unlockedTrainers, ['target-1'])
  assert.deepEqual(out.ownedPets, ['common'])
  // Nothing un-owned may be following you, or in your hand.
  assert.deepEqual(out.equippedPets, ['common'])
  assert.equal(out.equipped, 'starter')
})

test('a SKU the game does not sell grants nothing', () => {
  const out = withEntitlements({ owned: ['starter'] }, ['ammo_pack_1m'])
  assert.deepEqual(out.owned, ['starter'])
  assert.equal(out.ownedPasses, undefined)
})

test('a load hands back everything the account bought', () => {
  const out = withEntitlements({ owned: ['starter'], ownedPasses: [] }, ['gun_celestial_minigun', 'pass_auto_wins'])
  assert.deepEqual(out.owned, ['starter', 'celestial'])
  assert.deepEqual(out.ownedPasses, ['autoWins'])
})

test('lists are de-duplicated, string-only and bounded', () => {
  const out = sanitizeProgress({ owned: ['a', 'a', 7, '', 'x'.repeat(100), 'b'] })
  assert.deepEqual(out.owned, ['a', 'b'])
})

test('footprints need the gun, and only bought ones can be worn', () => {
  const out = sanitizeProgress({ owned: ['starter', 'space'], ownedFootprints: ['starter', 'lava'], footprints: 'lava' })
  assert.deepEqual(out.ownedFootprints, ['starter'])
  assert.equal(out.footprints, null)
  const worn = sanitizeProgress({ owned: ['starter'], ownedFootprints: ['starter'], footprints: 'starter' })
  assert.equal(worn.footprints, 'starter')
})
