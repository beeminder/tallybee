// Journal quals use isolated in-memory storage and locks; no browser or
// user data is involved. Run with node --test journal-quals.js.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { read, append } from './journal.js'
import { reduce as reduceTally } from './tally.js'

const KEY = 'tallybee-state pushups'
const EVENTS = 'tallybee-event '

class Storage {
  constructor() {
    for (const name of ['beforeSet', 'afterSet', 'beforeRemove', 'beforeGet'])
      Object.defineProperty(this, name, { value: () => {}, writable: true })
  }
  getItem(key) {
    this.beforeGet(key)
    return Object.hasOwn(this, key) ? this[key] : null
  }
  setItem(key, value) {
    this.beforeSet(key, value)
    Object.defineProperty(this, key, { value: String(value), enumerable: true,
      configurable: true, writable: true })
    this.afterSet(key, value)
  }
  removeItem(key) { this.beforeRemove(key); delete this[key] }
}

class Locks {
  jobs = []
  request(name, options, callback) {
    callback ??= options
    assert.equal(typeof callback, 'function')
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    promise.catch(() => {}) // The harness observes rejections through run().
    this.jobs.push({ callback, resolve, reject })
    return promise
  }
  async run() {
    const job = this.jobs.shift()
    try { const result = job.callback(); job.resolve(result); return result }
    catch (error) { job.reject(error); throw error }
  }
  async drain() { while (this.jobs.length) await this.run() }
}

let storage, locks
beforeEach(() => {
  storage = new Storage()
  locks = new Locks()
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true })
})
const initial = () => ({ count: 0, requestid: crypto.randomUUID() })
const reduce = (state, event) => {
  assert.ok(Number.isFinite(event.delta))
  state.count += event.delta
  assert.ok(Number.isFinite(state.count))
  return state
}
const get = () => read(KEY, initial, reduce)
const add = delta => append(KEY, { delta }, initial, reduce)
const events = () => Object.keys(storage).filter(k => k.startsWith(EVENTS))

// Replicata: append 7 without allowing a checkpoint, then read repeatedly.
// Expectata: 7 and the same requestid, including through a fresh initializer.
// Resultata to reject: an unsaved tap, or a newly generated requestid per read.
test('an append survives before checkpoint, with a durable initial requestid', () => {
  const first = add(7)
  assert.equal(storage.getItem(KEY), null)
  assert.equal(events().length, 1)
  assert.equal(first.count, 7)
  assert.deepEqual(get(), first)
  assert.deepEqual(read(KEY, () => ({ count: 100, requestid: 'wrong' }), reduce), first)
})

// Replicata: append 7; refuse the next event write; append another tap.
// Expectata: an error, and exactly the prior durable 7.
// Resultata to reject: the previous event removed or the rejected tap shown.
test('a failed append leaves the prior tally intact', () => {
  const prior = add(7)
  const keys = events()
  storage.beforeSet = key => { if (key.startsWith(EVENTS)) throw new Error('write refused') }
  assert.throws(() => add(1), /write refused/)
  assert.deepEqual(get(), prior)
  assert.deepEqual(events(), keys)
})

// Replicata: append 7; refuse writing its checkpoint.
// Expectata: the error surfaces and the original event remains readable.
// Resultata to reject: deleting the event before its checkpoint is durable.
test('a failed checkpoint leaves every pending event intact', async () => {
  const prior = add(7)
  const keys = events()
  storage.beforeSet = key => { if (key === KEY) throw new Error('checkpoint refused') }
  await assert.rejects(locks.run(), /checkpoint refused/)
  assert.equal(storage.getItem(KEY), null)
  assert.deepEqual(events(), keys)
  assert.deepEqual(get(), prior)
})

// Replicata: append 3 and 4; checkpoint both; fail during pending cleanup.
// Expectata: 7, never 11, even after a later checkpoint finishes cleanup.
// Resultata to reject: applying an already-checkpointed pending event again.
test('partial cleanup cannot replay a checkpointed event twice', async () => {
  add(3)
  const prior = add(4)
  let removes = 0
  storage.beforeRemove = () => { if (++removes === 2) throw new Error('cleanup interrupted') }
  await assert.rejects(locks.run(), /cleanup interrupted/)
  assert.equal(events().length, 1)
  assert.deepEqual(get(), prior)
  storage.beforeRemove = () => {}
  await locks.drain()
  assert.equal(events().length, 0)
  assert.deepEqual(get(), prior)
})

