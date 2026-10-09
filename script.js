import * as beeminder from './beeminder.js';

// Convenience functions -------------------------------------------------------
function $(id) { return document.getElementById(id) } // to be jQuery-esque
// -----------------------------------------------------------------------------

const clientId = "6qi9cv7g647fisgzlz0flxwee"
const redirectUri = "https://tallybee.beeminder.com/"
// Beeminder sends a login back only to that URL, so a copy of TallyBee served
// from this directory (like with `python3 -m http.server`, at
// http://localhost:8000) can't log in itself. It can use the live TallyBee's
// login, though, as Beeminder lets any page call its API: in the browser's
// console on tallybee.beeminder.com, logged in, copy what
// localStorage.getItem('beeminder-token') says, and on the copy, paste it into
// localStorage.setItem('beeminder-token', ...) and reload. (Beeminder keeps one
// token per app, so it's the same login in both: the copy's Submit sends
// datapoints to your real goals. And the copy's login button, there once the
// copy is logged out, logs you out everywhere: Beeminder makes a new token,
// which stops the old one working on every device, and sends it to the live
// TallyBee, which turns it away, as a login it didn't ask for: see UNASKED in
// beeminder.js.)

// What to tell the user when another TallyBee window (or tab, or home-screen
// icon) changed the pending datapoint (see requestid, below) while this one was
// waiting to submit it, like by submitting it first.
const OTHERWIN = 
  "Another TallyBee window changed the tally before this one could submit!"

// Show any error, like Beeminder being unreachable or rejecting our token or an
// assert failing, in the status line
window.addEventListener('error', e => fail(e.error))
window.addEventListener('unhandledrejection', e => fail(e.reason))

// What TallyBee remembers, in localStorage. Every TallyBee tab and home-screen
// icon on the device can share it, so it's read afresh wherever it's used. (A
// goal's slug is its short name, the one in its URL, like the pushups in
// beeminder.com/alice/pushups.)
// count: taps, less −1s, not yet submitted to Beeminder (or what makes a
//   number typed as the number to send: see #num)
// requestid: Beeminder's idempotency key for the pending datapoint, the one
//   Submit sends. Resending the datapoint after a failure updates it in place
//   if Beeminder got it after all (as when only the reply got lost), rather than
//   adding it again. Each success, and each Clear, starts a new one.
// pin: {slug, base} for the pending datapoint, from when it was first sent to
//   the goal it was last sent to: that goal, and the base (see livebase) its
//   value was built on, so that a resend is the same datapoint even if the
//   goal's value has changed since, like by the pending datapoint itself
//   getting there. Null till then.
// comment: what the user typed to go with the pending datapoint (see submit),
//   like "felt strong", or empty for nothing
// day: the daystamp (Beeminder's way of writing a day, like 20261002) of the
//   day picked for the pending datapoint, or null for today, whatever day that
//   is when it's submitted (see daystamp)
// undos: what each change since the last Submit changed, as it was before, for
//   UNDO to put back, the last one last: {count}, for a tap, −1, or edit of the
//   number to send; or, for a Clear, which also starts a new pending
//   datapoint, {count, requestid, pin, comment, day}; or {comment}, for an edit
//   of the comment; or {day}, for a pick of the day. (Only what it changed,
//   since a Submit can change the pin after a tap.) Empty at first, and once a
//   Submit gets to Beeminder (which can't be undone, and which takes UNDO away
//   from taps made while it was sending, too).
// slug: the goal selected last, for when TallyBee's URL doesn't name one
// folded: whether the footer is folded, all but the bar (see #drawer in
//   index.html). Only the fold button changes it.
// (What TallyBee remembered when UNDO could take back only the last change has
// a prev, that change, or null, for none, instead of undos; and before that,
// no prev, for none.)
// (And what it remembered before there were comments, folding, or days gets no
// comment, unfolded, for today.)
function load() {
  const { prev = null, ...t } = { comment: '', folded: false, day: null,
    ...JSON.parse(localStorage.getItem('tallybee')) ??
    { count: 0, requestid: crypto.randomUUID(), pin: null, slug: null, undos: [] } }
  return valid({ undos: prev === null ? [] : [prev], ...t })
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
                   typeof t.folded === 'boolean',
                   JSON.stringify(t))
  return t
}

