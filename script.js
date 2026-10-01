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
// prev: what the last tap, −1, typed number or Clear changed, as it was before,
//   for UNDO to put back: {count}, or, for a Clear, which also starts a new
//   pending datapoint, {count, requestid, pin, comment}, or, for an edit of the
//   comment, {comment}. (Only what it changed, since a Submit can change the
//   pin after a tap.) Null at first, after an UNDO (which undoes only the last
//   thing), and once a Submit gets to Beeminder (which can't be undone, and
//   which takes UNDO away from taps made while it was sending, too).
// slug: the goal selected last, for when TallyBee's URL doesn't name one
// folded: whether the footer is folded, all but the bar (see #drawer in
//   index.html). Only the fold button changes it.
// (What TallyBee remembered before there was a prev gets a prev of null.)
// (And what it remembered before there were comments, or folding, gets no
// comment, unfolded.)
function load() {
  return valid({ prev: null, comment: '', folded: false,
                 ...JSON.parse(localStorage.getItem('tallybee')) ??
                 { count: 0, requestid: crypto.randomUUID(), pin: null, slug: null } })
}

// Throw unless t is something TallyBee can remember (see load); else return t
function valid(t) {
  const datapoint = p => Number.isFinite(p.count) &&
                         typeof p.requestid === 'string' &&
                         (p.pin === null || typeof p.pin?.slug === 'string' &&
                                            Number.isFinite(p.pin.base)) &&
                         typeof p.comment === 'string'
  beeminder.assert(datapoint(t) &&
                   (t.prev === null || datapoint({ ...t, ...t.prev })) &&
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

// Start a new pending datapoint (see requestid and pin), with no comment
function fresh(t) {
  t.requestid = crypto.randomUUID()
  t.pin = null
  t.comment = ''
}

// Change the pending datapoint with function f, like update does, first
// remembering, for UNDO, how the fields named in keys, the ones f changes, were
// (see prev)
function change(keys, f) {
  update(t => {
    t.prev = Object.fromEntries(keys.map(k => [k, t[k]]))
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
  $('num').defaultValue = value(g, t) // shown when nothing's being typed there
  $('safesum').textContent = g.safesum
  $('safesum').setAttribute('aria-busy', g.queued) // grayed out: out of date
  $('subbut').disabled = busy || t.count === 0 || g === NOGOAL
  $('clearbut').disabled = $('comment').disabled = busy
  // (Setting it to what it says already, as after each keystroke, leaves the
  // cursor where it is)
  $('comment').value = t.comment
  $('undobut').disabled = busy || t.prev === null
  // Folded, the gist, in the send row's own words, takes the send row's place
  $('drawer').hidden = $('sendrow').hidden = t.folded
  $('gist').hidden = !t.folded
  $('gist').textContent = [$('sendword').textContent, value(g, t),
                           $('toword').textContent, g.slug].join(' ')
  $('foldbut').setAttribute('aria-expanded', !t.folded)
  // Picking a goal loads another page, which wouldn't hear Beeminder's reply.
  // And with no goals, like when logged out, there's nothing to pick, or to
  // type a number to send to.
  $('goals').disabled = $('num').disabled = busy || goals.length === 0
  $('infinibee').hidden = !busy
  // Login button's label when not logged in (when logged
  // in it shows the username). graph.beeminder.com's login button says "Log in
  // with your Beeminder account".
  $('loginbut').textContent = beeminder.getUsername() ?? 'Log in with your Beeminder account'
  // Logged in, it only says who's logged in: pressing it would log in again,
  // which gets a new token, and so logs TallyBee out on your other devices
  // (Beeminder keeps one token per app)
  $('loginbut').disabled = Boolean(beeminder.getUsername())
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
  $('manifest').href = manifest()
  update(t => { t.slug = slug })
  poll()
}

// Send the count, as it was when Submit got pressed, to Beeminder as a
// datapoint on this page's goal. Submit stays grayed out till Beeminder replies,
// but taps keep counting meanwhile, for next time.
// The comment that goes with it, too, is the one from when Submit got pressed:
// the user's, as typed, and then which app sent it, and when. (A space goes
// between the two, so there's none with no comment.)
function submit() {
  const { count: n, requestid, comment } = load()
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
        `${comment}${comment === '' ? '' : ' '}via TallyBee at ${new Date()}`,
        t.requestid).catch(e => {
          // Beeminder turned this send away for want of a login it accepts, so
          // the datapoint didn't get there this time, and gets no pin from it
          if (e.message === beeminder.REAUTH) update(t => { t.pin = pin })
          throw e
        })
      g.last_datapoint = dp
      g.queued = true // as Beeminder has it now, till the goals load again
      update(t => {
        beeminder.assert(t.requestid === requestid, OTHERWIN)
        t.count = add(t.count, -n)
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
// With a mouse, only its main button counts, not the right or middle one
// (button 0, the one that a finger's touch counts as too).
$('bigbut').addEventListener('pointerup', e => {
  if (e.isPrimary && e.button === 0) bump(1)
})
// A tap while a typed number waits for Enter takes the number first, and then
// counts (see #num)
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
// A number typed where it says "Send N to", once Enter is pressed (or the field
// is left), becomes the number to send: the count becomes that number, less
// the base on an odometer-like goal (see livebase). It has to be written the
// way JavaScript writes numbers, like 12 or -3 or 1.5 (so not "", "1e3", "05"
// or ".5"). Either way, the field then shows the number to send again: the
// form's reset puts back the field's default value, which render keeps up to
// date, and which the field shows whenever nothing's being typed in it.
$('num').addEventListener('change', () => {
  const s = $('num').value
  try {
    beeminder.assert(String(Number(s)) === s, JSON.stringify(s))
    change(['count'], t => { t.count = add(Number(s), -pinned(goal(), t).base) })
  } finally { $('numform').reset() }
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
  () => change(['count', 'requestid', 'pin', 'comment'], t => { t.count = 0; fresh(t) })))
$('undobut').addEventListener('click', () => enqueue('shared', () => update(t => {
  beeminder.assert(t.prev !== null, JSON.stringify({ prev: t.prev }))
  Object.assign(t, t.prev)
  t.prev = null
})))
// Every keystroke in the comment gets remembered at once. One edit of it, from
// when its field gets the focus till it loses it, is one change, for UNDO,
// which puts back the comment as it was before the edit (see prev).
let before // the comment as it was when its field got the focus, while it has it
$('comment').addEventListener('focus', () => { before = load().comment })
$('comment').addEventListener('blur', () => { before = undefined })
$('comment').addEventListener('input', () => update(t => {
  beeminder.assert(typeof before === 'string', JSON.stringify({ before: typeof before }))
  t.prev = { comment: before }
  t.comment = $('comment').value
}))
// Enter, the phone keyboard's done key, ends the edit and puts the keyboard
// away, so that putting it away takes no tap on the big button, which would
// count. (Not the Enter that settles a word typed with an IME, like in
// Japanese.)
$('comment').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) $('comment').blur()
})
// The fold button folds away the drawer and the send row, or brings them back
$('foldbut').addEventListener('click', () => update(t => { t.folded = !t.folded }))
$('subbut').addEventListener('click', submit)
$('goals').addEventListener('change',
                            () => location.replace(goalurl($('goals').value)))
// The login button sends you to Beeminder, which sends you right back (with an
// access token) if you've authorized TallyBee before. When you're logged in, it
// shows your username instead, and can't be pressed (see render).
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