// Replicata: append 3; append 4 just after its checkpoint is written, before
// that checkpoint deletes its captured pending records.
// Expectata: 7; the newly appended event survives the first cleanup.
// Resultata to reject: cleanup deleting events it never included.
test('an event arriving during checkpoint survives its cleanup', async () => {
  add(3)
  storage.afterSet = key => {
    if (key === KEY) {
      storage.afterSet = () => {}
      add(4)
    }
  }
  await locks.run()
  assert.equal(events().length, 1)
  assert.equal(get().count, 7)
  await locks.drain()
  assert.equal(events().length, 0)
  assert.equal(get().count, 7)
})

// Replicata: a checkpoint writes its base while a read is scanning events.
// Expectata: a consistent 7, with the changed base read again.
// Resultata to reject: missing the event or counting it twice.
test('a read retries when its base changes during the pending scan', async () => {
  add(7)
  let checkpoint
  storage.beforeGet = key => {
    if (key.startsWith(EVENTS)) {
      storage.beforeGet = () => {}
      checkpoint = locks.run()
    }
  }
  assert.equal(get().count, 7)
  await checkpoint
})

// Replicata: append an event rejected by the domain reducer.
// Expectata: an error before any durable record changes.
// Resultata to reject: an invalid event making future reads fail.
test('a rejected event is never appended', () => {
  const prior = add(7)
  const keys = events()
  assert.throws(() => append(KEY, { delta: null }, initial, reduce))
  assert.deepEqual(events(), keys)
  assert.deepEqual(get(), prior)
})

// Replicata: corrupt checkpoint metadata, or an event's sequence.
// Expectata: a loud failure, never treating corrupt data as an empty tally.
// Resultata to reject: silently starting afresh or repairing input.
test('invalid checkpoint and event schemas fail loudly', () => {
  storage.setItem(KEY, JSON.stringify({ state: initial(), applied: [1], seq: 0 }))
  assert.throws(get)
  storage.removeItem(KEY)
  storage.setItem(EVENTS + 'broken', JSON.stringify({ key: KEY, id: 'broken',
    seq: null, event: { delta: 1 }, seed: initial() }))
  assert.throws(get)
})

// Replicata: add 3 and 4, then permit all checkpoints.
// Expectata: one durable checkpoint and no pending records, with count 7.
// Resultata to reject: retaining an ever-growing healthy event history.
test('healthy checkpointing removes the captured pending records', async () => {
  add(3)
  add(4)
  await locks.drain()
  assert.equal(events().length, 0)
  const base = JSON.parse(storage.getItem(KEY))
  assert.equal(base.state.count, 7)
  assert.equal(base.seq, 2)
  assert.equal(base.applied.length, 2)
  assert.equal(get().count, 7)
})

// Replicata: use each event's identity in the domain state, then checkpoint.
// Expectata: the same nonempty ID during append validation and every replay.
// Resultata to reject: an absent or newly generated ID during replay.
test('the reducer receives the stable event ID during validation and replay', async () => {
  const seen = []
  const reducer = (state, event, id) => {
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0)
    seen.push(id)
    return { ...state, requestid: id, count: state.count + event.delta }
  }
  const state = append(KEY, { delta: 3 }, initial, reducer)
  const id = JSON.parse(storage.getItem(events()[0])).id
  assert.equal(state.requestid, id)
  await locks.drain()
  assert.equal(read(KEY, initial, reducer).requestid, id)
  assert.deepEqual([...new Set(seen)], [id])
})

// Replicata: two windows read an empty store; the second writes and
// checkpoints before the first finishes writing its equal-sequence event.
// Expectata: both deltas, once each, and the checkpoint's established seed.
// Resultata to reject: discarding the late delta or changing the requestid.
test('a late equal-sequence event survives a concurrent initial checkpoint', async () => {
  let checkpoint, established
  storage.beforeSet = key => {
    if (key.startsWith(EVENTS)) {
      storage.beforeSet = () => {}
      established = add(4)
      checkpoint = locks.run()
    }
  }
  const result = add(3)
  await checkpoint
  assert.equal(result.count, 7)
  assert.equal(result.requestid, established.requestid)
  assert.equal(events().length, 1)
  await locks.drain()
  assert.equal(get().count, 7)
  assert.equal(get().requestid, established.requestid)
  assert.equal(events().length, 0)
})

// Replicata: two initial appends reach storage before either checkpoints.
// Expectata: one deterministic seed and both changes on every subsequent read.
// Resultata to reject: differing requestids depending on the reader's initial.
test('concurrent initial events converge on one durable seed', async () => {
  storage.beforeSet = key => {
    if (key.startsWith(EVENTS)) {
      storage.beforeSet = () => {}
      add(4)
    }
  }
  const result = add(3)
  assert.equal(result.count, 7)
  const first = events().map(k => JSON.parse(storage.getItem(k)))
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))[0]
  assert.equal(result.requestid, first.seed.requestid)
  assert.deepEqual(get(), result)
  await locks.drain()
  assert.deepEqual(get(), result)
})