// Change what TallyBee remembers, with function f, and show the change. If f
// makes it something load couldn't read back, this throws, changing nothing.
function update(f) {
  const t = load()
  f(t)
  localStorage.setItem('tallybee', JSON.stringify(valid(t)))
  render()
}

// Start a new pending datapoint (see requestid and pin), with no comment, for
// today
function fresh(t) {
  t.requestid = crypto.randomUUID()
  t.pin = null
  t.comment = ''
  t.day = null
}

// The fields of t named in keys
const pick = (t, keys) => Object.fromEntries(keys.map(k => [k, t[k]]))

// Change the pending datapoint with function f, like update does, first
// remembering, for UNDO, how the fields named in keys, the ones f changes, were
// (see undos)
function change(keys, f) {
  update(t => {
    t.undos.push(pick(t, keys))
    f(t)
  })
}

// An edit of a text field, the comment or the number to send, from when it
// gets the focus till it loses it, is one change, for UNDO, which puts back
// what it changed as it was just before the edit's first keystroke. (Not as it
// was when the field got the focus, since another window can change it in
// between, as by submitting it.) Each keystroke gets remembered at once, with
// edited.
// before: the pending datapoint (its requestid) for which the edit under way
// has given UNDO a way back to before it: null from when the field gets the
// focus till the edit's first keystroke, and again after an UNDO during the
// edit (as when a button doesn't take the focus, like in Safari); undefined
// between edits. So once another pending datapoint starts during the edit, as
// when a Submit, from this window or another, gets to Beeminder (which takes
// UNDO's way back away: see undos), the edit's next keystroke gives UNDO a way
// back again.
let before
function edits(field) {
  field.addEventListener('focus', () => { before = null })
  field.addEventListener('blur', () => { before = undefined })
}

// Change the pending datapoint with function f, for a keystroke in an edit
// (see edits) of the fields named in keys, first giving UNDO a way back to
// before the edit, as they are, if it has none for this pending datapoint
function edited(keys, f) {
  beeminder.assert(before !== undefined, JSON.stringify({ before: typeof before }))
  update(t => {
    if (before !== t.requestid) t.undos.push(pick(t, keys))
    f(t)
    before = t.requestid
  })
}

// This page's goal: the one its URL names, else the one selected last (or, the
// first time, till the goals load, none)
let slug = new URLSearchParams(location.search).get('goal') ?? load().slug

// The URL of TallyBee with goal s selected, like
// tallybee.beeminder.com/?goal=pushups, or with no goal named if s is null.
// Picking a goal in the dropdown loads its URL, and the page puts its goal in
// its URL once the goals load, so a bookmark made from the page opens that goal,
// and so does a home-screen icon, if made from a page loaded at its goal's URL.
// (One made from a page loaded at a URL that names no goal, like TallyBee's own,
// opens whichever goal was selected last.)
const goalurl = s =>
  location.pathname + (s === null ? '' : '?' + new URLSearchParams({ goal: s }))

// The page's app manifest, which is what makes TallyBee installable as an app,
// for this page's goal: an app installed from the page (or a home-screen icon
// added from it) is named for the goal, and opens it. With no goal, it's named
// TallyBee, like the page, and opens TallyBee's own URL. It's a data: URL, made
// afresh when the page's goal changes (see loadGoals), so its URLs are
// absolute, as a data: URL is no base for relative ones.
function manifest() {
  const url = u => new URL(u, location.href).href
  const icon = (src, sizes, purpose) => ({ src: url(src), sizes, purpose,
                                           type: 'image/png' })
  const name = slug ?? document.title
  return 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify({
    name,
    short_name: name, // what Android shows under the icon
    description: document.querySelector('meta[name=description]').content,
    id: url(goalurl(slug)),
    start_url: url(goalurl(slug)),
    scope: url('/'),
    display: 'standalone',
    background_color: '#000000',
    theme_color: document.querySelector('meta[name=theme-color]').content,
    icons: [icon('icon-192.png', '192x192', 'any'),
            icon('icon-512.png', '512x512', 'any'),
            icon('icon-maskable.png', '512x512', 'maskable')],
  }))
}

// Whether TallyBee is waiting on something, so can't take another datapoint
// or goal: on Beeminder to take a datapoint, or on another goal's page to load
let busy = false

