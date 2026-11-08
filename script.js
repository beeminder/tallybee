import * as beeminder from './beeminder.js';
import * as journal from './journal.js'
import { reduce, upgrade, add } from './tally.js'

// Convenience functions -------------------------------------------------------
function $(id) { return document.getElementById(id) } // to be jQuery-esque
// -----------------------------------------------------------------------------

// Beeminder's ID for TallyBee as an app that people log in to Beeminder from
// (a client, in OAuth's jargon), for each place it's served from (an origin,
// in the web's jargon): here, just the live TallyBee. A copy served elsewhere,
// for trying out changes, logs in as an app of its own, registered with
// Beeminder (at beeminder.com/apps/new) with the copy's origin, with no slash
// after it, as where Beeminder sends logins back to (the redirect URL), once
// whatever serves the copy adds that app's ID here as it serves this file. A
// copy that's not in here can't log in itself: its login button fails loudly.
const CLIENTS = {
  'https://tallybee.beeminder.com': '6qi9cv7g647fisgzlz0flxwee',
}
const clientId = CLIENTS[location.origin]
const redirectUri = location.origin + '/'
// A copy that's not in CLIENTS, like one served from this directory with
// `python3 -m http.server`, at http://localhost:8000, can still use the live
// TallyBee's login, as Beeminder lets any page call its API: in the browser's
// console on tallybee.beeminder.com, logged in, copy what
// localStorage.getItem('beeminder-token') says, and on the copy, paste it into
// localStorage.setItem('beeminder-token', ...) and reload. (Beeminder keeps one
// token per app, so it's the same login in both: the copy's Submit sends
// datapoints to your real goals.) A goal's page on the copy, like
// http://localhost:8000/alice/pushups/, which the copy goes to once the goals
// load, comes only from a server that answers a URL it has no file for with
// 404.html, as GitHub Pages does (see index.html), which Python's doesn't: on
// it, reloading a goal's page shows Python's own 404 page.

// Show any error, like Beeminder being unreachable or rejecting our token or an
// assert failing, in the status line. (One from a script from another site,
// like one a browser extension adds, comes with no error in it, just the
// event's message, "Script error.".)
window.addEventListener('error', e => fail(e.error ?? e))
window.addEventListener('unhandledrejection', e => fail(e.reason))

// One durable pending datapoint per goal, shared by every window. Each input
// is an immutable journal entry saved synchronously before render acknowledges
// it. The journal's checkpoint is housekeeping, never part of saving a tap.
// count, requestid, pin, comment, day and undos retain their previous meanings.
// The map lets assigning a logged-out tally to its first goal be one write.
const STATE = 'tallybee-state'
const pick = (t, keys) => Object.fromEntries(keys.map(k => [k, t[k]]))
const empty = t => t.count === 0 && t.comment === '' && t.day === null &&
                   t.pin === null && t.undos.length === 0
const blank = (s, id = crypto.randomUUID()) => ({ count: 0, requestid: id,
  pin: null, comment: '', day: null, undos: [], at: s, slug: s, folded: false })

function preferences() {
  const old = JSON.parse(localStorage.getItem('tallybee'))
  const keys = ['slug', 'folded'].filter(k => old && Object.hasOwn(old, k))
  return { slug: null, folded: false, ...pick(old, keys),
    ...JSON.parse(localStorage.getItem('tallybee-shared')) }
}

// These are explicit migrations of previous storage formats, not repairs of
// malformed state. Required fields still pass valid(), including requestid.
function legacy(raw, s) {
  const { prev = null, ...t } = JSON.parse(raw)
  return upgrade(valid({ comment: '', day: null, folded: false, at: s, slug: s,
                         undos: prev === null ? [] : [prev], ...t }))
}
const keyfor = s => JSON.stringify(s)
const oldkey = k => /^tallybee(?: |$)/.test(k)
const oldrecords = () => Object.fromEntries(Object.keys(localStorage)
  .filter(oldkey).map(k => [k, localStorage.getItem(k)]))
const same = (a, b) => ['count', 'requestid', 'pin', 'comment', 'day', 'undos']
  .every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
