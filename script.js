import * as beeminder from './beeminder.js';

// Convenience functions -------------------------------------------------------
function $(id) { return document.getElementById(id) } // to be jQuery-esque
// -----------------------------------------------------------------------------

const clientId = "6qi9cv7g647fisgzlz0flxwee"
const redirectUri = "https://tallybee.beeminder.com/"

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
// count: taps, less −1s, not yet submitted to Beeminder
// requestid: Beeminder's idempotency key for the pending datapoint, the one
//   Submit sends. Resending the datapoint after a failure updates it in place
//   if Beeminder got it after all (as when only the reply got lost), rather than
//   adding it again. Each success, and each Clear, starts a new one.
// pin: {slug, base} for the pending datapoint, from when it was first sent to
//   the goal it was last sent to: that goal, and the base (see livebase) its
//   value was built on, so that a resend is the same datapoint even if the
//   goal's value has changed since, like by the pending datapoint itself
//   getting there. Null till then.
// prev: {count, requestid, pin} as they were before the last tap, −1 or Clear,
//   for UNDO to put back. Null when there's nothing to undo: at first, after an
//   UNDO (which undoes only the last thing), and after a Submit (which can't be
//   undone).
// slug: the goal selected last, for when TallyBee's URL doesn't name one
// (What TallyBee remembered before there was a prev, or anything else added
// since, gets the value it would have at first.)
function load() {
  return valid({ count: 0, requestid: crypto.randomUUID(), pin: null, prev: null,
                 slug: null, ...JSON.parse(localStorage.getItem('tallybee')) })
}