// a + b, less any stray digits from computers' binary arithmetic, as in 1 +
// 0.14 = 1.1400000000000001 (JavaScript's numbers have about 16 significant
// digits, of which this keeps 15)
const add = (a, b) => Number((a + b).toPrecision(15))

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
const goal = () => goals.find(g => g.slug === slug) ?? NOGOAL

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

// The daystamp of the day k days before today, for goal g, as Beeminder counts
// days: in the user's timezone, with each day ending at g's deadline
function daystamp(g, k) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: user.timezone })
    .format(Date.now() - g.deadline * 1000).split('-').map(Number) // like 2026-10-02
  return new Date(Date.UTC(y, m - 1, d - k)).toISOString().slice(0, 10)
    .replaceAll('-', '')
}

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

// The days the day dropdown offers, for goal g, as [daystamp, k days before
// today]: the last DAYS of them, and day, if it was picked longer ago than that
function days(g, day) {
  const ds = [...Array(DAYS).keys()].map(k => daystamp(g, k))
  const utc = s => Date.UTC(s.slice(0, 4), s.slice(4, 6) - 1, s.slice(6))
  return [...new Set([...ds, day ?? ds[0]])]
    .map(s => [s, (utc(ds[0]) - utc(s)) / 864e5])
}

// The comment field's placeholder, from index.html, for when the goal has no
// datapoint to take one from (see render)
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
  // The top line: the goal's name, and its safesum (none, with no goal)
  $('goalname').textContent = g.slug
  $('safesum').textContent = g.safesum
  $('safesum').setAttribute('aria-busy', g.queued) // grayed out: out of date
  // The datapoint added to the goal last, as Beeminder's own site shows it:
  // its day of the month, value, and comment, if it has one, like 30 3 "set 1"
  // (or, with none, 29 120)
  const dp = g.last_datapoint
  $('lastdp').textContent = dp === null ? '' : `${dp.daystamp.slice(6)} ${dp.value}` +
    (dp.comment === '' ? '' : ` "${dp.comment}"`)
  // As in Beeminder's own form, the comment field shows the last comment
  $('comment').placeholder = (dp ?? { comment: PLACEHOLDER }).comment
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
  $('day').replaceChildren(...days(g, t.day)
    .map(([ds, k]) => new Option(dayname(ds, k), ds)))
  $('day').value = t.day ?? daystamp(g, 0)
  $('undobut').disabled = busy || t.undos.length === 0
  $('drawer').hidden = t.folded
  $('foldbut').setAttribute('aria-expanded', !t.folded)
  // Picking a goal loads another page, which wouldn't hear Beeminder's reply.
  // And with no goals, like when logged out, there's nothing to pick, and no
  // telling what day it is for the goal.
  $('goals').disabled = $('day').disabled = busy || goals.length === 0
  // The goal's page on Beeminder; with no goal, no link (grayed out: see
  // style.css)
  if (g === NOGOAL) $('goallink').removeAttribute('href')
  else $('goallink').href = `https://www.beeminder.com/${user.username}/${g.slug}`
  $('infinibee').hidden = !busy
  // Login button's label when not logged in (when logged
  // in it shows the username). graph.beeminder.com's login button says "Log in
  // with your Beeminder account".
  $('loginbut').textContent = beeminder.getUsername() ?? 'Log in with your Beeminder account'
  // Logged in, it only says who's logged in: pressing it would log in again,
  // which gets a new token, and so logs TallyBee out on your other devices
  // (Beeminder keeps one token per app)
  $('loginbut').disabled = !out
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
  render()
}

// Add d to the count, with a 25ms buzz like Beedroid (where the phone can
// buzz: iPhones can't)
function bump(d) {
  change(['count'], t => { t.count = add(t.count, d) })
  navigator.vibrate?.(25)
}

// Run f in its turn, even across TallyBee windows (tabs, home-screen icons), in
// one of the Web Locks API's two modes: exclusive, for sending a datapoint,
// which runs alone; or shared, for loading the goals, and for Clear and UNDO,
// which can run alongside each other but not alongside a send. So goals we
// fetch are never older than datapoints we've sent, no window submits, clears,
// or undoes a datapoint that another is sending, and Clear and UNDO don't wait
// for goals to load (unless a send is waiting for them too).
// An error doesn't stall things: the lock goes to what's next, and the error,
// which nothing here catches, shows up in the status line like any other (see
// the unhandledrejection listener). (The browser lets go of the lock if a
// window closes.)
function enqueue(mode, f) {
  navigator.locks.request('tallybee', { mode }, f)
}