const archive = raw => localStorage.setItem(`tallybee-recovery ${crypto.randomUUID()}`, raw)
function initial() {
  const tallies = {}, legacyRecords = oldrecords()
  const old = legacyRecords.tallybee
  if (old !== undefined) {
    const t = legacy(old, JSON.parse(old).slug ?? null)
    tallies[keyfor(t.slug)] = t
  }
  for (const key of Object.keys(legacyRecords).filter(k => k.startsWith('tallybee '))) {
    const name = key.slice('tallybee '.length)
    const s = name === 'null' ? null : name
    const t = legacy(legacyRecords[key], s), previous = tallies[keyfor(s)]
    // TODO: Conflicting older saved tallies were both preserved.
    beeminder.assert(!previous || empty(previous) || same(previous, t),
                     `Numeri servati discrepant: ${s}`)
    tallies[keyfor(s)] = t
  }
  return { tallies, legacy: legacyRecords, conflicts: [] }
}
const object = t => t !== null && typeof t === 'object' && !Array.isArray(t)
function bookcheck(b) {
  beeminder.assert(object(b) && object(b.tallies) && object(b.legacy) &&
    Array.isArray(b.conflicts), JSON.stringify(b))
  Object.values(b.tallies).forEach(t => {
    valid(t)
    beeminder.assert(t.undos.every(u => typeof u._id === 'string' &&
      Number.isFinite(u._delta)), JSON.stringify(t))
  })
  return b
}
function reduceGoals(book, event, id) {
  bookcheck(book)
  const { slug: s, change } = event
  beeminder.assert(s === null || typeof s === 'string', JSON.stringify(event))
  const k = keyfor(s), t = book.tallies[k] ?? blank(s, id)
  if (change.type === 'assign') {
    const source = book.tallies.null
    // An occupied destination leaves both tallies intact. The caller reports
    // that conflict after saving, so a concurrent input cannot poison replay.
    if (source && !empty(source) && empty(t)) {
      book.tallies[k] = { ...source, at: s, slug: s }
      book.tallies.null = blank(null, id)
    } else {
      book.tallies[k] = t
      if (source && !empty(source)) book.conflicts.push(event)
    }
  } else if (change.type === 'import' && !empty(t)) {
    // The conflicting source is already archived; the caller reports it.
    book.tallies[k] = t
    if (!same(t, change.state)) book.conflicts.push(event)
  } else book.tallies[k] = valid(reduce(t, change, id))
  return book
}
function book() {
  const b = bookcheck(journal.read(STATE, initial, reduceGoals))
  // TODO: Conflicting pending tallies are preserved and require explicit resolution.
  beeminder.assert(b.conflicts.length === 0, 'Numeri servati discrepant')
  return b
}
export function load() {
  return valid({ ...(book().tallies[keyfor(slug)] ?? blank(slug)),
    ...preferences(), slug })
}
function save(change, s = slug) {
  return journal.append(STATE, { slug: s, change }, initial, reduceGoals)
}
function update(change) {
  save(change)
  render()
}
function remember(fields) {
  localStorage.setItem('tallybee-shared', JSON.stringify({ ...preferences(), ...fields }))
  render()
}

// An old version can still write its private backups. Preserve those writes
// and report the conflict; guessing how to merge two pending datapoints would
// risk either losing taps or sending them twice.
function checkLegacy() {
  const previous = book().legacy, current = oldrecords()
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter(k => previous[k] !== current[k])
  for (const k of changed) {
    archive(JSON.stringify({ key: k, previous: previous[k], current: current[k] }))
    if (current[k] !== undefined) archive(current[k])
  }
  // TODO: An older TallyBee window changed saved data; all copies were preserved.
  beeminder.assert(changed.length === 0, 'Altera versio numeros mutavit')
}

// Preserve the old window's private state before retiring sessionStorage.
// Distinct unfinished datapoints are a conflict, never implicitly added or
// replaced. An untouched installation tab has no datapoint to recover.
function migrate() {
  const raw = sessionStorage.getItem('tallybee')
  if (raw !== null) archive(raw)
  checkLegacy()
  if (raw !== null) {
    const stored = JSON.parse(raw)
    const s = Object.hasOwn(stored, 'at') ? stored.at : slug
    const t = legacy(raw, s)
    if (!empty(t)) {
      const durable = save({ type: 'import', state: t }, s).tallies[keyfor(s)]
      // TODO: Two different pending tallies were preserved; resolve their conflict.
      beeminder.assert(same(durable, t), `Numeri discrepant: ${s}; ${t.count}`)
    }
    sessionStorage.removeItem('tallybee')
  }
  save({ type: 'init' })
}

// Throw unless t is something TallyBee can remember (see load); else return t
function valid(t) {
  const datapoint = p => Number.isFinite(p.count) &&
                         typeof p.requestid === 'string' &&
                         (p.pin === null || typeof p.pin?.slug === 'string' &&
                                            Number.isFinite(p.pin.base)) &&
                         typeof p.comment === 'string' &&
                         (p.day === null || /^\d{8}$/.test(p.day))
  beeminder.assert(datapoint(t) && Array.isArray(t.undos) &&
                   t.undos.every(u => datapoint({ ...t, ...u })) &&
                   (t.slug === null || typeof t.slug === 'string') &&
                   (t.at === null || typeof t.at === 'string') &&
                   typeof t.folded === 'boolean',
                   JSON.stringify(t))
  return t
}

// An edit's keystrokes are durable individually and form one UNDO step.
// The reducer also includes requestid in the group, so a Submit or Clear
// ends the preceding datapoint's edit even when the field keeps its focus.
let before
function edits(field) {
  field.addEventListener('focus', () => { before = crypto.randomUUID() })
  field.addEventListener('blur', () => { before = undefined })
}
function edited(keys, f) {
  beeminder.assert(before !== undefined, JSON.stringify({ before: typeof before }))
  const t = load()
  f(t)
  update({ type: 'edit', values: pick(t, keys), edit: before })
}
function change(keys, f) {
  const t = load()
  f(t)
  update({ type: 'change', values: pick(t, keys) })
}