// Replicata: begin from a sizeable existing state with room for that state
// and several small changes, then append twice before checkpointing.
// Expectata: both changes fit without duplicating the entire initial state.
// Resultata to reject: the second tiny change exhausting the available space.
test('small pending changes do not duplicate a sizeable initial state', () => {
  const initialLarge = () => ({ ...initial(), memo: 'x'.repeat(1000) })
  storage.beforeSet = (key, value) => {
    const size = Object.keys(storage).filter(k => k !== key)
      .reduce((n, k) => n + k.length + storage.getItem(k).length, 0)
      + key.length + value.length
    if (size > 1800) throw new Error('quota exceeded')
  }
  append(KEY, { delta: 3 }, initialLarge, reduce)
  append(KEY, { delta: 4 }, initialLarge, reduce)
  assert.equal(read(KEY, initialLarge, reduce).count, 7)
})

// Replicata: accidentally provide an asynchronous reducer.
// Expectata: fail before persisting an event that cannot replay synchronously.
// Resultata to reject: a Promise mistaken for valid state and saved as {}.
test('an asynchronous reducer fails before its event is saved', () => {
  assert.throws(() => append(KEY, { delta: 1 }, initial,
    async (state, event) => reduce(state, event)))
  assert.equal(events().length, 0)
  assert.equal(storage.getItem(KEY), null)
})

// Replicata: make 1234 changes in one task, as the narrow-screen browser qual
// does, without permitting a checkpoint, and read after each displayed change.
// Expectata: every tap retained and the task finishes within ten seconds.
// Resultata to reject: replaying every earlier UNDO history on every tap,
// making this ordinary count take minutes before controls respond again.
test('1234 uncheckpointed taps remain durable without blocking for ten seconds', async () => {
  const first = () => ({ count: 0, requestid: 'first', pin: null, comment: '',
    day: null, undos: [], at: 'pushups', slug: 'pushups', folded: false })
  const started = performance.now()
  for (let i = 0; i < 1234; i++) {
    append(KEY, { type: 'add', amount: 1 }, first, reduceTally)
    assert.equal(read(KEY, first, reduceTally).count, i + 1)
    assert.ok(performance.now() - started < 10000,
      `${i + 1} of 1234 taps took ${Math.round(performance.now() - started)}ms`)
  }
  assert.equal(events().length, 1234)
  await locks.drain()
  assert.equal(read(KEY, first, reduceTally).count, 1234)
})

// Replicata: read one pending event, then receive a concurrent event with
// the same sequence and an earlier ID.
// Expectata: replay both in their defined order, rather than appending the
// newly arrived event to a previously replayed result.
// Resultata to reject: a replay cache treating a late insertion as a suffix.
test('a late earlier event invalidates the previously replayed prefix', () => {
  const first = () => ({ order: '' })
  const reducer = (state, event) => ({ order: state.order + event.letter })
  const put = (id, letter) => storage.setItem(EVENTS + id, JSON.stringify({
    key: KEY, id, seq: 1, event: { letter }, seed: first() }))
  put('z', 'Z')
  assert.equal(read(KEY, first, reducer).order, 'Z')
  put('a', 'A')
  assert.equal(read(KEY, first, reducer).order, 'AZ')
})

// Replicata: read a pending tally, checkpoint it, append again, and mutate
// one returned read object as a caller might while preparing an edit.
// Expectata: the durable count, unaffected by that caller's private mutation.
// Resultata to reject: a changed checkpoint or caller-mutated replay cache.
test('checkpoint changes and caller edits cannot corrupt cached reads', async () => {
  add(3)
  const first = get()
  first.count = 999
  assert.equal(get().count, 3)
  await locks.drain()
  assert.equal(get().count, 3)
  const second = add(4)
  second.count = -999
  assert.equal(get().count, 7)
})

// Replicata: replay an import whose reducer returns event.state directly,
// followed by a mutation; then receive an earlier event requiring a replay.
// Expectata: replay the original imported 3, then add 4: still 7.
// Resultata to reject: mutating a cached event payload into 7 and replaying 11.
test('a reducer cannot mutate cached event payloads through imported state', () => {
  const first = () => ({ count: 0 })
  const reducer = (state, event) => {
    if (event.type === 'import') return event.state
    state.count += event.delta
    return state
  }
  const put = (id, seq, event) => storage.setItem(EVENTS + id, JSON.stringify({
    key: KEY, id, seq, event, seed: first() }))
  put('b', 2, { type: 'import', state: { count: 3 } })
  put('c', 3, { type: 'add', delta: 4 })
  assert.equal(read(KEY, first, reducer).count, 7)
  put('a', 1, { type: 'add', delta: 1 })
  assert.equal(read(KEY, first, reducer).count, 7)
})