// If Beeminder is updating this page's goal (see NOGOAL), load the goals again
// in 2 seconds, and so on till it's done, with at most one such load waiting
// at a time
let polltimer
function poll() {
  clearTimeout(polltimer)
  if (goal().queued) polltimer = setTimeout(refresh, 2000)
}

// Put the goals in the dropdown, selecting this page's goal
function dropdown() {
  $('goals').replaceChildren(...goals.map(g => new Option(g.slug)))
  $('goals').value = slug
}

// Get the user's goals, and the user, from Beeminder, keep them (see goals),
// and put the goals in the dropdown, selecting this page's goal, or, the first
// time, the most urgent one, and put it in the URL (see goalurl). Then poll.
// If this page's goal is none of the user's (like from a typo in a link, or a
// link to a goal since renamed), then, with no goal selected (see NOGOAL), say
// so.
async function loadGoals() {
  const [gs, u] = await Promise.all([beeminder.getGoals(), beeminder.getUser()])
  goalscheck(gs, u)
  slug ??= gs[0]?.slug ?? null
  // The goal's last datapoint, for the base of an odometer-like goal (see
  // livebase), and to show (see render), is the datapoint added to it last,
  // which isn't always the one Beeminder calls last_datapoint
  const g = gs.find(g => g.slug === slug) ?? NOGOAL
  if (g !== NOGOAL) g.last_datapoint = await beeminder.getLastAdded(g.slug) ?? null
  if (g.last_datapoint !== null) dpcheck(g.last_datapoint)
  // Everything's here now, so show it all at once
  goals = gs
  user = u
  sessionStorage.setItem('tallybee-goals', JSON.stringify({ goals, user }))
  dropdown()
  history.replaceState(null, '', goalurl(slug))
  $('manifest').href = manifest()
  update(t => { t.slug = slug })
  poll()
  beeminder.assert(slug === null || g !== NOGOAL,
                   `No such goal: "${slug}"`)
}