// The user, from Beeminder, once the goals have loaded (see loadGoals); till
// then, a stand-in with no timezone, which, for what day it is (see daystamp),
// means the device's
const NOUSER = { username: '', timezone: undefined }

// Throw unless gs is a list of goals, and u a user, as TallyBee needs them from
// Beeminder (see NOGOAL and NOUSER); else return them, as { goals, user }
function goalscheck(gs, u) {
  gs.forEach(({ slug, kyoom, safesum, queued, deadline }) => beeminder.assert(
    typeof slug === 'string' && typeof kyoom === 'boolean' &&
    typeof safesum === 'string' && typeof queued === 'boolean' &&
    Number.isFinite(deadline),
    JSON.stringify({ slug, kyoom, safesum, queued, deadline })))
  beeminder.assert(typeof u.username === 'string' && typeof u.timezone === 'string',
                   JSON.stringify({ username: u.username, timezone: u.timezone }))
  return { goals: gs, user: u }
}

// The user's goals, and the user, as they last loaded from Beeminder (see
// loadGoals). Each tab keeps them, in its sessionStorage, for as long as the
// same user is logged in, so that a page loading there, as for another goal,
// shows them from the start, till they load again: an odometer-like goal's
// reading, say, rather than the count with no goal to build on. Otherwise,
// till they load, there are none, and the stand-in for the user. (The tab's
// own sessionStorage, unlike localStorage, sets off no other window: see the
// storage listener.)
const kept = JSON.parse(sessionStorage.getItem('tallybee-goals')) ?? { user: NOUSER }
let { goals, user } = kept.user.username === beeminder.getUsername()
  ? goalscheck(kept.goals, kept.user) : { goals: [], user: NOUSER }

// The paths of TallyBee's pages: TallyBee's own, /, which names no goal (or
// /index.html, which GitHub Pages serves index.html at too); and each goal's,
// its user's name and its slug, as on Beeminder's own site, like
// /alice/pushups/ (see goalurl), with or without the slash at the end, as
// Beeminder's own URLs have none. GitHub Pages has no file for a goal's page,
// and so serves its 404.html, which is TallyBee itself (see index.html).
const PATHS = /^\/(?:index\.html|(?<user>[^/]+)\/(?<slug>[^/]+)\/?)?$/
// What this page's URL names, as PATHS reads its path
const named = location.pathname.match(PATHS)
// the error for a URL of TallyBee's that's none of its pages (see
// PATHS), like tallybee.beeminder.com/alice, naming its path, like: TallyBee
// has no page at "/alice" (conceptually but not technically a 404)
beeminder.assert(named !== null, `TallyBee 404: "${location.pathname}"`)

// Whose goal this page is for, by name: the user its URL names, else (as at
// TallyBee's own URL) u, the user logged in, as Beeminder has it (see user)
const owner = u => named.groups.user ?? u.username

// This page's goal, by its slug: the one its URL names; else the one its URL
// names as TallyBee's URLs did before 2026-11-04, as old links and home-screen
// icons still do, like tallybee.beeminder.com/?goal=pushups, for whoever's
// logged in; else the one selected last (or, the first time, till the goals
// load, none)
let slug = named.groups.slug ?? new URLSearchParams(location.search).get('goal')
slug ??= preferences().slug ?? null
migrate()

// The URL of TallyBee, as a path, for user u's goal s: its user's name and its
// slug, as on Beeminder's own site, but with a slash at the end (see
// manifest), like /alice/pushups/, for tallybee.beeminder.com/alice/pushups/.
// With no telling whose, as when logged out at TallyBee's own URL, it's as
// TallyBee's URLs were before 2026-11-04, like /?goal=pushups; and with no
// goal, TallyBee's own, /. Picking a goal in the dropdown loads its URL, and
// the page puts its goal in its URL once the goals load, so a bookmark made
// from the page opens that goal, and so does a home-screen icon, if made from
// a page loaded at its goal's URL. (One made from a page loaded at a URL that
// names no goal, like TallyBee's own, opens whichever goal was selected last.)
const goalurl = (u, s) => s === null ? '/' :
  u ? `/${u}/${s}/` : '/?' + new URLSearchParams({ goal: s })

// The page's app manifest, which is what makes TallyBee installable as an app,
// for this page's goal: an app installed from the page (or a home-screen icon
// added from it) is named for the goal, and opens it. With no goal, it's named
// TallyBee, like the page, and opens TallyBee's own URL. An app is for the URLs
// within its scope, those whose path starts with its scope's, and Chrome on
// Android offers to install a page as an app only if no app it has installed
// is for the page's URL. So each goal's app has the goal's own URL as its
// scope, so that each goal can have an app of its own, rather than TallyBee's
// own URL, /, that of every page of TallyBee's, as all apps from TallyBee had
// before 2026-11-04; and that URL ends in a slash, so that an app for a goal
// called push, say, isn't for pushups' URL too. It's a data: URL, made afresh
// when the page's goal changes (see loadGoals), so its URLs are absolute, as a
// data: URL is no base for relative ones.
function manifest() {
  const url = u => new URL(u, document.baseURI).href
  const icon = (src, sizes, purpose) => ({ src: url(src), sizes, purpose,
                                           type: 'image/png' })
  const name = slug ?? document.title
  const here = url(goalurl(owner(user), slug))
  return 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify({
    name,
    short_name: name, // what Android shows under the icon
    description: document.querySelector('meta[name=description]').content,
    id: here,
    start_url: here,
    scope: here,
    display: 'standalone',
    background_color: '#000000',
    theme_color: document.querySelector('meta[name=theme-color]').content,
    icons: [icon('icon-192.png', '192x192', 'any'),
            icon('icon-512.png', '512x512', 'any'),
            icon('icon-maskable.png', '512x512', 'maskable')],
  }))
}

