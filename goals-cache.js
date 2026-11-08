import { assert } from './beeminder.js'

// Throw unless gs is a list of goals, and u a user, as TallyBee needs them from
// Beeminder (see NOGOAL and NOUSER); else return them, as { goals, user }
export function check(gs, u) {
  gs.forEach(({ slug, kyoom, safesum, queued, deadline }) => assert(
    typeof slug === 'string' && typeof kyoom === 'boolean' &&
    typeof safesum === 'string' && typeof queued === 'boolean' &&
    Number.isFinite(deadline),
    JSON.stringify({ slug, kyoom, safesum, queued, deadline })))
  assert(typeof u.username === 'string' && typeof u.timezone === 'string',
                   JSON.stringify({ username: u.username, timezone: u.timezone }))
  return { goals: gs, user: u }
}

// Throw unless d is a datapoint as TallyBee needs one from Beeminder: with a
// value, a daystamp, and a comment; else return d
export function datapoint(d) {
  assert(Number.isFinite(d.value) && /^\d{8}$/.test(d.daystamp) &&
                   typeof d.comment === 'string', JSON.stringify(d))
  return d
}

// Each selected goal keeps a complete snapshot. The catalogue is the latest
// complete snapshot for its user, used only when that goal has no snapshot.
// Separate keys prevent another goal's refresh from replacing a known
// last-added datapoint with the catalogue's differently ordered datapoint.
const key = parts => 'tallybee-goals ' + JSON.stringify(parts)

function checked(snapshot, username, slug) {
  const saved = check(snapshot.goals, snapshot.user)
  assert(saved.user.username === username,
         JSON.stringify({ username, user: saved.user.username }))
  const selected = saved.goals.find(g => g.slug === slug)
  if (selected && selected.last_datapoint !== null) datapoint(selected.last_datapoint)
  return saved
}

// A present but invalid snapshot throws; it never falls through to another
// source. The old session snapshot did not say which goal's last-added
// datapoint it had fetched, so migration gives it catalogue authority only.
export function read(username, slug) {
  for (const parts of [[username, slug], [username]]) {
    const raw = localStorage.getItem(key(parts))
    if (raw !== null) return checked(JSON.parse(raw), username, slug)
  }
  const old = JSON.parse(sessionStorage.getItem('tallybee-goals'))
  if (old === null || old.user.username !== username) return null
  const saved = checked(old, username, slug)
  localStorage.setItem(key([username]), JSON.stringify(saved))
  return saved
}

// Validate everything being promoted to selected-goal authority before any
// write. setItem replaces each value directly, leaving the previous value
// intact if storage rejects that write. The session source stays untouched.
export function save(snapshot, slug) {
  const saved = checked(snapshot, snapshot.user.username, slug)
  const raw = JSON.stringify(saved)
  localStorage.setItem(key([saved.user.username, slug]), raw)
  localStorage.setItem(key([saved.user.username]), raw)
}