// Send the count, as it was when Submit got pressed, to Beeminder as a
// datapoint on this page's goal. Submit stays grayed out till Beeminder replies,
// but taps keep counting meanwhile, for next time.
// The comment that goes with it, too, is the one from when Submit got pressed:
// the user's, as typed, and then which app sent it, and when. (A space goes
// between the two, so there's none with no comment.) And so is its day: the
// one picked, or else the day it was then (see day).
function submit() {
  const { count: n, requestid, comment, day } = load()
  const ds = day ?? daystamp(goal(), 0)
  busy = true
  // status line while waiting for Beeminder to take the datapoint
  say('busy', 'Submitting…')
  render()
  enqueue('exclusive', async () => {
    try {
      const g = goal()
      beeminder.assert(g !== NOGOAL, JSON.stringify({ slug }))
      const { pin } = load() // as it was before this send
      // Pin the pending datapoint's base, if this is its first time out, or it
      // was last sent to another goal
      update(t => {
        beeminder.assert(t.requestid === requestid, OTHERWIN)
        t.pin = pinned(g, t)
      })
      const t = load()
      const dp = await beeminder.addDatapoint(g.slug, add(n, t.pin.base), ds,
        `${comment}${comment === '' ? '' : ' '}via TallyBee at ${new Date()}`,
        t.requestid).catch(e => {
          // Beeminder turned this send away for want of a login it accepts, so
          // the datapoint didn't get there this time, and gets no pin from it
          if (e.message === beeminder.REAUTH) update(t => { t.pin = pin })
          throw e
        })
      g.last_datapoint = dpcheck(dp)
      g.queued = true // as Beeminder has it now, till the goals load again
      update(t => {
        beeminder.assert(t.requestid === requestid, OTHERWIN)
        t.count = add(t.count, -n)
        fresh(t)
        t.undos = []
      })
      // status line once Beeminder has the datapoint, with its value and
      // goal (Beedroid says "Submission successful!")
      say('ok', `✓ Submission successful: ${dp.value} → ${g.slug}`)
      poll()
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
// A tap while the number to send is being typed ends that edit first (see
// #num), and then counts, as a change of its own, for UNDO
$('bigbut').addEventListener('pointerdown', () => $('num').blur())
// A tap while the comment is being typed ends that edit first (see #comment),
// and then counts, as a change of its own, for UNDO
$('bigbut').addEventListener('pointerdown', () => $('comment').blur())
$('bigbut').addEventListener('contextmenu', e => e.preventDefault())
// On a keyboard, Space and Enter count, as they'd press any button, once per
// press, however long the key is held (a held key repeats)
$('bigbut').addEventListener('keydown', e => {
  if (!e.repeat && (e.key === ' ' || e.key === 'Enter')) bump(1)
})
// The big button starts out with the keyboard's focus, so that Space counts
// right away, but with no ring around it till the keyboard moves the focus
$('bigbut').focus({ focusVisible: false })
$('minusbut').addEventListener('click', () => bump(-1))
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
// can't overwrite one that Beeminder got without our hearing back. It waits
// its turn (see enqueue), like for another window to finish submitting, and so
// does UNDO, which can bring back the datapoint that a Clear replaced.
$('clearbut').addEventListener('click', () => enqueue('shared',
  () => change(['count', 'requestid', 'pin', 'comment', 'day'],
               t => { t.count = 0; fresh(t) })))
// After an UNDO during an edit, the edit's next keystroke gives UNDO a way back
// again (see edits)
$('undobut').addEventListener('click', () => enqueue('shared', () => {
  update(t => {
    beeminder.assert(t.undos.length > 0, JSON.stringify({ undos: t.undos }))
    Object.assign(t, t.undos.pop())
  })
  before &&= null
}))
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
$('foldbut').addEventListener('click', () => update(t => { t.folded = !t.folded }))
$('subbut').addEventListener('click', submit)
// Picking a goal, in the menu, closes the menu and loads the goal's page,
// which can take a while; till it comes, TallyBee is busy, and shows it
$('goals').addEventListener('change', () => {
  busy = true
  render()
  $('menu').close()
  location.replace(goalurl($('goals').value))
})
// The login button sends you to Beeminder, which sends you right back (with an
// access token) if you've authorized TallyBee before. When you're logged in, it
// shows your username instead, and can't be pressed (see render).
$('loginbut').addEventListener('click',
                               () => beeminder.login(clientId, redirectUri))
// The menu button opens the menu, and the help button, in the menu, closes the
// menu and opens the help. (Clear, in the menu, closes it as its form says: see
// index.html.)
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
// Show what other TallyBee tabs and icons change, like their taps. When one
// logs in or out, or changes which datapoint is pending (see requestid), as a
// Submit that gets to Beeminder does (which can change an odometer goal's
// value), and so do a Clear and the UNDO of one, load the goals again too.
// (Not on every change: loading the goals changes what's remembered, which
// would set off the other windows, and so on forever.)
window.addEventListener('storage', e => {
  render()
  if (e.key !== 'tallybee' ||
      JSON.parse(e.oldValue)?.requestid !== JSON.parse(e.newValue)?.requestid)
    refresh()
})
// Load the goals, when logged in: when the page loads, and again when you come
// back to TallyBee, to refresh things like their safesums, and when the
// connection comes back, as after TallyBee opened with none (see sw.js)
function refresh() {
  if (beeminder.getUsername()) enqueue('shared', loadGoals)
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh()
})
window.addEventListener('online', refresh)

// Let TallyBee open with no connection (see sw.js), where browsers can
navigator.serviceWorker?.register('sw.js')
// Make TallyBee installable as an app (see manifest). The page starts with no
// manifest, since Safari reads only the first one a page has.
document.head.append(Object.assign(document.createElement('link'),
                                   { id: 'manifest', rel: 'manifest', href: manifest() }))

dropdown() // as kept (see goals), till they load
update(t => { t.slug = slug }) // this page's goal is now the one selected last
// Log in with what Beeminder just sent us, if anything. Then load the goals,
// even if what Beeminder sent was an error (which fail then shows), unless it
// was an access token, which means loading the page again (see autoLogin).
let reloading = false
try {
  reloading = beeminder.autoLogin(goalurl(slug))
} finally {
  if (!reloading) refresh()
}
