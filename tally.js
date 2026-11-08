// The tally's deterministic reducer: durable events contain every generated
// identity, so replay never asks for a new UUID or reads the clock.
const check = (ok, details) => {
  if (!ok) throw new Error(JSON.stringify(details))
}
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const string = x => typeof x === 'string'
const maybeString = x => x === null || string(x)
const pin = x => x === null || record(x) && string(x.slug) && Number.isFinite(x.base)
const fields = {
  count: Number.isFinite,
  requestid: string,
  pin,
  comment: string,
  day: x => x === null || typeof x === 'string' && /^\d{8}$/.test(x),
  at: maybeString,
  slug: maybeString,
  folded: x => typeof x === 'boolean',
}
const values = x => record(x) && Object.keys(x).length > 0 &&
  Object.entries(x).every(([key, value]) => Object.hasOwn(fields, key) && fields[key](value))
const frame = u => record(u) && Object.entries(u).every(([key, value]) =>
  key === '_id' || key === '_edit' ? string(value) : key === '_delta' ? Number.isFinite(value) :
  Object.hasOwn(fields, key) && fields[key](value)) &&
  Object.hasOwn(u, '_id') === Object.hasOwn(u, '_delta') &&
  (!Object.hasOwn(u, '_edit') || Object.hasOwn(u, '_id'))
const state = t => record(t) &&
  ['count', 'requestid', 'pin', 'comment', 'day'].every(key => fields[key](t[key])) &&
  Array.isArray(t.undos) && t.undos.every(frame)

// Match the app's fifteen-significant-digit arithmetic, including subtraction.
export function add(a, b) {
  const n = Number((a + b).toPrecision(15))
  check(Number.isFinite(n), { a, b })
  return n
}

// Older UNDO frames kept only prior field values. Walking backwards recovers
// their count deltas. Existing metadata is validated and left as it was.
export function upgrade(t) {
  check(state(t), t)
  let count = t.count
  const ids = new Set()
  for (let i = t.undos.length - 1; i >= 0; i--) {
    const u = t.undos[i]
    if (!Object.hasOwn(u, '_id')) {
      u._id = `legacy ${t.requestid} ${i}`
      u._delta = add(count, -(u.count ?? count))
    }
    check(!ids.has(u._id), u)
    ids.add(u._id)
    count = add(count, -u._delta)
  }
  return t
}

// _id identifies the first event of one undoable action. _edit groups
// keystrokes, without reusing an identity after another window undoes it.
// _delta records that action's contribution to the count, so undoing it
// preserves taps from another window that arrived afterwards.
function remember(t, id, patch, edit) {
  let u = t.undos.find(u => edit === undefined ? u._id === id : u._edit === edit)
  const delta = add(u?._delta ?? 0, add(patch.count ?? t.count, -t.count))
  if (!u) {
    u = Object.fromEntries(Object.keys(patch).map(key => [key, t[key]]))
    u._id = id
    if (edit !== undefined) u._edit = edit
    t.undos.push(u)
  }
  u._delta = delta
  Object.assign(t, patch)
}

const fresh = requestid => ({ requestid, pin: null, comment: '', day: null })
const schema = {
  init: [], add: ['amount'], edit: ['values', 'edit'], change: ['values'],
  clear: [], undo: ['target'], pin: ['requestid', 'pin'],
  unpin: ['requestid', 'pin'], accepted: ['requestid', 'n'], import: ['state'],
}
const valid = {
  init: () => true,
  add: e => Number.isFinite(e.amount),
  edit: e => string(e.edit) && values(e.values),
  change: e => values(e.values),
  clear: () => true,
  undo: e => string(e.target),
  pin: e => string(e.requestid) && pin(e.pin),
  unpin: e => string(e.requestid) && pin(e.pin),
  accepted: e => string(e.requestid) && Number.isFinite(e.n),
  import: e => state(e.state),
}

export function reduce(t, event, id) {
  check(state(t), t)
  check(record(event) && string(id) && string(event.type) &&
    Object.hasOwn(schema, event.type) &&
    Object.keys(event).length === schema[event.type].length + 1 &&
    schema[event.type].every(key => Object.hasOwn(event, key)) &&
    valid[event.type](event), { event, id })
  switch (event.type) {
    case 'init': break
    case 'add': remember(t, id, { count: add(t.count, event.amount) }); break
    case 'edit': remember(t, id, event.values, `${t.requestid} ${event.edit}`); break
    case 'change': remember(t, id, event.values); break
    case 'clear': remember(t, id, { count: 0, ...fresh(id) }); break
    case 'undo': {
      const i = t.undos.findIndex(u => u._id === event.target)
      if (i >= 0) {
        const { _id, _delta, _edit, count, ...prior } = t.undos[i]
        const n = add(t.count, -_delta)
        t.undos.splice(i, 1)
        Object.assign(t, prior, { count: n })
      }
      break
    }
    case 'pin':
    case 'unpin':
      if (t.requestid === event.requestid) t.pin = event.pin
      break
    case 'accepted':
      if (t.requestid === event.requestid)
        Object.assign(t, { count: add(t.count, -event.n), ...fresh(id) })
      t.undos = []
      break
    case 'import':
      check(t.count === 0 && t.comment === '' && t.day === null &&
            t.pin === null && t.undos.length === 0, t)
      return event.state
  }
  return t
}
