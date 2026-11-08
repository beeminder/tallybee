// Isolated cache quals: no browser or user data is involved.
// Run with node --test goals-cache-quals.js.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { read, save, check, datapoint } from './goals-cache.js'

class Storage {
  data = new Map()
  beforeSet = () => {}
  getItem(key) { return this.data.get(key) ?? null }
  setItem(key, value) { this.beforeSet(key, value); this.data.set(key, String(value)) }
  removeItem() { throw new Error('cache must not remove its prior value') }
}

const exact = (user, slug) => 'tallybee-goals ' + JSON.stringify([user, slug])
const catalogue = user => 'tallybee-goals ' + JSON.stringify([user])
const sample = (username = 'alice', value = 120) => ({
  user: { username, timezone: 'America/New_York' },
  goals: [
    { slug: 'pages', kyoom: false, safesum: '+5 pages', queued: false,
      deadline: 0, curval: 320,
      last_datapoint: { value, daystamp: '20261107', comment: 'last added' } },
    { slug: 'pushups', kyoom: true, safesum: '+10 pushups', queued: false,
      deadline: 0, curval: 0, last_datapoint: null },
  ],
})
let durable, session
beforeEach(() => {
  durable = new Storage()
  session = new Storage()
  Object.defineProperty(globalThis, 'localStorage', { value: durable, configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: session, configurable: true })
})

// Replicata: read a goal without any saved details.
// Expectata: null and no writes. Resultata to reject: invented cached details.
test('a missing cache returns null without creating records', () => {
  assert.equal(read('alice', 'pages'), null)
  assert.equal(durable.data.size, 0)
})

// Replicata: save each of two users' same-named goals, then read each.
// Expectata: each user's snapshot. Resultata to reject: another user's details.
test('snapshots are isolated by username and reads cannot mutate them', () => {
  save(sample(), 'pages')
  save(sample('bob', 800), 'pages')
  assert.deepEqual(read('alice', 'pages'), sample())
  assert.deepEqual(read('bob', 'pages'), sample('bob', 800))
  read('alice', 'pages').goals[0].last_datapoint.value = -1
  assert.deepEqual(read('alice', 'pages'), sample())
})

// Replicata: save pages' last-added reading 120; refresh pushups with the
// catalogue's different pages reading 320; revisit pages and an unvisited goal.
// Expectata: pages keeps 120; the unvisited goal uses the latest catalogue.
// Resultata to reject: pages' known last-added reading overwritten by 320.
test('an exact goal snapshot takes precedence over another goal’s newer catalogue', () => {
  save(sample(), 'pages')
  save(sample('alice', 320), 'pushups')
  assert.deepEqual(read('alice', 'pages'), sample())
  assert.deepEqual(read('alice', 'newgoal'), sample('alice', 320))
})

// Replicata: refuse the replacement write after saving a good snapshot.
// Expectata: an error and both old records intact.
// Resultata to reject: deleting or replacing the last good snapshot first.
test('a rejected first durable write keeps both previous snapshots', () => {
  save(sample(), 'pages')
  const before = new Map(durable.data)
  durable.beforeSet = () => { throw new Error('write refused') }
  assert.throws(() => save(sample('alice', 121), 'pages'), /write refused/)
  assert.deepEqual(durable.data, before)
})

// Replicata: accept the exact write but refuse the subsequent catalogue write.
// Expectata: loud failure, new exact snapshot and old catalogue, both readable.
// Resultata to reject: catalogue first or removal of either snapshot.
test('the exact snapshot is written before its catalogue', () => {
  save(sample(), 'pages')
  durable.beforeSet = key => {
    if (key === catalogue('alice')) throw new Error('catalogue refused')
  }
  assert.throws(() => save(sample('alice', 121), 'pages'), /catalogue refused/)
  assert.deepEqual(read('alice', 'pages'), sample('alice', 121))
  assert.deepEqual(read('alice', 'unvisited'), sample())
})

// Replicata: replace valid cached details with malformed fresh goal/user/dp data.
// Expectata: failure before any write. Resultata to reject: damaged good cache.
test('fresh metadata and selected datapoints validate before any write', () => {
  save(sample(), 'pages')
  const before = new Map(durable.data)
  for (const corrupt of [
    s => { s.goals[0].deadline = null },
    s => { s.user.timezone = null },
    s => { s.goals[0].last_datapoint.value = '120' },
    s => { s.goals[0].last_datapoint.daystamp = '2026-11-07' },
    s => { s.goals[0].last_datapoint.comment = null },
  ]) {
    const bad = sample(); corrupt(bad)
    assert.throws(() => save(bad, 'pages'))
    assert.deepEqual(durable.data, before)
  }
})

