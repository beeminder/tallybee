// Pure quals for the tally reducer. Each case gives its replicata in the
// operations, its expectata in the assertions, and its resultata on failure.
import { test as qual } from 'node:test'
import assert from 'node:assert/strict'
import { add, reduce, upgrade } from './tally.js'

const fresh = (more = {}) => ({ count: 0, requestid: 'r1', pin: null,
  comment: '', day: null, undos: [], at: 'pushups', slug: 'pushups',
  folded: false, ...more })
const run = (t, type, values, id) => reduce(t, { type, ...values }, id)

qual('decimal addition leaves no binary stray digits', () => {
  assert.equal(add(0.1, 0.2), 0.3)
  assert.equal(add(1, 0.14), 1.14)
})
qual('addition rejects non-finite numbers and overflow', () => {
  for (const [a, b] of [[NaN, 1], [1, Infinity], ['1', 2], [1e308, 1e308]])
    assert.throws(() => add(a, b))
})
qual('init leaves the tally unchanged', () => {
  const t = fresh({ count: 3 })
  assert.equal(run(t, 'init', {}, 'a'), t)
  assert.deepEqual(t, fresh({ count: 3 }))
})
qual('each additive change records its own inverse and identity', () => {
  const t = fresh()
  run(t, 'add', { amount: 3 }, 'a')
  run(t, 'add', { amount: -1 }, 'b')
  assert.equal(t.count, 2)
  assert.deepEqual(t.undos.map(u => [u._id, u._delta]), [['a', 3], ['b', -1]])
  run(t, 'undo', { target: 'b' }, 'c')
  assert.equal(t.count, 3)
})
qual('duplicate Undo is harmless', () => {
  const t = fresh()
  run(t, 'add', { amount: 1 }, 'a')
  run(t, 'undo', { target: 'a' }, 'b')
  const once = structuredClone(t)
  run(t, 'undo', { target: 'a' }, 'c')
  assert.deepEqual(t, once)
})
qual('Undo of an earlier tap keeps a concurrent later tap', () => {
  const t = fresh()
  run(t, 'add', { amount: 1 }, 'a')
  run(t, 'add', { amount: 1 }, 'b')
  run(t, 'undo', { target: 'a' }, 'c')
  assert.equal(t.count, 1)
  assert.deepEqual(t.undos.map(u => u._id), ['b'])
})
qual('a whole number edit groups its deltas around intervening taps', () => {
  const t = fresh({ count: 3 })
  run(t, 'edit', { values: { count: 10 }, edit: 'e' }, 'a')
  run(t, 'add', { amount: 1 }, 'b')
  run(t, 'edit', { values: { count: 20 }, edit: 'e' }, 'c')
  assert.equal(t.undos.length, 2)
  assert.equal(t.undos[0]._id, 'a')
  assert.equal(t.undos[0]._edit, 'r1 e')
  assert.equal(t.undos[0]._delta, 16)
  run(t, 'undo', { target: 'a' }, 'd')
  assert.equal(t.count, 4)
})
qual('Undo of a comment edit restores the whole comment and preserves taps', () => {
  const t = fresh({ comment: 'old' })
  run(t, 'edit', { values: { comment: 'n' }, edit: 'e' }, 'a')
  run(t, 'edit', { values: { comment: 'new' }, edit: 'e' }, 'b')
  run(t, 'add', { amount: 2 }, 'c')
  run(t, 'undo', { target: 'a' }, 'd')
  assert.equal(t.comment, 'old')
  assert.equal(t.count, 2)
})
qual('a new pending datapoint gives the same edit token a new undo identity', () => {
  const t = fresh()
  run(t, 'edit', { values: { comment: 'first' }, edit: 'e' }, 'a')
  run(t, 'accepted', { requestid: 'r1', n: 0 }, 'r2')
  run(t, 'edit', { values: { comment: 'second' }, edit: 'e' }, 'b')
  assert.equal(t.undos[0]._id, 'b')
  assert.equal(t.undos[0]._edit, 'r2 e')
  run(t, 'undo', { target: 'a' }, 'c')
  assert.equal(t.comment, 'second')
})
qual('a day change is undoable without changing the count', () => {
  const t = fresh({ count: 4 })
  run(t, 'change', { values: { day: '20261106' } }, 'a')
  run(t, 'undo', { target: 'a' }, 'b')
  assert.equal(t.day, null)
  assert.equal(t.count, 4)
})
qual('Clear starts a new datapoint and Undo restores the old one', () => {
  const t = fresh({ count: 3, comment: 'set', day: '20261106',
    pin: { slug: 'pushups', base: 120 } })
  const old = structuredClone(t)
  run(t, 'clear', {}, 'r2')
  assert.deepEqual([t.count, t.requestid, t.pin, t.comment, t.day],
                   [0, 'r2', null, '', null])
  run(t, 'undo', { target: 'r2' }, 'u')
  assert.deepEqual(t, old)
})
qual('Undo of Clear keeps a later concurrent tap', () => {
  const t = fresh({ count: 3 })
  run(t, 'clear', {}, 'r2')
  run(t, 'add', { amount: 1 }, 'a')
  run(t, 'undo', { target: 'r2' }, 'u')
  assert.equal(t.count, 4)
  assert.equal(t.requestid, 'r1')
})
qual('pin and unpin affect only the expected pending datapoint', () => {
  const t = fresh()
  const pin = { slug: 'pages', base: 120 }
  run(t, 'pin', { requestid: 'r1', pin }, 'a')
  assert.deepEqual(t.pin, pin)
  run(t, 'unpin', { requestid: 'old', pin: null }, 'b')
  assert.deepEqual(t.pin, pin)
  run(t, 'unpin', { requestid: 'r1', pin: null }, 'c')
  assert.equal(t.pin, null)
  run(t, 'pin', { requestid: 'old', pin }, 'd')
  assert.equal(t.pin, null)
  assert.deepEqual(t.undos, [])
})
qual('Undo of a tap retains a subsequently pinned odometer base', () => {
  const t = fresh()
  run(t, 'add', { amount: 3 }, 'a')
  run(t, 'pin', { requestid: 'r1', pin: { slug: 'pages', base: 120 } }, 'b')
  run(t, 'undo', { target: 'a' }, 'c')
  assert.equal(t.count, 0)
  assert.deepEqual(t.pin, { slug: 'pages', base: 120 })
})
qual('an accepted submission leaves taps added while it was sending', () => {
  const t = fresh({ count: 3, comment: 'set', day: '20261106' })
  run(t, 'add', { amount: 2 }, 'a')
  run(t, 'accepted', { requestid: 'r1', n: 3 }, 'r2')
  assert.deepEqual(t, fresh({ count: 2, requestid: 'r2' }))
})
qual('an accepted negative submission leaves zero', () => {
  const t = fresh({ count: -3 })
  run(t, 'accepted', { requestid: 'r1', n: -3 }, 'r2')
  assert.equal(t.count, 0)
})
qual('an old accepted reply preserves a replacement tally and ends undo history', () => {
  const t = fresh({ count: 3 })
  run(t, 'clear', {}, 'r2')
  run(t, 'add', { amount: 2 }, 'a')
  run(t, 'edit', { values: { comment: 'new' }, edit: 'e' }, 'b')
  run(t, 'accepted', { requestid: 'r1', n: 3 }, 'r3')
  assert.deepEqual(t, fresh({ count: 2, requestid: 'r2', comment: 'new' }))
})
qual('an accepted submission prevents Undo of any earlier action', () => {
  const t = fresh()
  run(t, 'add', { amount: 3 }, 'a')
  run(t, 'accepted', { requestid: 'r1', n: 3 }, 'r2')
  run(t, 'undo', { target: 'a' }, 'u')
  assert.deepEqual(t, fresh({ requestid: 'r2' }))
})
qual('legacy undo snapshots gain deterministic deltas and identities', () => {
  const t = fresh({ count: 5, comment: 'x', undos: [
    { count: 0 }, { comment: '' }, { count: 2 },
  ] })
  const other = structuredClone(t)
  upgrade(t)
  upgrade(other)
  assert.deepEqual(t, other)
  assert.deepEqual(t.undos.map(u => u._delta), [2, 0, 3])
  assert.equal(new Set(t.undos.map(u => u._id)).size, 3)
  run(t, 'undo', { target: t.undos.at(-1)._id }, 'u')
  assert.equal(t.count, 2)
})
qual('existing undo metadata is preserved while older frames are upgraded', () => {
  const kept = { count: 999, _id: 'kept', _delta: 2 }
  const t = fresh({ count: 5, undos: [{ count: 1 }, kept] })
  upgrade(t)
  assert.deepEqual(t.undos[1], { count: 999, _id: 'kept', _delta: 2 })
  assert.equal(t.undos[0]._delta, 2)
  const once = structuredClone(t)
  upgrade(t)
  assert.deepEqual(t, once)
})
qual('broken or duplicate undo metadata fails loudly', () => {
  for (const undos of [[{ count: 0, _id: 'x' }],
    [{ count: 0, _delta: 1 }], [{ count: 0, _id: 'x', _delta: '1' }],
    [{ _id: 'x', _delta: 0 }, { _id: 'x', _delta: 0 }]])
    assert.throws(() => upgrade(fresh({ undos })))
})
qual('import adopts a preserved legacy tally only into an untouched destination', () => {
  const source = fresh({ count: 7, comment: 'old', requestid: 'old' })
  assert.equal(run(fresh(), 'import', { state: source }, 'i'), source)
  for (const changed of [{ count: 1 }, { comment: 'x' }, { day: '20261106' },
    { pin: { slug: 'pages', base: 120 } },
    { undos: [{ count: 1, _id: 'a', _delta: -1 }] }])
    assert.throws(() => run(fresh(changed), 'import', { state: source }, 'i'))
})
qual('malformed commands fail before changing the tally', () => {
  const events = [null, {}, { type: 'unknown' }, { type: 'add', amount: '1' },
    { type: 'add', amount: Infinity }, { type: 'edit', edit: 1, values: { count: 2 } },
    { type: 'change', values: { count: NaN } },
    { type: 'change', values: { alien: 1 } }, { type: 'undo', target: 2 },
    { type: 'pin', requestid: 'r1', pin: { slug: 'pages', base: '120' } },
    { type: 'accepted', requestid: 'r1', n: Infinity },
    { type: 'import', state: { count: 7 } }]
  for (const event of events) {
    const t = fresh()
    assert.throws(() => reduce(t, event, 'a'), JSON.stringify(event))
    assert.deepEqual(t, fresh(), JSON.stringify(event))
  }
})