// Make TallyBee installable as an app (see manifest). The page starts with no
// manifest, since Safari reads only the first one a page has. It's added here,
// before anything that waits, so that it's there by the time the
// page has loaded, for browsers that go by what they find then.
document.head.append(Object.assign(document.createElement('link'),
                                   { id: 'manifest', rel: 'manifest', href: manifest() }))

// Whether TallyBee is waiting on something, so can't take another datapoint
// or goal: on Beeminder to take a datapoint, or on another goal's page to load
let busy = false

// Throw unless d is a datapoint as TallyBee needs one from Beeminder: with a
// value, a daystamp, and a comment; else return d
function dpcheck(d) {
  beeminder.assert(Number.isFinite(d.value) && /^\d{8}$/.test(d.daystamp) &&
                   typeof d.comment === 'string', JSON.stringify(d))
  return d
}

// A datapoint's value is the count plus a base: 0 if goal g is cumulative
// (kyoom, in Beeminder jargon), otherwise g's current value, since then each
// datapoint is a new total, like an odometer reading. That's the value of the
// datapoint added to g last, or, with none, g's curval (Beeminder's name for a
// goal's current value). Beedroid's tally counter works the same way. For a
// pending datapoint last sent to g, though, the base is its pin's (see pin).
const livebase = g => g.kyoom ? 0 : (g.last_datapoint?.value ?? g.curval)
const pinned = (g, t) =>
  t.pin?.slug === g.slug ? t.pin : { slug: g.slug, base: livebase(g) }
const value = (g, t) => add(t.count, pinned(g, t).base)

// Stand-in for this page's goal when there isn't one (like before the goals
// load, or if you have no goal called slug) so Submit can be grayed out and
// nothing else needs to care. A goal's safesum is Beeminder's one-line summary
// of what's due, like "+37 pushups due by 5pm". A goal is queued (Beeminder's
// word) while Beeminder updates it, safesum and all, as after it gets a
// datapoint. Its deadline is when its day ends, in seconds after midnight (or,
// negative, before it).
const NOGOAL = { slug: '', kyoom: true, safesum: '', queued: false, deadline: 0,
                 last_datapoint: null }
// This page's goal among goals gs, the goals of user u, if this page's goal is
// u's (see owner); else NOGOAL
const goalof = (gs, u) =>
  gs.find(g => g.slug === slug && owner(u) === u.username) ?? NOGOAL
const goal = () => goalof(goals, user)

// The daystamp of the day it is now for goal g, as Beeminder counts days: in
// the user's timezone, with each day ending at g's deadline. (From the date's
// parts, like 2026, 10 and 02, not from the date as the browser writes it,
// which is up to the locale's ways.)
function daystamp(g) {
  const { year, month, day } = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: user.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(Date.now() - g.deadline * 1000).map(p => [p.type, p.value]))
  return year + month + day
}

// The daystamp of the day k days before the day with daystamp ds
const back = (ds, k) => new Date(Date.UTC(ds.slice(0, 4), ds.slice(4, 6) - 1,
  ds.slice(6) - k)).toISOString().slice(0, 10).replaceAll('-', '')

// The page's today: the day it was for the page's goal (see daystamp) as the
// page loaded, or, if the goal wasn't among the goals kept then (see goals),
// as the goals first loaded with it, since the day depends on the goal. It
// stays the same till the page loads again, even once the goal's deadline has
// passed, so that the days to pick from, and the day Submit sends a datapoint
// for, never change under you; a banner says when it's out of date (see
// #newday).
let today = daystamp(goal())

// How many days the day dropdown offers: today and the 6 before it
const DAYS = 7

// What the day dropdown calls the day with daystamp ds, k days before today,
// as Beeminder's own form does, like "Today (2nd)": the browser's words for
// "today", "yesterday" and "2 days ago", and the day of the month
const ago = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const ordinal = new Intl.PluralRules('en', { type: 'ordinal' })
const SUFFIX = { one: 'st', two: 'nd', few: 'rd', other: 'th' }
function dayname(ds, k) {
  const a = ago.format(-k, 'day'), d = Number(ds.slice(6))
  return `${a[0].toUpperCase()}${a.slice(1)} (${d}${SUFFIX[ordinal.select(d)]})`
}

// The days the day dropdown offers, as [daystamp, k days before today]: the
// last DAYS of them, and day, if it was picked longer ago than that
function days(day) {
  const ds = [...Array(DAYS).keys()].map(k => back(today, k))
  const utc = s => Date.UTC(s.slice(0, 4), s.slice(4, 6) - 1, s.slice(6))
  return [...new Set([...ds, day ?? today])]
    .map(s => [s, (utc(today) - utc(s)) / 864e5])
}