// Replicata: corrupt an exact snapshot while a usable catalogue remains.
// Expectata: a loud error. Resultata to reject: silent catalogue fallback.
test('a malformed exact snapshot never falls through to a good catalogue', () => {
  save(sample(), 'pages')
  for (const raw of ['{', JSON.stringify({}), JSON.stringify(sample('bob'))]) {
    durable.setItem(exact('alice', 'pages'), raw)
    assert.throws(() => read('alice', 'pages'))
  }
  const bad = sample(); bad.goals[0].last_datapoint.value = null
  durable.setItem(exact('alice', 'pages'), JSON.stringify(bad))
  assert.throws(() => read('alice', 'pages'))
})

// Replicata: corrupt the catalogue while matching legacy data remains.
// Expectata: failure. Resultata to reject: hiding corruption through migration.
test('a malformed or wrong-user catalogue does not fall through to legacy data', () => {
  session.setItem('tallybee-goals', JSON.stringify(sample()))
  for (const raw of ['{', JSON.stringify({}), JSON.stringify(sample('bob'))]) {
    durable.setItem(catalogue('alice'), raw)
    assert.throws(() => read('alice', 'unvisited'))
  }
})

// Replicata: save pages while the catalogue has a malformed pushups datapoint,
// then open pushups without an exact snapshot.
// Expectata: failure before display. Resultata to reject: using invalid cached dp.
test('catalogue fallback validates the requested goal’s datapoint', () => {
  const bad = sample()
  bad.goals[1].last_datapoint = { value: '10', daystamp: '20261107', comment: '' }
  save(bad, 'pages')
  assert.deepEqual(read('alice', 'pages'), bad)
  assert.throws(() => read('alice', 'pushups'))
})

// Replicata: the matching legacy snapshot has a malformed requested datapoint.
// Expectata: failure and no migration, leaving the original source intact.
// Resultata to reject: rendering invalid data or promoting it to durable cache.
test('legacy migration validates the requested goal’s datapoint before saving', () => {
  const bad = sample()
  bad.goals[1].last_datapoint = { value: '10', daystamp: '20261107', comment: '' }
  const raw = JSON.stringify(bad)
  session.setItem('tallybee-goals', raw)
  assert.throws(() => read('alice', 'pushups'))
  assert.equal(durable.data.size, 0)
  assert.equal(session.getItem('tallybee-goals'), raw)
})

// Replicata: open with only the old same-user session snapshot.
// Expectata: a durable catalogue, unchanged source, and no guessed exact goal.
// Resultata to reject: discarded session data or invented per-goal authority.
test('matching legacy session data migrates only to the catalogue', () => {
  const raw = JSON.stringify(sample())
  session.setItem('tallybee-goals', raw)
  assert.deepEqual(read('alice', 'pages'), sample())
  assert.equal(session.getItem('tallybee-goals'), raw)
  assert.deepEqual([...durable.data.keys()], [catalogue('alice')])
  session.data.clear()
  assert.deepEqual(read('alice', 'pushups'), sample())
})

// Replicata: only another user's old session snapshot exists.
// Expectata: null and no durable writes. Resultata to reject: cross-user import.
test('another user’s legacy snapshot is ignored and preserved', () => {
  const raw = JSON.stringify(sample('bob'))
  session.setItem('tallybee-goals', raw)
  assert.equal(read('alice', 'pages'), null)
  assert.equal(durable.data.size, 0)
  assert.equal(session.getItem('tallybee-goals'), raw)
})

// Replicata: matching legacy data has invalid metadata, or its write is refused.
// Expectata: an error with the original intact and no durable cache.
// Resultata to reject: silent repair, discarded source, or apparent migration.
test('invalid or unwritable legacy migration fails without destroying its source', () => {
  const bad = sample(); bad.user.timezone = null
  const invalid = JSON.stringify(bad)
  session.setItem('tallybee-goals', invalid)
  assert.throws(() => read('alice', 'pages'))
  assert.equal(durable.data.size, 0)
  assert.equal(session.getItem('tallybee-goals'), invalid)
  const good = JSON.stringify(sample())
  session.setItem('tallybee-goals', good)
  durable.beforeSet = () => { throw new Error('write refused') }
  assert.throws(() => read('alice', 'pages'), /write refused/)
  assert.equal(durable.data.size, 0)
  assert.equal(session.getItem('tallybee-goals'), good)
})

// Replicata: save an API goal with null curval and no last datapoint.
// Expectata: existing metadata checks accept it; selected null dp is valid.
// Resultata to reject: tightening unsupported server fields or repairing data.
test('the shared validators retain the existing API contract', () => {
  const s = sample(); s.goals[0].curval = null; s.goals[0].last_datapoint = null
  assert.deepEqual(check(s.goals, s.user), s)
  save(s, 'pages')
  assert.deepEqual(read('alice', 'pages'), s)
  assert.deepEqual(datapoint(sample().goals[0].last_datapoint),
    sample().goals[0].last_datapoint)
})
