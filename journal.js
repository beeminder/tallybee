// A journal keeps each change in its own durable record before acknowledging
// it. A checkpoint folds those records into the state at key, then removes
// only the records it captured. Reads and appends never wait for checkpoints.
// States and events are JSON data; initial and reduce must be deterministic
// once a seed is supplied. reduce(state, event, id) validates each event and
// resulting state; id is the same event identity on every replay.
const PREFIX = 'tallybee-event '
const LOCK = 'tallybee journal'
// A read still checks durable storage. This cache only avoids replaying an
// unchanged prefix; neither a base change nor an earlier arriving event can
// reuse that prefix. Cached state is never returned to callers directly.
const replayed = new Map()
// Construct diagnostics only on failure: the state can contain a long UNDO
// history, and serializing it for every successful check stalls rapid input.
function check(ok, details) {
  if (!ok) throw new Error(JSON.stringify(details))
}

const object = x => x !== null && typeof x === 'object' &&
  [null, Object.prototype].includes(Object.getPrototypeOf(x))
const sequence = x => Number.isSafeInteger(x) && x >= 0

function basecheck(base) {
  check(object(base) && object(base.state) && sequence(base.seq) &&
    Array.isArray(base.applied) && base.applied.every(id => typeof id === 'string') &&
    new Set(base.applied).size === base.applied.length, base)
  return base
}

function eventcheck(record, name) {
  check(object(record) && typeof record.key === 'string' &&
    typeof record.id === 'string' && name === PREFIX + record.id &&
    sequence(record.seq) && record.seq > 0 && Object.hasOwn(record, 'event') &&
    (!Object.hasOwn(record, 'seed') || object(record.seed)), record)
  return record
}

// Capture names first: checkpoint cleanup can otherwise shift an indexed
// localStorage scan and make it skip an unrelated, newly appended record.
function pending(key, known) {
  const records = []
  for (const name of Object.keys(localStorage).filter(n => n.startsWith(PREFIX))) {
    const raw = localStorage.getItem(name)
    if (raw === null) continue // a checkpoint removed this captured name
    const prior = known?.get(name)
    const record = prior?.raw === raw ? prior :
      { ...eventcheck(JSON.parse(raw), name), raw }
    if (record.key === key) records.push(record)
  }
  return records.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
}

// A checkpoint may run in another window during the scan. Re-read its base
// until the base and the captured pending records describe the same moment.
function snapshot(key, initial, reduce) {
  for (;;) {
    const raw = localStorage.getItem(key)
    const previous = replayed.get(key)
    const records = pending(key, previous?.storage === localStorage ? previous.known : undefined)
    if (raw !== localStorage.getItem(key)) continue
    const reuse = previous && previous.storage === localStorage &&
      previous.reduce === reduce && previous.raw === raw &&
      (raw !== null || previous.records.length > 0) &&
      previous.records.length <= records.length &&
      previous.records.every((r, i) => r.raw === records[i].raw)
    const base = reuse ? previous.base : raw === null
      ? { state: records.length ? records[0].seed : initial(), applied: [], seq: 0 }
      : JSON.parse(raw)
    basecheck(base)
    const applied = new Set(base.applied)
    const start = reuse ? previous.records.length : 0
    let state = reuse && start === records.length ? previous.state :
      structuredClone(reuse ? previous.state : base.state)
    for (const record of records.slice(start))
      if (!applied.has(record.id))
        state = reduce(state, structuredClone(record.event), record.id)
    check(object(state), state)
    const saved = { state, records, raw, seed: base.state,
      seq: Math.max(base.seq, records.at(-1)?.seq ?? 0) }
    replayed.set(key, { ...saved, base, storage: localStorage, reduce,
      known: new Map(records.map(r => [PREFIX + r.id, r])) })
    return saved
  }
}

export function read(key, initial, reduce) {
  return structuredClone(snapshot(key, initial, reduce).state)
}

// The list of applied IDs makes a crash between the write and cleanup safe:
// records left behind are known to be in the checkpoint already. An append
// made during this work has a different ID and is never part of its cleanup.
function checkpoint(key, initial, reduce) {
  const saved = snapshot(key, initial, reduce)
  if (saved.records.length === 0) return
  localStorage.setItem(key, JSON.stringify({ state: saved.state,
    applied: saved.records.map(r => r.id), seq: saved.seq }))
  for (const record of saved.records) localStorage.removeItem(PREFIX + record.id)
}

export function append(key, event, initial, reduce) {
  const saved = snapshot(key, initial, reduce)
  const id = crypto.randomUUID()
  const record = { key, id, seq: saved.seq + 1, event }
  // Before any checkpoint exists, the seed lives in the event itself. A new
  // page can then reconstruct the same requestid without calling initial.
  if (saved.raw === null && saved.records.length === 0) record.seed = saved.seed
  const raw = JSON.stringify(record)
  const durable = eventcheck(JSON.parse(raw), PREFIX + id)
  check(object(reduce(structuredClone(saved.state), durable.event, id)), durable)
  localStorage.setItem(PREFIX + id, raw)
  // A frozen checkpoint can postpone housekeeping, but no save waits on it.
  // This promise deliberately has no catch: an actual checkpoint failure
  // reaches the page's unhandledrejection listener; pending records stay saved.
  navigator.locks.request(LOCK, () => checkpoint(key, initial, reduce))
  return read(key, initial, reduce)
}