// Throw unless t is something TallyBee can remember (see load); else return t
function valid(t) {
  const datapoint = p => Number.isInteger(p.count) &&
                         typeof p.requestid === 'string' &&
                         (p.pin === null || typeof p.pin?.slug === 'string' &&
                                            Number.isFinite(p.pin.base))
  beeminder.assert(datapoint(t) && (t.prev === null || datapoint(t.prev)) &&
                   (t.slug === null || typeof t.slug === 'string'),
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

// Start a new pending datapoint (see requestid and pin)
function fresh(t) {
  t.requestid = crypto.randomUUID()
  t.pin = null
}

// Change the pending datapoint with function f, like update does, first
// remembering how it was, for UNDO (see prev)
function change(f) {
  update(t => {
    t.prev = { count: t.count, requestid: t.requestid, pin: t.pin }
    f(t)
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

let goals = []   // the user's goals from Beeminder, once they've loaded
let busy = false // whether we're waiting on Beeminder to take a datapoint

// a + b, less any stray digits from computers' binary arithmetic, as in 1 +
// 0.14 = 1.1400000000000001 (JavaScript's numbers have about 16 significant
// digits, of which this keeps 15)
const add = (a, b) => Number((a + b).toPrecision(15))

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
// datapoint.
const NOGOAL = { slug: '', kyoom: true, safesum: '', queued: false }
const goal = () => goals.find(g => g.slug === slug) ?? NOGOAL

// Make the page show the current state of things
function render() {
  const g = goal(), t = load()
  $('count').textContent = t.count
  $('count').style.setProperty('--len', String(t.count).length)
  $('num').textContent = value(g, t)
  $('safesum').textContent = g.safesum
  $('safesum').setAttribute('aria-busy', g.queued) // grayed out: out of date
  $('subbut').disabled = busy || t.count === 0 || g === NOGOAL
  $('clearbut').disabled = busy
  $('undobut').disabled = busy || t.prev === null
  // Picking a goal loads another page, which wouldn't hear Beeminder's reply.
  // And with no goals, like when logged out, there's nothing to pick.
  $('goals').disabled = busy || goals.length === 0
  $('infinibee').hidden = !busy
  // Login button's label when not logged in (when logged
  // in it shows the username). graph.beeminder.com's login button says "Log in
  // with your Beeminder account".
  $('loginbut').textContent = beeminder.getUsername() ?? 'Log in with your Beeminder account'
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
  change(t => { t.count += d })
  navigator.vibrate?.(25)
}

// Run f in its turn, even across TallyBee windows (tabs, home-screen icons), in
// one of the Web Locks API's two modes: exclusive, for sending a datapoint,
// which runs alone; or shared, for loading the goals, and for Clear and UNDO,
// which can run alongside each other but not alongside a send. So goals we
// fetch are never older than datapoints we've sent, no window submits, clears,
// or undoes a datapoint that another is sending, and Clear and UNDO don't wait
// for goals to load (unless a send is waiting for them too).
// An error doesn't stall things; it gets thrown again outside, to show up in
// the status line like any other. (The browser lets go of the lock if a window
// closes.)
function enqueue(mode, f) {
  navigator.locks.request('tallybee', { mode }, f)
                 .catch(e => queueMicrotask(() => { throw e }))
}

// If Beeminder is updating this page's goal (see NOGOAL), load the goals again
// in 2 seconds, and so on till it's done, with at most one such load waiting
// at a time
let polltimer
function poll() {
  clearTimeout(polltimer)
  if (goal().queued) polltimer = setTimeout(refresh, 2000)
}

// Get the user's goals from Beeminder and put them in the dropdown, selecting
// this page's goal, or, the first time, the most urgent one, and put it in the
// URL (see goalurl). Then poll.
async function loadGoals() {
  const gs = await beeminder.getGoals()
  gs.forEach(({ slug, kyoom, safesum, queued }) => beeminder.assert(
    typeof slug === 'string' && typeof kyoom === 'boolean' &&
    typeof safesum === 'string' && typeof queued === 'boolean',
    JSON.stringify({ slug, kyoom, safesum, queued })))
  slug ??= gs[0]?.slug ?? null
  // The base for an odometer-like goal is the datapoint added to it last (see
  // livebase), which isn't always the one Beeminder calls last_datapoint
  const g = gs.find(g => g.slug === slug) ?? NOGOAL
  if (!g.kyoom) g.last_datapoint = await beeminder.getLastAdded(g.slug) ?? null
  // Everything's here now, so show it all at once
  goals = gs
  $('goals').replaceChildren(...goals.map(g => new Option(g.slug)))
  $('goals').value = slug
  history.replaceState(null, '', goalurl(slug))
  update(t => { t.slug = slug })
  poll()
}

// Send the count, as it was when Submit got pressed, to Beeminder as a
// datapoint on this page's goal. Submit stays grayed out till Beeminder replies,
// but taps keep counting meanwhile, for next time.
function submit() {
  const { count: n, requestid } = load()
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
      const dp = await beeminder.addDatapoint(g.slug, add(n, t.pin.base),
        `via TallyBee at ${new Date()}`, t.requestid).catch(e => {
          // Beeminder turned this send away for want of a login it accepts, so
          // the datapoint didn't get there this time, and gets no pin from it
          if (e.message === beeminder.REAUTH) update(t => { t.pin = pin })
          throw e
        })
      g.last_datapoint = dp
      g.queued = true // as Beeminder has it now, till the goals load again
      update(t => {
        beeminder.assert(t.requestid === requestid, OTHERWIN)
        t.count -= n
        fresh(t)
        t.prev = null
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
$('bigbut').addEventListener('pointerup', e => { if (e.isPrimary) bump(1) })
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
// Clearing the count also starts a new pending datapoint, so the next Submit
// can't overwrite one that Beeminder got without our hearing back. It waits
// its turn (see enqueue), like for another window to finish submitting, and so
// does UNDO, which can bring back the datapoint that a Clear replaced.
$('clearbut').addEventListener('click',
  () => enqueue('shared', () => change(t => { t.count = 0; fresh(t) })))
$('undobut').addEventListener('click', () => enqueue('shared', () => update(t => {
  beeminder.assert(t.prev !== null, JSON.stringify({ prev: t.prev }))
  Object.assign(t, t.prev)
  t.prev = null
})))
$('subbut').addEventListener('click', submit)
$('goals').addEventListener('change',
                            () => location.replace(goalurl($('goals').value)))
// The login button sends you to Beeminder, which sends you right back (with an
// access token) if you've authorized TallyBee before. When you're logged in, it
// shows your username, and pressing it logs you in again, like as someone else.
$('loginbut').addEventListener('click',
                               () => beeminder.login(clientId, redirectUri))
$('infobut').addEventListener('click', () => $('info').showModal())
// Tapping outside the help closes it: taps on the backdrop go to the dialog
// element but taps on what's inside it stop there
$('info').addEventListener('click', () => $('info').close())
$('info').querySelector('.modal-content')
         .addEventListener('click', e => e.stopPropagation())
// Safari on iPhones shows a button as pressed (see :active in style.css) only
// while something is listening for touches, so this listens, and does nothing
document.body.addEventListener('touchstart', () => {}, { passive: true })
// Show what other TallyBee tabs and icons change, like their taps. When one
// logs in or out, or gets a datapoint to Beeminder (which starts a new pending
// datapoint, and can change an odometer goal's value), load the goals again
// too. (Not on every change: loading the goals changes what's remembered, which
// would set off the other windows, and so on forever.)
window.addEventListener('storage', e => {
  render()
  if (e.key !== 'tallybee' ||
      JSON.parse(e.oldValue)?.requestid !== JSON.parse(e.newValue)?.requestid)
    refresh()
})
// Load the goals, when logged in: when the page loads, and again when you come
// back to TallyBee, to refresh things like their safesums
function refresh() {
  if (beeminder.getUsername()) enqueue('shared', loadGoals)
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh()
})

// Let TallyBee open with no connection (see sw.js), where browsers can
navigator.serviceWorker?.register('sw.js')

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