// The comment field's placeholder, from index.html, for when the goal has no
// datapoint, or none with a comment, to take one from (see render)
const PLACEHOLDER = $('comment').placeholder

// Make the page show the current state of things
function render() {
  const g = goal(), t = load(), v = value(g, t)
  const out = !beeminder.getUsername() // whether logged out
  // The big number is the number to send, always: the count, on a goal that
  // sums its datapoints, and on an odometer-like one, the reading
  $('count').textContent = v
  $('count').style.setProperty('--len', String(v).length)
  // The field says it too, even while it's being typed in, as what's typed
  // there is the number to send at each keystroke (see #num), but for a minus
  // waiting there for its digits
  $('num').value = minus ? '-' : v
  // As wide as what it says, typed or not (see style.css)
  $('num').style.setProperty('--len', $('num').value.length)
  // The top line: the goal's name (see the goal's link, below), and its
  // safesum (none, with no goal)
  $('safesum').textContent = g.safesum
  $('safesum').setAttribute('aria-busy', g.queued) // grayed out: out of date
  // The datapoint added to the goal last, as Beeminder's own site shows it:
  // its day of the month, value, and comment, if it has one, like 30 3 "set 1"
  // (or, with none, 29 120)
  const dp = g.last_datapoint
  $('lastdp').textContent = dp === null ? '' : `${dp.daystamp.slice(6)} ${dp.value}` +
    (dp.comment === '' ? '' : ` "${dp.comment}"`)
  // As in Beeminder's own form, the comment field shows the last comment, if
  // any (with none, as with no datapoint, it says what it's for)
  $('comment').placeholder = dp?.comment || PLACEHOLDER
  $('sigma').hidden = !g.kyoom
  // Logged out, as after Beeminder rejects our token, the goals can still be
  // there, as they last loaded, but nothing can be sent to them
  $('subbut').disabled = busy || g === NOGOAL || out
  // With a tally of 0, there's nothing for Clear to clear
  $('clearbut').disabled = busy || t.count === 0
  $('comment').disabled = $('num').disabled = busy
  // (Setting it to what it says already, as after each keystroke, leaves the
  // cursor where it is)
  $('comment').value = t.comment
  $('day').replaceChildren(...days(t.day)
    .map(([ds, k]) => new Option(dayname(ds, k), ds)))
  $('day').value = t.day ?? today
  $('undobut').disabled = busy || t.undos.length === 0
  $('drawer').hidden = t.folded
  $('foldbut').setAttribute('aria-expanded', !t.folded)
  // Picking a goal loads another page, which wouldn't hear Beeminder's reply.
  // And with no goals, like when logged out, there's nothing to pick, and no
  // telling what day it is for the goal.
  $('goals').disabled = $('day').disabled = busy || goals.length === 0
  // The goal's name on the top line, after the user's, as Beeminder writes a
  // goal, like alice/pushups, as README open question 5 has it
  // ("username/goalname"); and the goal's page on Beeminder, its link's words
  // saying where it goes, as the README's wishlist 4 has it:
  // "beeminder.com/USER/GOAL". With no goal, the user's name alone (none,
  // before the goals load), and just beeminder.com, with no link (grayed out:
  // see style.css).
  if (g === NOGOAL) { $('goalname').textContent = user.username
                      $('goallink').textContent = 'beeminder.com'
                      $('goallink').removeAttribute('href') }
  else { $('goalname').textContent = `${user.username}/${g.slug}`
         $('goallink').textContent = `beeminder.com/${user.username}/${g.slug}`
         $('goallink').href = `https://www.beeminder.com/${user.username}/${g.slug}` }
  $('infinibee').hidden = !busy
  // The page starts out blank but for the infinibee (see #footer in index.html)
  $('footer').hidden = $('menubut').hidden = false
  // Logged in, the login button is hidden, as the top line says who's logged
  // in (see #goalname): pressing it would log in again, which gets a new token,
  // and so logs TallyBee out on your other devices (Beeminder keeps one token
  // per app)
  $('loginbut').hidden = !out
  // What has the keyboard's focus and just got grayed out, like UNDO with
  // nothing left to undo, hands it to the big button, so that Space counts
  // again, rather than letting the browser drop it onto nothing
  if (document.activeElement.disabled) $('bigbut').focus()
}

// Show message msg in the status line, styled according to kind: busy, ok, err
function say(kind, msg) {
  $('status').dataset.kind = kind
  $('status').textContent = msg
}

// Show an error in the status line, and whatever else it changed, like being
// logged out when Beeminder rejects our token
function fail(err) {
  // prefix saying that what follows is an error message (which comes from
  // Beeminder, the browser, or an assert)
  say('err', `Error: ${err.message}`)
  // What failed may be TallyBee's starting, before it has shown anything, and
  // with render unable to, so that this is all that takes the page out of its
  // blank start (see #footer in index.html)
  $('footer').hidden = $('menubut').hidden = false
  $('infinibee').hidden = true
  render()
}