// Replicata: a sibling undoes an edit; typing continues in the original
// field, then a delayed duplicate Undo targets the first edit's frame.
// Expectata: the new text remains, with a distinct undo identity.
// Resultata (before): the reused grouping token made the stale Undo erase it.
qual('a delayed duplicate Undo cannot erase typing after another window undid the edit', () => {
  const t = fresh()
  run(t, 'edit', { values: { comment: 'first' }, edit: 'e' }, 'a')
  const target = t.undos[0]._id
  run(t, 'undo', { target }, 'u1')
  run(t, 'edit', { values: { comment: 'second' }, edit: 'e' }, 'b')
  run(t, 'undo', { target }, 'u2')
  assert.equal(t.comment, 'second')
  assert.equal(t.undos.length, 1)
  assert.notEqual(t.undos[0]._id, target)
})
qual('edit grouping metadata is preserved and malformed metadata fails loudly', () => {
  const t = fresh({ undos: [{ comment: '', _id: 'a', _delta: 0, _edit: 'r1 e' }] })
  const before = structuredClone(t)
  upgrade(t)
  assert.deepEqual(t, before)
  for (const u of [{ _id: 'a', _delta: 0, _edit: 3 }, { _edit: 'r1 e' }])
    assert.throws(() => upgrade(fresh({ undos: [u] })))
})