// Add d to the count, with a 25ms buzz like Beedroid (where the phone can
// buzz: iPhones can't)
function bump(d) {
  update({ type: 'add', amount: d })
  navigator.vibrate?.(25)
}

// Run f in its turn, in this window, after the turns asked for before it, one
// at a time: sending a datapoint, or loading the goals. So goals the window
// fetches are never older than datapoints it has sent, and the goals it shows
// are those of the load it asked for last. Other windows hear of each
// datapoint once it's sent, and load the goals again (see sent).
// The turns are the window's own, under a lock of its own, LOCK: with one lock
// for all TallyBee windows (tabs, home-screen icons), a window that the
// browser froze, as Chrome on Android does a page a minute after it goes to
// the background, held up all the others for as long as it stayed frozen, if
// it froze with a turn under way, or one that came due then.
// An error doesn't stall things: the lock goes to what's next, and the error,
// which nothing here catches, shows up in the status line like any other (see
// the unhandledrejection listener).
const LOCK = `tallybee ${crypto.randomUUID()}`
function enqueue(f) {
  navigator.locks.request(LOCK, f)
}

// If Beeminder is updating this page's goal (see NOGOAL), load the goals again
// in 2 seconds, and so on till it's done, with at most one such load waiting
// at a time
let polltimer
function poll() {
  clearTimeout(polltimer)
  if (goal().queued) polltimer = setTimeout(refresh, 2000)
}

// Put the goals in the dropdown, selecting this page's goal, if it's one of
// them (see goalof)
function dropdown() {
  $('goals').replaceChildren(...goals.map(g => new Option(g.slug)))
  $('goals').value = goal().slug
}

// Get the user's goals, and the user, from Beeminder, keep them (see goals),
// and put the goals in the dropdown, selecting this page's goal, or, the first
// time, the most urgent one, and put it in the URL (see goalurl). Then poll.
// If this page's goal is none of the user's (like from a typo in a link, a
// link to a goal since renamed, or a link to someone else's goal), then, with
// no goal selected (see NOGOAL), say so.
async function loadGoals() {
  const [gs, u] = await Promise.all([beeminder.getGoals(), beeminder.getUser()])
  goalscheck(gs, u)
  const next = slug ?? gs[0]?.slug ?? null
  if (next !== slug) {
    const saved = save({ type: 'assign' }, next)
    // TODO: A tally already exists for the first goal; both tallies were preserved.
    beeminder.assert(!saved.tallies.null || empty(saved.tallies.null),
                     `Iam numerus servatus est: ${next}`)
  }
  slug = next
  // The goal's last datapoint, for the base of an odometer-like goal (see
  // livebase), and to show (see render), is the datapoint added to it last,
  // which isn't always the one Beeminder calls last_datapoint
  const g = goalof(gs, u)
  if (g !== NOGOAL) g.last_datapoint = await beeminder.getLastAdded(g.slug) ?? null
  if (g.last_datapoint !== null) dpcheck(g.last_datapoint)
  // Everything's here now, so show it all at once. The goals that first
  // bring the page's goal set its today (see today).
  const unknown = goal() === NOGOAL
  goals = gs
  user = u
  if (unknown) today = daystamp(goal())
  sessionStorage.setItem('tallybee-goals', JSON.stringify({ goals, user }))
  dropdown()
  history.replaceState(null, '', goalurl(owner(user), slug))
  $('manifest').href = manifest()
  remember({ slug })
  poll()
  beeminder.assert(slug === null || g !== NOGOAL,
                   `No such goal: "${owner(user)}/${slug}"`)
}

// What a datapoint's comment says when none is typed, as Beedroid's tally
// counter's does, like "via tallybeedroid at 16:45:08 PST", but "via
// tallybee": which app sent it, and when (now), by the clock of the user's
// timezone on Beeminder, as in Beedroid, like "via tallybee at 16:45:08 PDT".
// The hours go from 00 to 23, and the timezone's abbreviation is the one in
// effect, where Beedroid's is always the one for standard time, PST even in
// summer. (From the time's parts, as for daystamp. Submit is grayed out till
// the goals load, which they do with the user: see NOUSER.)
function via() {
  beeminder.assert(user !== NOUSER, JSON.stringify({ user }))
  const { hour, minute, second, timeZoneName } = Object.fromEntries(
    new Intl.DateTimeFormat('en', { timeZone: user.timezone, hourCycle: 'h23',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })
    .formatToParts(Date.now()).map(p => [p.type, p.value]))
  return `via tallybee at ${hour}:${minute}:${second} ${timeZoneName}`
}

// Send the count, as it was when Submit got pressed, to Beeminder as a
// datapoint on this page's goal. Submit stays grayed out till Beeminder replies,
// but taps keep counting meanwhile, for next time.
// The comment that goes with it, too, is the one from when Submit got pressed:
// as typed, or, with none typed, which app sent it, and when (see via), as in
// Beedroid, whose form for typing a datapoint adds its "via beedroid at" and
// the time only to one with no comment. And so is its day: the one picked, or
// else the page's today (see day).
function submit() {
  const { count: n, comment: typed, day, requestid } = load()
  const comment = typed || via()
  const ds = day ?? today
  busy = true
  // status line while waiting for Beeminder to take the datapoint
  say('busy', 'Submitting…')
  render()
  enqueue(async () => {
    try {
      await navigator.locks.request(`tallybee-send ${slug}`, { ifAvailable: true }, async lock => {
      // TODO: Another window is already submitting this goal's tally.
      beeminder.assert(lock !== null, 'Numerus iam mittitur')
      // TODO: The pending tally changed before this submission could begin.
      beeminder.assert(load().requestid === requestid, 'Numerus mutatus est')
      const g = goal()
      beeminder.assert(g !== NOGOAL, JSON.stringify({ slug }))
      const { pin } = load() // as it was before this send
      // Pin the pending datapoint's base, if this is its first time out, or it
      // was last sent to another goal
      update({ type: 'pin', requestid, pin: pinned(g, load()) })
      const t = load()
      const dp = await beeminder.addDatapoint(g.slug, add(n, t.pin.base), ds,
        comment, t.requestid).catch(e => {
          // Beeminder turned this send away for want of a login it accepts, so
          // the datapoint didn't get there this time, and gets no pin from it
          if (e.message === beeminder.REAUTH) update({ type: 'unpin', requestid, pin })
          throw e
        })
      g.last_datapoint = dpcheck(dp)
      g.queued = true // as Beeminder has it now, till the goals load again
      update({ type: 'accepted', requestid, n })
      // status line once Beeminder has the datapoint, with its value and
      // goal (Beedroid says "Submission successful!")
      say('ok', `✓ Submission successful: ${dp.value} → ${g.slug}`)
      sent.postMessage(g.slug)
      poll()
      })
    } finally {
      busy = false
      render()
    }
  })
}

// Business logic: increment the number when you click the thing
// Count a tap when the finger (or nose) lifts, however long it was down, like
// Beedroid does. With several fingers down at once, only the first one counts.
// With a mouse, only its main button counts, not the right or middle one
// (button 0, the one that a finger's touch counts as too).
$('bigbut').addEventListener('pointerup', e => {
  if (e.isPrimary && e.button === 0) bump(1)
})
// A tap while the number to send, or the comment, is being typed ends that
// edit first (see #num and #comment), and then counts, as a change of its own,
// for UNDO
$('bigbut').addEventListener('pointerdown', () => { $('num').blur()
                                                    $('comment').blur() })
$('bigbut').addEventListener('contextmenu', e => e.preventDefault())
// On a keyboard, Space and Enter count, as they'd press any button, once per
// press, however long the key is held (a held key repeats)
$('bigbut').addEventListener('keydown', e => {
  if (!e.repeat && (e.key === ' ' || e.key === 'Enter')) bump(1)
})
// The big button starts out with the keyboard's focus, so that Space counts
// right away, but with no ring around it till the keyboard moves the focus
$('bigbut').focus({ focusVisible: false })
// Tell screen readers the count, as after −1, UNDO or Clear, whose button has
// the focus, not the count (see #said)
const announce = () => { $('said').textContent = $('count').textContent }
$('minusbut').addEventListener('click', () => { bump(-1); announce() })
// What's typed as the number to send is the number to send, at each keystroke:
// the count becomes that number, less the base on an odometer-like goal (see
// livebase), and the field then shows it as JavaScript writes it, like 5 for
// 05, and 0 for nothing. It's a whole number, of up to 15 digits (as many as
// JavaScript's numbers hold exactly), with a minus in front if it's below 0. A
// keystroke that would make it anything else gets undone: the field shows the
// number to send again. But a minus with no digits yet waits for them, till
// the field is left (then it's undone too). So the field and the big number
// never say different things, but for that minus.
let minus = false // whether the field has a minus in it alone (see render)
edits($('num'))
$('num').addEventListener('input', () => {
  const s = $('num').value
  minus = s === '-'
  if (/^(-?\d{1,15})?$/.test(s))
    edited(['count'], t => { t.count = add(Number(s), -pinned(goal(), t).base) })
  else render()
})
$('num').addEventListener('blur', () => {
  minus = false
  render()
})
// Enter, the phone keyboard's done key, also submits the number's form (to
// nowhere), and that puts the keyboard away, as for the comment (see
// #comment), so that putting it away takes no tap on the big button, which
// would count
$('numform').addEventListener('submit', () => $('num').blur())
// Clearing the count also starts a new pending datapoint, so the next Submit
// can't overwrite one that Beeminder got without our hearing back. Clear, and
// UNDO, which can bring back the datapoint that a Clear replaced, take effect
// at once: from Submit's press till its turn ends, they're grayed out (see
// busy), so they never change a datapoint on its way, and a press of either
// then, which only a bug could let through, fails loudly.
$('clearbut').addEventListener('click', () => {
  beeminder.assert(!busy, JSON.stringify({ busy }))
  update({ type: 'clear' })
  announce()
})
// After an UNDO during an edit, the edit's next keystroke gives UNDO a way back
// again (see edits)
$('undobut').addEventListener('click', () => {
  beeminder.assert(!busy, JSON.stringify({ busy }))
  const t = load()
  beeminder.assert(t.undos.length > 0, JSON.stringify({ undos: t.undos }))
  update({ type: 'undo', target: t.undos.at(-1)._id })
  before &&= crypto.randomUUID()
  announce()
})
// Every keystroke in the comment gets remembered at once. One edit of it is one
// change, for UNDO (see edits).
edits($('comment'))
$('comment').addEventListener('input', () =>
  edited(['comment'], t => { t.comment = $('comment').value }))
// Picking a day is a change of its own, for UNDO
$('day').addEventListener('change',
                          () => change(['day'], t => { t.day = $('day').value }))
// Enter, the phone keyboard's done key, ends the edit and puts the keyboard
// away, so that putting it away takes no tap on the big button, which would
// count. (Not the Enter that settles a word typed with an IME, like in
// Japanese.)
$('comment').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) $('comment').blur()
})
// The fold button folds away the drawer, or brings it back
$('foldbut').addEventListener('click', () => remember({ folded: !load().folded }))
$('subbut').addEventListener('click', submit)
// The × at the end of a message takes it away (see #msgline), handing the
// keyboard's focus, which it had if pressed from the keyboard, to the big
// button, as when a control gets grayed out (see render)
$('dismiss').addEventListener('click', () => {
  say('', '')
  $('bigbut').focus()
})
// Picking a goal, in the menu, closes the menu and loads the goal's page,
// which can take a while; till it comes, TallyBee is busy, and shows it
$('goals').addEventListener('change', () => {
  busy = true
  render()
  $('menu').close()
  location.replace(goalurl(user.username, $('goals').value))
})
// Login button's label (logged in, it's hidden: see render).
// graph.beeminder.com's login button says "Log in with your Beeminder
// account".
$('loginbut').textContent = 'Log in with your Beeminder account'
// The login button sends you to Beeminder, which sends you right back (with an
// access token) if you've authorized TallyBee before. When you're logged in, it
// is hidden (see render).
$('loginbut').addEventListener('click',
                               () => beeminder.login(clientId, redirectUri))
// The menu button opens the menu, and the help button, in the menu, closes the
// menu and opens the help.
$('menubut').addEventListener('click', () => $('menu').showModal())
$('infobut').addEventListener('click', () => { $('menu').close()
                                               $('info').showModal() })
// Tapping outside the menu, or the help, closes it: taps on the backdrop go to
// the dialog element but taps on what's inside it stop there
for (const id of ['menu', 'info']) {
  $(id).addEventListener('click', () => $(id).close())
  $(id).querySelector('.modal-content').addEventListener('click', e => e.stopPropagation())
}
// Safari on iPhones shows a button as pressed (see :active in style.css) only
// while something is listening for touches, so this listens, and does nothing
document.body.addEventListener('touchstart', () => {}, { passive: true })
// Show what other TallyBee windows change of what they share with this one
// (see load), like the fold. When one logs in or out, load the goals again
// too. (Not on every change: loading the goals changes what's remembered,
// which would set off the other windows, and so on forever.)
window.addEventListener('storage', e => {
  if (oldkey(e.key)) {
    archive(JSON.stringify({ key: e.key, value: e.newValue }))
    checkLegacy()
  }
  render()
  if (!/^tallybee(?:[- ]|$)/.test(e.key)) refresh()
})
// Other TallyBee windows hear when this one's datapoint gets to Beeminder, and
// load the goals again, as it can change their goal, like its safesum, or, on
// an odometer-like goal, its reading
const sent = new BroadcastChannel('tallybee')
sent.addEventListener('message', refresh)
// Load the goals, when logged in: when the page loads, and again when you come
// back to TallyBee, to refresh things like their safesums, and when the
// connection comes back, as after TallyBee opened with none (see sw.js)
function refresh() {
  if (beeminder.getUsername()) enqueue(loadGoals)
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh()
})
window.addEventListener('online', refresh)

// Once it's another day for the page's goal than the page's today (see
// today), the goal's deadline having passed, the days to pick from are out of
// date, and so is what Beeminder said of the goal before then, like its
// safesum, so a banner says so, with a button that loads the page again, as
// on beeminder.com, rather than anything changing under you (README open
// question 7). It looks every second, till the banner's × takes it away, for
// good, the day being one that can't come back (see today); and, like the ×
// at the end of a message, hands the keyboard's focus to the big button.
const newday =
  setInterval(() => { $('newday').hidden = daystamp(goal()) === today }, 1000)
$('reload').addEventListener('click', () => location.reload())
$('newdayx').addEventListener('click', () => {
  clearInterval(newday)
  $('newday').hidden = true
  $('bigbut').focus()
})

// Let TallyBee open with no connection (see sw.js), where browsers can
navigator.serviceWorker?.register('sw.js')
dropdown() // as kept (see goals), till they load
remember({ slug }) // this page's goal is now the one selected last
// Log in with what Beeminder just sent us, if anything. Then load the goals,
// even if what Beeminder sent was an error (which fail then shows), unless it
// was an access token, which means loading the page again (see autoLogin).
let reloading = false
try {
  reloading = beeminder.autoLogin(goalurl(owner(user), slug))
} finally {
  if (!reloading) refresh()
}
