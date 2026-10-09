/*******************************************************************************
 * Quals (what most people call tests; see blog.beeminder.com/quals) for
 * TallyBee. Run them with `npm install` (once) and then `npm test`. They drive
 * the installed Google Chrome, headless, via playwright-core.
 *
 * Each qual loads the app at its real URL (tallybee.beeminder.com) in a fresh
 * browser profile on a phone-sized touchscreen (or, for quals that say so, a
 * computer's screen, mouse, and keyboard: see DESK), with requests to TallyBee
 * served from this directory and requests to Beeminder answered by the fake
 * Beeminder below. A qual fails if the page makes any other request or throws
 * an uncaught error that the qual didn't ask for with expectError.
 ******************************************************************************/

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { chromium } from 'playwright-core'
import { REAUTH, UNASKED } from './beeminder.js'

const APP  = 'https://tallybee.beeminder.com/'
const API  = 'https://www.beeminder.com/api/v1/'
const AUTH = 'https://www.beeminder.com/apps/authorize'
const TOKEN = 'tok123' // the one access token the fake Beeminder accepts
const PHONE = { width: 390, height: 844 }
const NOTALICE = /^(?!alice$)/ // matches any text but "alice"

// How long, in milliseconds, a qual waits for what it's waiting for, like
// text to show or a button to tap, before it fails: long enough for a
// computer slowed down by other work
const WAIT = 10000

// Alice's goals as the fake Beeminder returns them, trimmed to the fields that
// matter here. "pages" is an odometer-style (non-cumulative) goal whose curval
// differs from its last datapoint, like after an odometer reset. "newodo" is a
// non-cumulative goal with no datapoints yet. None is queued (being updated by
// Beeminder, as after it gets a datapoint). A goal's deadline is when its day
// ends, in seconds after midnight (or, negative, before it): midnight for all
// of these. A datapoint's daystamp is the day it's for, like 20260930.
const GOALS = [
  { slug: 'pushups', kyoom: true,  curval: 50,  deadline: 0,
    last_datapoint: { value: 3, daystamp: '20260930', comment: 'set 1' },
    safesum: '+2 pushups due by 12am', queued: false },
  { slug: 'pages',   kyoom: false, curval: 320, deadline: 0,
    last_datapoint: { value: 120, daystamp: '20260929', comment: '' },
    safesum: 'safe for 3 days', queued: false },
  { slug: 'newodo',  kyoom: false, curval: 7,   deadline: 0, last_datapoint: null,
    safesum: 'safe for 1 day', queued: false },
]

// Alice as the fake Beeminder returns her, trimmed to the fields that matter
// here: her timezone, Beeminder's setting, which decides, with each goal's
// deadline, what day it is for her goals
const ALICE = { username: 'alice', timezone: 'America/New_York' }

// A datapoint as the fake Beeminder returns it, of value value, for the day
// before the days the quals about days are on (see NOON), with no comment, and
// whatever else is in more
const datapoint = (value, more) => ({ value, daystamp: '20261001', comment: '', ...more })

// How many calls to Beeminder each load of the goals makes: the goals, the
// user, and the datapoint added last to the selected goal
const LOAD = 3

// A desktop computer, with a mouse and a keyboard and no touchscreen, for
// quals that pass it as the options for the browser context
const DESK = { viewport: { width: 1280, height: 800 }, hasTouch: false,
               isMobile: false }

let browser
before(async () => { browser = await chromium.launch({ channel: 'chrome' }) })
after(() => browser.close())

// The fake Beeminder's state as each qual starts (see qual)
const newbee = () => ({ goals: structuredClone(GOALS), user: structuredClone(ALICE),
                        added: {}, tokens: [TOKEN],
                        calls: [], authorizes: [], strays: [], errors: [],
                        reply: () => null })

// Define a qual. The function f gets a fresh page and the fake Beeminder's
// state, bee, which records every API call in bee.calls and every authorize
// redirect in bee.authorizes, and accepts the access tokens in bee.tokens.
// Setting bee.reply to a function lets a qual override the fake's reply to an
// API call: return [status, body], or 'abort' for a network failure, or a
// promise of either, or null for the default. Options for the browser context,
// like viewport, go in opts.
function qual(name, f, opts = {}) {
  test(name, async () => {
    // (Service workers are blocked here, since what one fetches for the page
    // might go around the routes; the offline quals test them on their own.)
    const context = await browser.newContext({ viewport: PHONE, hasTouch: true,
                                               isMobile: true,
                                               serviceWorkers: 'block', ...opts })
    const bee = newbee()
    // Every page, including second windows, reports its uncaught errors
    context.on('page', p => {
      p.setDefaultTimeout(WAIT)
      p.on('pageerror', e => bee.errors.push(e.message))
    })
    // Record calls to navigator.vibrate, replacing headless Chrome's, which
    // does nothing a qual can see
    await context.addInitScript(() => {
      window.buzzes = []
      navigator.vibrate = ms => window.buzzes.push(ms)
    })
    // Routes registered later take precedence
    await context.route('**', r => { bee.strays.push(r.request().url())
                                     return r.abort() })
    await context.route(APP + '**', r => serve(r))
    await context.route(AUTH + '**', r => { bee.authorizes.push(r.request().url())
      return r.fulfill({ contentType: 'text/html', body: 'Fake authorize' }) })
    await context.route(API + '**', r => fakeBeeminder(bee, r))
    const page = await context.newPage()
    try {
      await f(page, bee)
      assert.deepEqual(bee.strays, [], 'requests to neither TallyBee nor Beeminder')
      assert.deepEqual(bee.errors, [], 'uncaught errors in the page')
    } finally { await context.close() }
  })
}

// Serve the file from this directory that the request is for, like GitHub
// Pages does, including a 404 for no such file
function serve(route) {
  const path = fileURLToPath(new URL('.' + new URL(route.request().url())
    .pathname.replace(/\/$/, '/index.html'), import.meta.url))
  return existsSync(path) ? route.fulfill({ path })
                          : route.fulfill({ status: 404, body: 'Not found' })
}

async function fakeBeeminder(bee, route) {
  const req = route.request()
  const url = new URL(req.url())
  // (TallyBee sends only GETs, and POSTs with form-encoded bodies, which need no
  // CORS preflight: see beeminder.js)
  const params = Object.fromEntries([...url.searchParams,
                                     ...new URLSearchParams(req.postData() ?? '')])
  // Like the real Beeminder, expand "me" to the user the token belongs to
  const path = url.pathname.slice(8).replace(/^users\/me\b/, 'users/alice')
  const call = { method: req.method(), path, params }
  bee.calls.push(call)
  const reply = await bee.reply(call) ?? defaultReply(bee, call)
  if (reply === 'abort') return route.abort('internetdisconnected')
  const [status, data] = reply
  return route.fulfill({ status, headers: { 'access-control-allow-origin': '*' },
                         contentType: 'application/json', body: JSON.stringify(data) })
}

function defaultReply(bee, { method, path, params }) {
  const dp = path.match(/^users\/alice\/goals\/([^/]+)\/datapoints\.json$/)
  if (!bee.tokens.includes(params.access_token)) return [401, { errors: {
    access_token: 'bad_token', message: 'No such access token found.' } }]
  if (method === 'GET' && path === 'users/alice/goals.json')
    return [200, bee.goals]
  if (method === 'GET' && path === 'users/alice.json')
    return [200, bee.user]
  // A goal's datapoints, the one added last first. The fake knows only that
  // one: bee.added's, if set (as after a POST, or after an older one got
  // edited, which makes that the goal's last_datapoint), else the goal's
  // last_datapoint.
  if (method === 'GET' && dp) return [200, [bee.added[dp[1]] ??
    bee.goals.find(g => g.slug === dp[1]).last_datapoint].filter(Boolean)]
  if (method === 'POST' && dp) return [200, bee.added[dp[1]] = {
    id: `dp${bee.calls.length}`, value: Number(params.value),
    daystamp: params.daystamp, comment: params.comment, requestid: params.requestid }]
  return [404, { errors: { message: `Fake Beeminder has no ${method} ${path}` } }]
}

// ------------------------------------------------------------------ helpers

// Press the login button, the way a person does, on TallyBee (loading it first
// if need be), and wait at the fake Beeminder's authorize page. Returns the
// state that TallyBee sent there, for Beeminder to send back.
async function authorize(page) {
  if (!page.url().startsWith(APP)) await page.goto(APP)
  await tap(page, '#loginbut')
  await page.waitForURL(AUTH + '**')
  return new URL(page.url()).searchParams.get('state')
}

// Log in: authorize, then come back from the fake Beeminder with an access
// token, and wait till the goals have loaded
async function login(page, username = 'alice', token = TOKEN) {
  const state = await authorize(page)
  await page.goto(`${APP}?` +
    new URLSearchParams({ access_token: token, username, state }))
  await see(page, '#goals', /pushups/)
}

// The URL Beeminder sends you back to when you say no to TallyBee
const denied = state => `${APP}?` + new URLSearchParams({ error: 'access_denied',
  error_description: 'The user denied you access', state })

// Pick goal slug in the dropdown, which loads that goal's URL, and wait for the
// goals to load there
async function choose(page, slug) {
  await page.selectOption('#goals', slug)
  await page.waitForURL(`${APP}?goal=${slug}`)
  await see(page, '#goals', /pushups/)
  assert.equal(await page.inputValue('#goals'), slug)
}

// Wait up to WAIT ms for f() to be true, trying it every 100ms, and return
// whether it is
async function till(page, f) {
  for (const end = Date.now() + WAIT; Date.now() < end; await page.waitForTimeout(100))
    if (await f()) return true
  return f()
}

// Wait up to WAIT ms for the text of the element matching selector sel (or,
// for a text field, what's in it) to match want (a string for exact match or
// else a regex)
async function see(page, sel, want) {
  const ok = s => typeof want === 'string' ? s === want : want.test(s)
  let s
  assert.ok(await till(page, async () => ok(s = await page.locator(sel).first()
    .evaluate(e => e.tagName === 'INPUT' ? e.value : e.textContent))),
            `${sel} says ${JSON.stringify(s)} instead of ${want}`)
}

// Wait up to WAIT ms for an uncaught error matching regex re, and forgive it
async function expectError(page, bee, re) {
  await till(page, () => bee.errors.some(e => re.test(e)))
  const i = bee.errors.findIndex(e => re.test(e))
  assert.ok(i >= 0, `no uncaught error matching ${re}: ${bee.errors}`)
  bee.errors.splice(i, 1)
}

// Wait up to WAIT ms for the fake Beeminder to have received n calls
async function calls(page, bee, n) {
  await till(page, () => bee.calls.length >= n)
  assert.equal(bee.calls.length, n, JSON.stringify(bee.calls))
}

// Wait for TallyBee to be done with all it has queued (see enqueue in
// script.js), by queuing a turn of its own behind it: the kind of turn that
// waits for every turn queued before it. After WAIT milliseconds this throws,
// so that a turn that never ends fails the qual rather than hanging it.
const settled = page => page.evaluate(wait => navigator.locks.request('tallybee',
  { mode: 'exclusive', signal: AbortSignal.timeout(wait) }, () => {}), WAIT)

// Wait till ms milliseconds have gone by on the page's document timeline, the
// clock that its animations go by
async function lapse(page, ms) {
  const now = () => page.evaluate(() => document.timeline.currentTime)
  const t = await now()
  assert.ok(await till(page, async () => await now() >= t + ms), `${ms}ms from ${t}`)
}

// Wait for the page to draw two frames, by which time it has sent the events
// for any transition (what changes gradually) that it started before
const frames = page => page.evaluate(() =>
  new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

// Wait for the animations of the element matching sel, like a fade of its
// color, to finish. After WAIT milliseconds this throws, so that an animation
// that never ends fails the qual rather than hanging it.
const still = (page, sel) => page.$eval(sel, (e, wait) => Promise.race([
  Promise.all(e.getAnimations().map(a => a.finished)),
  new Promise((_, no) => AbortSignal.timeout(wait).addEventListener('abort',
    () => no(new Error(`still animating after ${wait}ms`))))]), WAIT)

// A promise that the fake Beeminder can wait on, plus the function that ends
// the wait
function gate() {
  let open
  const shut = new Promise(r => { open = r })
  return [shut, open]
}

// Tap the element matching sel n times, or, with no touchscreen (see DESK),
// click it
async function tap(page, sel, n = 1) {
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0)
  for (let i = 0; i < n; i++) await (touch ? page.tap(sel) : page.click(sel))
}

// FINAL DESIGN: Clear is in the menu (the help, opened with the menu button).
// Press it the way a person does: open the menu, and tap Clear, which closes
// the menu.
async function clear(page) {
  await page.bringToFront()
  await tap(page, '#infobut')
  await tap(page, '#clearbut')
  assert.ok(await till(page, async () => !await page.$eval('#info', d => d.open)),
            'Clear closes the menu')
}

// Tap the big button n times, all at once, which is faster than tap for big n
const taps = (page, n) => page.evaluate(n => {
  const b = document.getElementById('bigbut')
  for (let i = 0; i < n; i++)
    b.dispatchEvent(new PointerEvent('pointerup', { isPrimary: true, bubbles: true }))
}, n)

const count = async page => Number(await page.textContent('#bigbut'))
// What TallyBee remembers (see load in script.js)
const tallied = async page =>
  JSON.parse(await page.evaluate(() => localStorage.getItem('tallybee')))
const stored = page => page.evaluate(() => localStorage.getItem('beeminder-token'))
const disabled = (page, sel) => page.locator(sel).isDisabled()
const posts = bee => bee.calls.filter(c => c.method === 'POST')
const values = bee => posts(bee).map(p => String(p.params.value))
const comeback = page =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

// Raw touch events via the Chrome DevTools Protocol, for touching with several
// fingers at once, which page.tap can't do
async function touch(page, points, holdMs) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart',
    touchPoints: points.map(([x, y], id) => ({ x, y, id })) })
  await page.waitForTimeout(holdMs)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

// A second window (tab, or home-screen icon sharing the same storage), open
// at url
async function window2(page, url) {
  const w = await page.context().newPage()
  await w.goto(url)
  return w
}

// Status code of fetching url from the page (so it goes through the routes)
const status = (page, url) =>
  page.evaluate(async u => (await fetch(u)).status, url)

// The app manifest Chrome finds on the page: json, what it says, and parsed,
// how Chrome reads it, with its URLs resolved and its fields' names in
// camelCase, like startUrl (though Chrome leaves some out, like short_name)
async function appManifest(page) {
  const cdp = await page.context().newCDPSession(page)
  const { errors, data, manifest } = await cdp.send('Page.getAppManifest')
  assert.deepEqual(errors, [])
  return { json: JSON.parse(data), parsed: manifest }
}

// Serve this directory at http://localhost, which browsers trust like https,
// passing each file's content through edit, with the headers in headers too,
// and call f with its URL, then stop serving. (Unlike the routes that the
// other quals use, this lets a service worker work, and Chrome let a page be
// installed as an app.)
async function localhost(f, edit = (path, body) => body, headers = {}) {
  const types = { '.html': 'text/html', '.js': 'text/javascript',
                  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }
  const server = createServer((req, res) => {
    const path = join(fileURLToPath(new URL('.', import.meta.url)),
                      new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'))
    res.writeHead(existsSync(path) ? 200 : 404,
                  { 'content-type': types[extname(path)] ?? 'text/plain', ...headers })
    res.end(existsSync(path) ? edit(path, readFileSync(path)) : 'Not found')
  })
  // to this computer only, not to others on its network
  await new Promise(r => server.listen(0, 'localhost', r))
  try { await f(`http://localhost:${server.address().port}/`) }
  finally { server.close() }
}

// Where on the screen the element matching sel is
const box = (page, sel) => page.locator(sel).boundingBox()

// What folding the footer hides (the drawer and the send row: see index.html),
// and the controls of the bar, which it never hides
// FINAL DESIGN: Clear is in the menu, and the safesum in the top line, which
// shows folded too
const FOLDAWAY = ['#loginbut', '#lastdp', '#day', '#comment',
                  '#infobut', '#num', '#goals', '#goallink']
const BAR = ['#minusbut', '#undobut', '#subbut', '#foldbut']

// Whether the fold button says the footer is unfolded, as screen readers hear
const unfolded = async page =>
  await page.getAttribute('#foldbut', 'aria-expanded') === 'true'

// Edit the comment the way a person does: tap the field, put text in it in
// place of what was there, and press Enter, the phone keyboard's done key
async function remark(page, text) {
  await tap(page, '#comment')
  await page.fill('#comment', text)
  await page.press('#comment', 'Enter')
}

// Assert that every control in the footer, and its texts, are whole and on the
// screen, with nothing sticking out sideways, and none on top of another. Or
// just the ones matching sels, like those that show with the footer folded.
// FINAL DESIGN: not Clear, which is in the menu; and the top line's goal name
// and safesum
const FOOTER = ['#minusbut', '#undobut', '#loginbut', '#infobut', '#num',
                '#goals', '#goallink', '#subbut', '#safesum', '#lastdp', '#day', '#comment',
                '#foldbut', '.versiontag', '#goalname']
async function fits(page, sels = FOOTER) {
  const { width, height } = page.viewportSize()
  const boxes = await Promise.all(sels.map(s => box(page, s)))
  assert.ok(await page.$eval('.footer', (f, w) => f.scrollWidth <= w, width))
  boxes.forEach((b, i) => assert.ok(b.x >= 0 && b.x + b.width <= width &&
    b.y >= 0 && b.y + b.height <= height, `${sels[i]} off screen: ${JSON.stringify(b)}`))
  await apart(page, sels)
}

// Assert that none of the elements matching sels is on top of another
async function apart(page, sels) {
  const boxes = await Promise.all(sels.map(s => box(page, s)))
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b, j) => assert.ok(
    a.x + a.width <= b.x || b.x + b.width <= a.x ||
    a.y + a.height <= b.y || b.y + b.height <= a.y,
    `${sels[i]} overlaps ${sels[i + 1 + j]}`)))
}

// Of the elements around the element matching sel that cut off whatever
// sticks out of them (like one that scrolls), the first that it sticks out of,
// grown by reach px on every side: that one's id (or tag name), or null if none
const clipper = (page, sel, reach = 0) => page.$eval(sel, (e, reach) => {
  const r = e.getBoundingClientRect()
  for (let a = e.parentElement; a; a = a.parentElement) {
    const s = getComputedStyle(a), b = a.getBoundingClientRect()
    const cuts = s.overflowX !== 'visible' || s.overflowY !== 'visible'
    const inside = r.left - reach >= b.left + parseFloat(s.borderLeftWidth) &&
      r.top - reach >= b.top + parseFloat(s.borderTopWidth) &&
      r.right + reach <= b.right - parseFloat(s.borderRightWidth) &&
      r.bottom + reach <= b.bottom - parseFloat(s.borderBottomWidth)
    if (cuts && !inside) return a.id || a.tagName
  }
  return null
}, reach)

// How opaque the element matching sel looks: its opacity times that of each
// element it's in
const opacity = (page, sel) => page.$eval(sel, e => {
  let o = 1
  for (let n = e; n; n = n.parentElement) o *= getComputedStyle(n).opacity
  return o
})

// WCAG's contrast ratio of two colors as getComputedStyle gives them, like
// "rgb(58, 115, 255)"
function contrast(a, b) {
  const lum = c => c.match(/[\d.]+/g).slice(0, 3).map(v => v / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// ------------------------------------------------------------ logging in

// Replicata: open TallyBee for the first time, logged out, and tap twice.
// Expectata: the count, 2; a login button; Submit and the empty dropdown
// grayed out, as there's no goal to send to; and no trip to Beeminder, to log
// in or for goals.
// Resultata (in a mutant that left Submit usable with no goal): Submit usable,
// with nowhere to send the count.
qual('first visit shows the counter, working, and a login button', async (page, bee) => {
  await page.goto(APP)
  await tap(page, '#bigbut', 2)
  assert.equal(await count(page), 2)
  assert.ok(await page.isVisible('#loginbut'))
  assert.ok(await disabled(page, '#subbut'), 'Submit with no goal to submit to')
  assert.ok(await page.$eval('#goals', e => getComputedStyle(e).opacity < 1),
            'the empty dropdown should look grayed out')
  assert.deepEqual(bee.authorizes, [])
  assert.deepEqual(bee.calls, [])
})

// Replicata: tap 3, press the login button, and log in at Beeminder.
// Expectata: Beeminder's authorize page, asked for an access token for
// TallyBee (its client id), to be sent back to tallybee.beeminder.com, with
// this tab's state (see tabState in beeminder.js); and back at TallyBee, still
// 3.
// Resultata (in a mutant that started each page load at 0): 0, the 3 lost on
// the way to Beeminder and back.
qual('the login button sends you to Beeminder, and back, keeping the count', async (page, bee) => {
  await page.goto(APP)
  await tap(page, '#bigbut', 3)
  await login(page)
  const p = new URL(bee.authorizes[0]).searchParams
  assert.equal(p.get('client_id'), '6qi9cv7g647fisgzlz0flxwee')
  assert.equal(p.get('redirect_uri'), APP)
  assert.equal(p.get('response_type'), 'token')
  assert.ok(p.get('state'))
  assert.equal(await count(page), 3)
})

// Replicata: log in, and reload the page.
// Expectata: logged in as alice, with her access token kept where TallyBee
// keeps things for good (localStorage), and her goals in the dropdown; and
// after reloading, still, with no second trip to Beeminder.
// Resultata (in a mutant that kept the token in sessionStorage, which keeps it
// only till the tab closes): no token kept for good.
qual('the redirect back from Beeminder logs you in, for good', async (page, bee) => {
  await login(page)
  assert.deepEqual(JSON.parse(await stored(page)), { token: TOKEN, user: 'alice' })
  assert.deepEqual(await page.$$eval('#goals option', os => os.map(o => o.value)),
                   ['pushups', 'pages', 'newodo'])
  await see(page, '#loginbut', 'alice')
  // Reloading doesn't need Beeminder again
  await page.reload()
  await see(page, '#goals', /pushups/)
  await see(page, '#loginbut', 'alice')
  assert.equal(bee.authorizes.length, 1)
})

// Replicata: log in, which means Beeminder sends you back to TallyBee with
// your access token in the URL.
// Expectata: the token in neither the address bar nor the URL the page was
// loaded from, which is what an app installed or a home-screen icon made from
// the page would open: TallyBee loads itself again without it.
// Resultata (in a mutant that only took the token out of the address bar): the
// page as loaded from the URL with the token in it.
qual('logging in loads the page again without the access token in the URL', async page => {
  await login(page)
  assert.equal(page.url(), APP + '?goal=pushups')
  assert.equal(await page.evaluate(() =>
    performance.getEntriesByType('navigation')[0].name), APP)
})

// Replicata: press the login button, say no to TallyBee at Beeminder, and tap
// twice.
// Expectata: why, "The user denied you access", in the status line; the count,
// 2; Submit grayed out, with no goal to send to; and no going back to
// Beeminder by itself.
// Resultata (in a mutant that ignored the error Beeminder sent back): an error
// that said nothing of why: {"username":null}.
qual('denying access shows why, leaves the counter working, and does not loop', async (page, bee) => {
  await page.goto(denied(await authorize(page)))
  await see(page, '#status', /The user denied you access/)
  await expectError(page, bee, /The user denied you access/)
  await tap(page, '#bigbut', 2)
  assert.equal(await count(page), 2)
  assert.ok(await disabled(page, '#subbut'), 'Submit with no goal to submit to')
  assert.equal(bee.authorizes.length, 1)
})

// Replicata: TallyBee in two windows, logged out. In one, tap 2 and press the
// login button, and while at Beeminder, log in in the other window. Then say
// no at Beeminder.
// Expectata: the error, plus alice's goals, logged in by the other window.
// Resultata (before): the error, but no goals.
qual('denying access after another window logged in still loads your goals', async (page, bee) => {
  await page.goto(APP)
  await tap(page, '#bigbut', 2)
  const state = await authorize(page)
  await login(await window2(page, APP))
  await page.goto(denied(state))
  await see(page, '#status', /The user denied you access/)
  await expectError(page, bee, /The user denied you access/)
  await see(page, '#goals', /pushups/)
  await see(page, '#loginbut', 'alice')
  assert.equal(await count(page), 2)
  assert.ok(!await disabled(page, '#subbut'))
})

// Replicata: logged in as alice, open a link someone sent you with their own
// access token in it: tallybee.beeminder.com/?access_token=theirs&username=alice
// Expectata: still logged in as alice, and TallyBee says it ignored the link.
// Resultata (before): logged in as them, still showing "alice", so everything
// you submit goes to their Beeminder account.
qual("a link with an access token you didn't ask for is ignored, loudly", async (page, bee) => {
  await login(page)
  await page.goto(`${APP}?access_token=evil&username=alice`)
  await see(page, '#status', `Error: ${UNASKED}`)
  await expectError(page, bee, new RegExp(RegExp.escape(UNASKED)))
  assert.deepEqual(JSON.parse(await stored(page)), { token: TOKEN, user: 'alice' })
  assert.doesNotMatch(page.url(), /access_token|evil/)
})

// Replicata: open a link someone made, to TallyBee with a login error in it
// that TallyBee didn't ask for:
// tallybee.beeminder.com/?error=Beeminder+has+moved&error_description=log+in+elsewhere
// Expectata: TallyBee says that it ignored the link, showing none of the
// link's own words (which could say anything), and takes them out of the URL.
// Resultata (in a mutant that showed a login error before checking that
// TallyBee had asked for it): "Error: Beeminder has moved: log in elsewhere".
qual("a link with a login error you didn't ask for shows none of its text", async (page, bee) => {
  await page.goto(`${APP}?error=Beeminder+has+moved&error_description=log+in+elsewhere`)
  await see(page, '#status', `Error: ${UNASKED}`)
  await expectError(page, bee, new RegExp(RegExp.escape(UNASKED)))
  assert.doesNotMatch(page.url(), /error|moved|elsewhere/)
})

// Replicata: press the login button, and come back from Beeminder with an
// access token but no username.
// Expectata: an error, about the username, and no one logged in.
// Resultata (in a mutant without the check for a username): no error.
qual('a login redirect without a username logs no one in, loudly', async (page, bee) => {
  const state = await authorize(page)
  await page.goto(`${APP}?` + new URLSearchParams({ access_token: TOKEN, state }))
  await see(page, '#status', /Error/)
  await expectError(page, bee, /username/)
  assert.equal(await stored(page), null)
})

// Replicata: log in, then press Back, which goes to Beeminder's authorize page,
// which logs you in again (minting a new access token and killing the old).
// Expectata: logged in with the new token.
// Resultata (before): TallyBee ignored the new token as one it hadn't asked
// for, leaving you with the dead one.
qual("logging in again from Beeminder's page, after pressing Back, works", async (page, bee) => {
  await login(page)
  const state = new URL(bee.authorizes[0]).searchParams.get('state')
  await page.goBack()
  await page.waitForURL(AUTH + '**')
  bee.tokens = ['tok456']
  await page.goto(`${APP}?` +
    new URLSearchParams({ access_token: 'tok456', username: 'alice', state }))
  await see(page, '#goals', /pushups/)
  assert.deepEqual(JSON.parse(await stored(page)), { token: 'tok456', user: 'alice' })
})

// Replicata: press the login button, but don't log in at Beeminder; then open
// a link someone sent you with their own access token in it:
// tallybee.beeminder.com/?access_token=evil&username=alice
// Expectata: TallyBee says that it ignored the link, and no one is logged in.
// Resultata (in a mutant without the check of the state): the link's token
// taken as a login (which the fake Beeminder here then turned away, as it
// knows no such token).
qual("a link with an access token is ignored even after an unfinished login", async (page, bee) => {
  await authorize(page) // and then don't log in
  await page.goto(`${APP}?access_token=evil&username=alice`)
  await see(page, '#status', `Error: ${UNASKED}`)
  await expectError(page, bee, new RegExp(RegExp.escape(UNASKED)))
  assert.equal(await stored(page), null)
})

// Replicata: log in on device A, then log in on device B (which makes Beeminder
// replace A's token), then load TallyBee on device A.
// Expectata: TallyBee says the token is bad and shows the login button again.
// Resultata (before): an alert, but only for this case and not for submitting.
qual('a token Beeminder rejects when loading goals gets forgotten', async (page, bee) => {
  await login(page)
  bee.reply = () => [401, { errors: { message: 'No such access token found.' } }]
  await page.reload()
  await see(page, '#status', `Error: ${REAUTH}`)
  await expectError(page, bee, new RegExp(RegExp.escape(REAUTH)))
  await see(page, '#loginbut', NOTALICE)
  assert.equal(await stored(page), null)
})

// Replicata: log in, and then log in on another device too, which makes
// Beeminder reject this one's access token; here, tap 3 and Submit; then log
// in again here, and Submit.
// Expectata: an error saying to log in again, the login button back, and the 3
// kept; then, logged in again, the 3 submitted.
// Resultata (in a mutant that kept a token Beeminder had rejected): the login
// button still saying "alice", as if nothing were wrong.
qual('a token Beeminder rejects when submitting gets forgotten, keeping the count', async (page, bee) => {
  await login(page)
  await tap(page, '#bigbut', 3)
  bee.reply = () => [401, { errors: { message: 'No such access token found.' } }]
  await tap(page, '#subbut')
  await see(page, '#status', `Error: ${REAUTH}`)
  await expectError(page, bee, new RegExp(RegExp.escape(REAUTH)))
  await see(page, '#loginbut', NOTALICE)
  assert.equal(await stored(page), null)
  assert.equal(await count(page), 3)
  // Logging in again gets the count submitted after all
  bee.reply = () => null
  await login(page)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.equal(values(bee).at(-1), '3')
})

// Replicata: TallyBee in two windows. One is loading the goals with the access
// token we had, when you log in on another device, which cancels that token:
// the other window's next goals load gets a 401, and you log in there again.
// Then the first window's load gets its 401 too.
// Expectata: still logged in, with the new token.
// Resultata (in a mutant that forgot whatever token it had at a 401): logged
// out, the new token gone with the old.
qual("a 401 for an old token doesn't log out a newer login", async (page, bee) => {
  await login(page)
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  const [shut, open] = gate()
  let held = false // the first goals load from here on waits for open()
  bee.reply = c => c.method === 'GET' && !held ? (held = true, shut.then(() => null))
                                               : null
  const n = bee.calls.length
  await comeback(w)
  await calls(page, bee, n + 2) // the goals (held) and the user
  bee.tokens = ['tok456']
  await comeback(page)
  await see(page, '#status', `Error: ${REAUTH}`)
  await expectError(page, bee, new RegExp(RegExp.escape(REAUTH)))
  await login(page, 'alice', 'tok456')
  open()
  await expectError(page, bee, new RegExp(RegExp.escape(REAUTH)))
  await see(page, '#goals', /pushups/)
  assert.deepEqual(JSON.parse(await stored(page)), { token: 'tok456', user: 'alice' })
})

// Replicata: log in, then click your username.
// Expectata: nothing, since the username only says who's logged in, and it
// doesn't look like something to press. (Logged out, the login button does.)
// Resultata (before): a trip through Beeminder's login, which got a new token
// and so logged TallyBee out on your other devices (Beeminder keeps one token
// per app).
qual('the username only says who is logged in: pressing it does nothing', async (page, bee) => {
  await page.goto(APP)
  const cursor = sel => page.$eval(sel, e => getComputedStyle(e).cursor)
  assert.equal(await cursor('#loginbut'), 'pointer', 'the login button, logged out')
  await login(page)
  await see(page, '#loginbut', 'alice')
  assert.equal(await cursor('#loginbut'), 'default')
  assert.equal(await page.$eval('#loginbut', e => getComputedStyle(e).backgroundColor),
               'rgba(0, 0, 0, 0)')
  await page.locator('#loginbut').click({ force: true })
  await tap(page, '#bigbut') // still here, on TallyBee
  await see(page, '#bigbut', '1')
  assert.equal(page.url(), APP + '?goal=pushups')
  assert.equal(bee.authorizes.length, 1)
}, DESK)

// Replicata: open TallyBee, logged out, in two windows side by side, and log
// in in one of them.
// Expectata: the other gets the goals, and the username, too, without having
// to be left and come back to.
// Resultata (in a mutant that loaded the goals again only when another window
// changed the pending datapoint): no goals in the other window.
qual('a window that stays in view gets the goals when another window logs in', async page => {
  await page.goto(APP)
  const w = await window2(page, APP)
  await login(w)
  await page.bringToFront()
  await see(page, '#goals', /pushups/)
  await see(page, '#loginbut', 'alice')
})

// Replicata: open TallyBee, logged out, and switch to another tab and back.
// Expectata: no call to Beeminder, and no error: with no login, there are no
// goals to load.
// Resultata (in a mutant that loaded the goals, logged in or not): an error.
qual('switching tabs while logged out calls no Beeminder', async (page, bee) => {
  await page.goto(APP)
  await comeback(page)
  await settled(page)
  assert.deepEqual(bee.calls, [])
  assert.notEqual(await page.getAttribute('#status', 'data-kind'), 'err')
})

// --------------------------------------------------------------- counting

// Replicata: tap the big button 3 times.
// Expectata: 3.
// Resultata (in a mutant that counted the click that follows each tap, as well
// as the tap): 6.
qual('each tap adds one', async page => {
  await login(page)
  assert.equal(await count(page), 0)
  await tap(page, '#bigbut', 3)
  assert.equal(await count(page), 3)
})

// Replicata: put the phone on the floor and hold your nose on the screen for a
// second at the bottom of a pushup.
// Expectata: that counts as a pushup, like in Beedroid.
// Resultata (in a mutant that counted clicks, as the TallyBee of 2023 did): 0,
// as a long press makes no click.
qual('a long press counts (noses are slow)', async page => {
  await login(page)
  // A long press on a phone makes no click, just a context menu. Headless Chrome
  // on Linux knows no long presses: a touch held down for any time still makes
  // a click there, and never a context menu. So here no click gets through to
  // the page, as on a phone.
  await page.evaluate(() =>
    addEventListener('click', e => e.stopImmediatePropagation(), true))
  await touch(page, [[200, 300]], 1200)
  assert.equal(await count(page), 1)
})

// Replicata: on a computer, click the big button; then right-click it,
// middle-click it, and click it again.
// Expectata: the clicks count, and the right- and middle-clicks don't: 2.
// Resultata (before): 4, as TallyBee counted a press of any of the mouse's
// buttons when it let go.
qual('a right- or middle-click on the big button counts nothing', async page => {
  await login(page)
  await page.click('#bigbut')
  await see(page, '#bigbut', '1')
  await page.click('#bigbut', { button: 'right' })
  await page.click('#bigbut', { button: 'middle' })
  await page.click('#bigbut')
  await see(page, '#bigbut', '2')
}, DESK)

// Replicata: touch the big button with two fingers (or nose and chin) at once,
// and lift them.
// Expectata: 1.
// Resultata (in a mutant that counted each finger): 2.
qual('touching with two fingers (or nose and chin) at once counts once', async page => {
  await login(page)
  await touch(page, [[150, 300], [250, 350]], 50)
  assert.equal(await count(page), 1)
})

// Replicata: tap twice, on a phone that can buzz.
// Expectata: two buzzes of 25ms each, like Beedroid's.
// Resultata (in a mutant with no buzz): none.
qual('each tap buzzes for 25ms like in Beedroid', async page => {
  await login(page)
  await tap(page, '#bigbut', 2)
  assert.deepEqual(await page.evaluate(() => window.buzzes), [25, 25])
})

// Replicata: on a computer, open TallyBee and, without clicking anything,
// press Space, then Enter.
// Expectata: each counts one, like a tap.
// Resultata (before): nothing; the big button couldn't be reached from the
// keyboard at all (WCAG 2.1.1).
qual('Space and Enter count, right from the start, like taps', async page => {
  await login(page)
  await page.keyboard.press(' ')
  await page.keyboard.press('Enter')
  assert.equal(await count(page), 2)
}, DESK)

// Replicata: hold Space down, then Enter, long enough for the keys to repeat.
// Expectata: each counts one, as a long press does.
// Resultata (counting each keydown): a count for each of the keys' repeats.
qual('holding Space or Enter down counts once', async page => {
  await login(page)
  for (const key of [' ', 'Enter']) {
    await page.keyboard.down(key)
    for (let i = 0; i < 5; i++) await page.keyboard.down(key) // auto-repeats
    await page.keyboard.up(key)
  }
  assert.equal(await count(page), 2)
}, DESK)

// Replicata: press Tab to the first of the footer's controls, then Shift+Tab
// back to the big button.
// Expectata: a ring around the big button, inside the screen, and presses of
// Space still count.
// Resultata (in a draft): the page's ring, drawn 2px outside the big button,
// was off the screen on three sides and under the footer on the fourth.
qual('the big button shows a ring inside the screen when the keyboard focuses it', async page => {
  await login(page)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  const r = await page.$eval('#bigbut', b => { const s = getComputedStyle(b)
    return { fv: b.matches(':focus-visible'), style: s.outlineStyle,
             reach: parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth) } })
  assert.ok(r.fv && r.style === 'solid' && r.reach <= 0, JSON.stringify(r))
  await page.keyboard.press(' ')
  assert.equal(await count(page), 1)
}, DESK)

// Replicata: on a phone, open TallyBee and tap the big button.
// Expectata: no ring, before or after the tap.
// Resultata (with the big button given the focus plainly): a blue ring around
// most of the screen, from the start.
qual('tapping the big button shows no ring', async page => {
  await login(page)
  const ring = () => page.$eval('#bigbut', b => b.matches(':focus-visible'))
  assert.ok(!await ring(), 'on load')
  await tap(page, '#bigbut', 2)
  assert.ok(!await ring(), 'after taps')
  assert.equal(await count(page), 2)
})

// Replicata: focus −1, or the ? and then the help's ×, and press Space or
// Enter.
// Expectata: that control does its thing, and the count doesn't go up.
// Resultata (counting Space and Enter anywhere on the page): it does its thing,
// and the count goes up too.
qual("Space and Enter on the footer's controls and in the help don't count", async page => {
  await login(page)
  await page.focus('#minusbut')
  await page.keyboard.press(' ')
  assert.equal(await count(page), -1)
  await page.focus('#infobut')
  await page.keyboard.press('Enter')
  assert.ok(await page.$eval('#info', d => d.open))
  await page.keyboard.press('Enter') // on the ×
  assert.ok(!await page.$eval('#info', d => d.open))
  assert.equal(await count(page), -1)
}, DESK)

// Replicata: on a phone that can't buzz (with no navigator.vibrate, as on
// iPhones), tap twice.
// Expectata: 2, and no error.
// Resultata (in a mutant that buzzed whether the phone could or not): an error
// at each tap, "navigator.vibrate is not a function".
qual('tapping works on phones that cannot buzz, like iPhones', async page => {
  await login(page)
  await page.evaluate(() => { delete navigator.vibrate
                              delete Navigator.prototype.vibrate })
  await tap(page, '#bigbut', 2)
  assert.equal(await count(page), 2)
})

// Replicata: tap once, then press −1 three times.
// Expectata: -2.
// Resultata (before): there was no −1.
qual('the −1 button subtracts one, even below zero', async page => {
  await login(page)
  await tap(page, '#bigbut')
  await tap(page, '#minusbut', 3)
  assert.equal(await count(page), -2)
})

// Replicata: tap 3 and UNDO; press −1 and UNDO; press Clear and UNDO.
// Expectata: each UNDO undoes what was done just before it: 2, then 2, then 2.
// Resultata (before): UNDO only ever subtracted one, and there was no −1.
qual('UNDO undoes whatever was just done: a tap, −1, or Clear', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await tap(page, '#undobut')
  await see(page, '#bigbut', '2')
  await tap(page, '#minusbut')
  await see(page, '#bigbut', '1')
  await tap(page, '#undobut')
  await see(page, '#bigbut', '2')
  await clear(page) // FINAL DESIGN
  await see(page, '#bigbut', '0')
  await tap(page, '#undobut')
  await see(page, '#bigbut', '2')
})

// Replicata: tap 3 and Submit, which fails with the reply lost (so Beeminder
// may have the datapoint after all). Press Clear by mistake, then UNDO, and
// Submit again.
// Expectata: the resend is the same datapoint as the first try (the same
// requestid), so Beeminder can't end up with two.
// Resultata (before): a Clear couldn't be undone.
qual('UNDO undoes a Clear, datapoint and all', async (page, bee) => {
  await login(page)
  bee.reply = c => c.method === 'POST' ? 'abort' : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  await clear(page) // FINAL DESIGN
  await see(page, '#bigbut', '0')
  await tap(page, '#undobut')
  await see(page, '#bigbut', '3')
  bee.reply = () => null
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  const [a, b] = posts(bee).map(p => p.params.requestid)
  assert.equal(a, b)
})

// Replicata: open TallyBee; tap once and UNDO it; then tap 2 and Submit.
// Expectata: UNDO grayed out whenever there's nothing to undo: at first, once
// it has undone everything there was, and after a Submit (which can't be
// undone, and before which nothing can be).
// Resultata (before): UNDO was never grayed out.
qual('UNDO is grayed out when there is nothing to undo', async page => {
  await login(page)
  assert.ok(await disabled(page, '#undobut'), 'at first')
  await tap(page, '#bigbut')
  assert.ok(!await disabled(page, '#undobut'))
  await tap(page, '#undobut')
  await see(page, '#bigbut', '0')
  assert.ok(await disabled(page, '#undobut'), 'after an UNDO')
  await tap(page, '#bigbut', 2)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.ok(await disabled(page, '#undobut'), 'after a Submit')
})

// Replicata: TallyBee from before there was an UNDO (which remembered no prev)
// left a count of 5. Open this TallyBee.
// Expectata: 5, with UNDO grayed out.
// Resultata (in a mutant that gave what it remembered no prev of null when it
// had none): UNDO usable, with nothing to undo.
qual('a count left by TallyBee from before UNDO still loads', async page => {
  await page.goto(APP)
  await page.evaluate(() => localStorage.setItem('tallybee', JSON.stringify(
    { count: 5, requestid: 'r-old', pin: null, slug: 'pushups' })))
  await page.reload()
  await see(page, '#bigbut', '5')
  assert.ok(await disabled(page, '#undobut'))
})

// Replicata: what TallyBee remembers gets broken, like missing its requestid
// (by a bug, say). Open TallyBee.
// Expectata: an error saying so.
// Resultata (before): no error. The count was there, under a new requestid,
// quietly put in for the missing one.
qual('a broken memory fails loudly, rather than getting quietly filled in', async (page, bee) => {
  await page.goto(APP)
  await page.evaluate(() => localStorage.setItem('tallybee', JSON.stringify({ count: 3 })))
  await page.reload()
  await see(page, '#status', /^Error: .*"count":3/)
  await expectError(page, bee, /"count":3/)
  // and the error from then showing the rest of the page, which can't be done
  // with script.js stopped partway
  await expectError(page, bee, /before initialization/)
})

// Replicata: tap 4 and Clear by mistake; the phone reloads the page before you
// notice. Press UNDO.
// Expectata: the 4 are back.
// Resultata (before): -1, as UNDO only ever subtracted one.
qual('UNDO survives reloading the page', async page => {
  await login(page)
  await tap(page, '#bigbut', 4)
  await clear(page) // FINAL DESIGN
  await see(page, '#bigbut', '0')
  await page.reload()
  await see(page, '#goals', /pushups/)
  await tap(page, '#undobut')
  await see(page, '#bigbut', '4')
})

// Replicata: tap 3, press −1, type the comment "felt strong", and press Clear;
// then press UNDO again and again.
// Expectata: each UNDO takes back one thing more, the last first: the Clear
// (2, "felt strong"), the comment (2, no comment), the −1 (3), and the taps,
// one at a time (2, 1, 0); and then there's nothing to undo.
// Resultata (before): UNDO took back only the last thing, the Clear.
qual('UNDO undoes everything since the last Submit, one thing at a time', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await tap(page, '#minusbut')
  await remark(page, 'felt strong')
  await clear(page) // FINAL DESIGN
  await see(page, '#bigbut', '0')
  for (const [n, comment] of [['2', 'felt strong'], ['2', ''], ['3', ''], ['2', ''],
                              ['1', ''], ['0', '']]) {
    await tap(page, '#undobut')
    await see(page, '#bigbut', n)
    await see(page, '#comment', comment)
  }
  assert.ok(await disabled(page, '#undobut'))
})

// Replicata: tap 3, and press Clear.
// Expectata: 0.
// Resultata (in a mutant whose Clear started a new datapoint but left the
// count): 3.
qual('the clear button zeroes the count', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await clear(page) // FINAL DESIGN
  await see(page, '#bigbut', '0')
})

// Replicata: log in, and look at Clear; tap once, and Clear; then pick pages,
// an odometer goal at 120.
// Expectata: Clear grayed out whenever the tally is 0 already (as the owner
// put it in AGENTS.md, question 9): at first, after the Clear, and on pages at
// 120, as that's the goal's reading, with nothing tallied on top of it; and
// usable after the tap.
// Resultata (before): usable at 0.
qual('Clear is grayed out when the tally is already 0', async page => {
  await login(page)
  assert.ok(await disabled(page, '#clearbut'), 'at first')
  await tap(page, '#bigbut')
  assert.ok(!await disabled(page, '#clearbut'), 'after a tap')
  await clear(page) // FINAL DESIGN
  await see(page, '#bigbut', '0')
  assert.ok(await disabled(page, '#clearbut'), 'after the Clear')
  await choose(page, 'pages')
  await see(page, '#bigbut', '120')
  assert.ok(await disabled(page, '#clearbut'), 'on pages, at 120')
})

// Replicata: reach for −1, UNDO, Submit or the ?, and miss a little.
// Expectata: never Clear, which wipes out the count: it's at least 44px
// (about a fingertip) from each of them, and looks unlike UNDO.
// Resultata (before): Clear was 8px from UNDO, and looked just like it.
for (const [width, height] of [[320, 568], [390, 844], [600, 800], [844, 390]])
  // FINAL DESIGN: renamed from "Clear is far from −1, UNDO, Submit and ?"
  qual(`Clear is in the menu, not the footer, and looks unlike UNDO (${width}x${height})`, async page => {
    await login(page)
    await tap(page, '#bigbut', 3)
    // How far apart two boxes are, at least, edge to edge
    const gap = (a, b) => Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width),
                                   b.y - (a.y + a.height), a.y - (b.y + b.height))
    // FINAL DESIGN: Clear isn't in the footer at all, but in the menu, apart
    // from all the footer's controls
    assert.ok(!await page.isVisible('#clearbut'), 'Clear in the footer')
    await tap(page, '#infobut')
    assert.ok(await page.isVisible('#clearbut'), 'Clear in the menu')
    void gap
    const look = sel => page.$eval(sel, e => {
      const s = getComputedStyle(e)
      return [s.color, s.backgroundColor, s.borderTopColor].join()
    })
    assert.notEqual(await look('#clearbut'), await look('#undobut'))
  }, { viewport: { width, height } })

// Replicata: tap 4, and reload the page, as phones do with pages in the
// background.
// Expectata: 4.
// Resultata (in a mutant that started each page load at 0): 0.
qual('the count survives reloading the page', async page => {
  await login(page)
  await tap(page, '#bigbut', 4)
  await page.reload()
  await see(page, '#bigbut', '4')
})

// Replicata: TallyBee open in two tabs (or a tab and a home-screen icon, which
// on Android share storage). Tap 10 in one, then 1 in the other.
// Expectata: 11, in both, and after reloading.
// Resultata (before): each tab kept its own count and overwrote the other's.
qual('two TallyBee windows share one count', async page => {
  await login(page)
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  await page.bringToFront()
  await tap(page, '#bigbut', 10)
  await w.bringToFront()
  await see(w, '#bigbut', '10')
  await tap(w, '#bigbut')
  await see(w, '#bigbut', '11')
  await page.bringToFront()
  await see(page, '#bigbut', '11')
  await page.reload()
  await see(page, '#bigbut', '11')
})

// Replicata: tap 12345 times.
// Expectata: all five digits on the screen, smaller, as Beedroid shrinks the
// count when it gets past 9999.
// Resultata (in a mutant whose count never shrank): the digits running off the
// screen, out to 483px on a 390px screen.
qual('a big count still fits on the screen', async page => {
  await login(page)
  const vw = page.viewportSize().width
  await taps(page, 12345)
  await see(page, '#bigbut', '12345')
  const r = await page.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('bigbut'))
    return range.getBoundingClientRect().toJSON()
  })
  assert.ok(r.left >= 0 && r.right <= vw, JSON.stringify(r))
})

// Replicata: look at the count from the floor, doing pushups.
// Expectata: digits big enough to see from there: a font size of at least 35%
// of the screen's width.
// Resultata (in a mutant with the count half as big): 78px, 20% of the
// screen's width.
qual('the count is big', async page => {
  await login(page)
  const px = await page.$eval('#bigbut', e => parseFloat(getComputedStyle(
    e.firstElementChild ?? e).fontSize))
  assert.ok(px >= 0.35 * PHONE.width, `font size ${px}px`)
})

// Replicata: look at the count, from the floor, doing pushups.
// Expectata: the blue stands out from the black, with at least the 3:1
// contrast that WCAG asks of big text.
// Resultata (before): pure blue, which has 2.4:1.
qual('the count stands out from the black', async page => {
  await login(page)
  const [fg, bg] = await page.$eval('#bigbut', e =>
    [getComputedStyle(e.firstElementChild).color, getComputedStyle(e).backgroundColor])
  assert.ok(contrast(fg, bg) >= 3, `${fg} on ${bg}: ${contrast(fg, bg).toFixed(2)}:1`)
})

// Replicata: on a phone, pull down on the big button to reload TallyBee, as on
// any web page.
// Expectata: the browser can take the pull, as the big button lets it take
// a touch that moves up or down (touch-action: pan-y), and nothing keeps the
// page from being pulled (no overflow: hidden or overscroll-behavior on the
// page); and a touch the browser takes over, which it cancels, counts
// nothing. (Headless Chrome has no pull-to-refresh, so that's as near as these
// quals get. A nose that slides up or down far enough gets taken over too.)
// Resultata (before): a pull counted one, and reloaded nothing, as the big
// button kept every touch for itself.
qual('pulling down to reload is left to the browser, and counts nothing', async page => {
  await login(page)
  const css = (sel, props) => page.$eval(sel, (e, ps) =>
    ps.map(p => getComputedStyle(e)[p]), props)
  assert.deepEqual(await css('#bigbut', ['touchAction']), ['pan-y'])
  for (const sel of ['html', 'body'])
    assert.deepEqual(await css(sel, ['overflowY', 'overscrollBehaviorY']),
                     ['visible', 'auto'], sel)
  await page.$eval('#bigbut', b => {
    for (const type of ['pointerdown', 'pointercancel'])
      b.dispatchEvent(new PointerEvent(type, { isPrimary: true, bubbles: true }))
  })
  assert.equal(await count(page), 0)
  await tap(page, '#bigbut')
  assert.equal(await count(page), 1)
})

// Replicata: open TallyBee installed as an app, and pull down on the big
// button to reload it.
// Expectata: as in a browser tab (see the qual above), the browser can take
// the pull, and nothing keeps the page from being pulled: Chrome on Android
// offers pull-to-refresh in installed apps too, as it gives one to every tab,
// whatever its display mode (see SwipeRefreshHandler in Chromium). (A desktop
// Chrome app window, opened with --app, stands in for the installed app: it
// shows TallyBee in the display mode of TallyBee's app manifest, standalone.)
// Resultata (in a mutant that kept the installed app from scrolling by
// clipping it, with @media (display-mode: standalone) { html, body { overflow:
// hidden } }): html and body overflow-y hidden, which keeps Chrome from
// pulling to reload.
test('in an installed app too, pulling down to reload is left to the browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tallybee-quals-'))
  // (The app window opens at TallyBee's URL before the routes below can answer
  // for it, so the host resolver rules keep it off the network.)
  const context = await chromium.launchPersistentContext(dir, { channel: 'chrome',
    args: [`--app=${APP}`, '--host-resolver-rules=MAP * ~NOTFOUND'],
    viewport: PHONE, serviceWorkers: 'block' })
  try {
    await context.route('**', r => r.abort())
    await context.route(APP + '**', r => serve(r))
    const page = context.pages()[0]
    await page.goto(APP)
    assert.ok(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches))
    const css = (sel, props) => page.$eval(sel, (e, ps) =>
      ps.map(p => getComputedStyle(e)[p]), props)
    assert.deepEqual(await css('#bigbut', ['touchAction']), ['pan-y'])
    for (const sel of ['html', 'body'])
      assert.deepEqual(await css(sel, ['overflowY', 'overscrollBehaviorY']),
                       ['visible', 'auto'], sel)
  } finally {
    await context.close()
    rmSync(dir, { recursive: true })
  }
})

// ------------------------------------------------------------- submitting

// Replicata: log in, and, without tapping, press Submit.
// Expectata: Submit usable from the start, and a datapoint of 0 sent, as
// Beeminder's own site lets you send.
// Resultata (before): Submit grayed out at 0, a special case that kept a 0
// from ever being sent.
qual('Submit can send a 0', async (page, bee) => {
  await login(page)
  assert.ok(!await disabled(page, '#subbut'))
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(values(bee), ['0'])
})

// Replicata: log in, which selects pushups, a cumulative goal; pick pages, an
// odometer one.
// Expectata: "Submit (∑)" on pushups, like Beeminder's "Add progress (∑)" on
// goals that sum their datapoints, and "Submit" on pages.
// Resultata (before): "Submit" on both.
qual('Submit says (∑) on goals that sum their datapoints, as on Beeminder', async page => {
  await login(page)
  // (What it says, as shown: innerText, unlike textContent, leaves out what's
  // hidden)
  const says = () => page.innerText('#subbut')
  assert.equal(await says(), 'Submit (∑)')
  await choose(page, 'pages')
  assert.equal(await says(), 'Submit')
})

// Replicata: log in, which selects pushups; tap 3, and Submit.
// Expectata: a datapoint of 3 on pushups, with the access token, a requestid,
// and the comment "via TallyBee at" and the time; the count back to 0; and a
// message saying that it worked.
// Resultata (in a mutant that left the count after a Submit): 3, there to be
// sent again.
qual('Submit sends the count to the selected goal and zeroes the count', async (page, bee) => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  const [p] = posts(bee)
  assert.equal(p.path, 'users/alice/goals/pushups/datapoints.json')
  assert.equal(p.params.access_token, TOKEN)
  assert.equal(String(p.params.value), '3')
  assert.match(p.params.comment, /^via TallyBee at \w{3} \w{3} \d\d \d{4} /)
  assert.ok(p.params.requestid)
  await see(page, '#status', /pushups/)
  assert.equal(await page.getAttribute('#status', 'data-kind'), 'ok')
})

// Replicata: tap 3, hit Submit, tap twice more before Beeminder replies.
// Expectata: the 2 taps after Submit stay counted.
// Resultata (in a mutant whose Submit zeroed the count once Beeminder had the
// datapoint): 0, the 2 taps lost.
qual('Submit shows it is busy and taps made meanwhile are kept', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  assert.ok(await disabled(page, '#subbut'))
  assert.equal(await page.getAttribute('#status', 'data-kind'), 'busy')
  await tap(page, '#bigbut', 2)
  open(null)
  await see(page, '#bigbut', '2')
  assert.deepEqual(values(bee), ['3'])
  assert.ok(!await disabled(page, '#subbut'))
})

// Replicata: tap once and Submit, with Beeminder slow to answer; tap right on
// the infinibee.
// Expectata: the infinibee, while Beeminder takes the datapoint, flying figure
// eights (a lemniscate: see style.css) over the big button; the tap on it
// counting; and the infinibee gone once Beeminder answers.
// Resultata (in a mutant whose infinibee caught taps): the tap on it didn't
// count.
qual('an infinibee flies figure eights while Beeminder takes the datapoint', async (page, bee) => {
  await login(page)
  assert.ok(!await page.isVisible('#infinibee'))
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut')
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  assert.ok(await page.isVisible('#infinibee'))
  await page.$eval('#infinibee image', i => i.decode()) // the artwork is there
  const a = await box(page, '#infinibee image')
  await lapse(page, 250)
  const b = await box(page, '#infinibee image')
  assert.notDeepEqual(a, b, 'the bee should be flying')
  // Where the bee is ms into its 2-second loop around the lemniscate
  const at = ms => page.$eval('#infinibee image', (i, ms) => {
    const a = i.getAnimations()[0]
    a.pause()
    a.currentTime = ms
    const r = i.getBoundingClientRect()
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]
  }, ms)
  const [p0, p250, p500, p1000, p1500] =
    [await at(0), await at(250), await at(500), await at(1000), await at(1500)]
  assert.ok(Math.abs(p500[0] - p1500[0]) <= 1 && Math.abs(p500[1] - p1500[1]) <= 1,
            `it crosses its own path: ${p500} vs ${p1500}`)
  assert.notEqual(p250[1], p500[1], 'and loops')
  assert.ok(p0[0] > p500[0] && p1000[0] < p500[0] && Math.abs(p0[1] - p1000[1]) <= 1,
            `with a lobe on each side: ${[p0, p500, p1000]}`)
  // The bee doesn't get in the way of counting, even tapped right on
  const c = await box(page, '#infinibee image')
  await page.touchscreen.tap(c.x + c.width / 2, c.y + c.height / 2)
  assert.equal(await count(page), 2)
  open(null)
  await see(page, '#bigbut', '1')
  assert.ok(!await page.isVisible('#infinibee'))
})

// Replicata: Submit, with Beeminder slow to answer, and watch the infinibee.
// Expectata: it flies as Beeminder's own does (lemniscate-bernoulli in
// beeminder.com's CSS): from its right end, up and around, its head leading
// the way, so pointing up there (0°, clockwise), down and to the left as it
// crosses the middle (-135°), up at the left end, and down and to the right
// as it crosses back (135°).
// Resultata (before): its head always up, flying down from its right end.
qual("the infinibee flies as Beeminder's does: up from its right end, head first", async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  // Where the bee's middle is, ms into its 2-second loop, and which way its
  // head points, in degrees clockwise from up
  const at = ms => page.$eval('#infinibee image', (i, ms) => {
    const a = i.getAnimations()[0]
    a.pause()
    a.currentTime = ms
    const r = i.getBoundingClientRect(), m = i.getScreenCTM()
    return [r.x + r.width / 2, r.y + r.height / 2, Math.atan2(m.b, m.a) * 180 / Math.PI]
  }, ms)
  const [[, y0, h0], [, y100], [, , h500], [, , h1000], [, , h1500]] =
    [await at(0), await at(100), await at(500), await at(1000), await at(1500)]
  assert.ok(y100 < y0, `up from its right end: ${y0}, then ${y100}`)
  for (const [ms, h, want] of [[0, h0, 0], [500, h500, -135], [1000, h1000, 0],
                               [1500, h1500, 135]])
    assert.ok(Math.abs(h - want) <= 10, `its head at ${h}°, not ${want}°, at ${ms}ms`)
  open(null)
  await settled(page)
})

// Replicata: ask your device for less motion; tap once and Submit, with
// Beeminder slow to answer.
// Expectata: the infinibee, holding still.
// Resultata (in a mutant without style.css's rule for less motion): flying all
// the same.
qual('the infinibee holds still for people who ask their device for less motion', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut')
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  assert.ok(await page.isVisible('#infinibee'))
  const a = await box(page, '#infinibee image')
  await lapse(page, 250)
  assert.deepEqual(await box(page, '#infinibee image'), a)
  open(null)
  await see(page, '#bigbut', '0')
}, { reducedMotion: 'reduce' })

// Replicata: tap 3, hit Submit, and hit Clear before Beeminder replies.
// Expectata: Clear can't be pressed till then.
// Resultata (before): the count ended up at -3, with Submit enabled.
// SPEC CHANGE (following from the owner's answer to question 9 in AGENTS.md,
// that Clear be grayed out at 0): 2 more taps while Beeminder takes the
// datapoint, so that, once it has, there's a tally for Clear to clear.
qual('Clear is grayed out while Beeminder takes the datapoint', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  assert.ok(await disabled(page, '#clearbut'))
  await tap(page, '#bigbut', 2)
  assert.ok(await disabled(page, '#clearbut'))
  open(null)
  await see(page, '#bigbut', '2')
  assert.ok(!await disabled(page, '#clearbut'))
})

// Replicata: tap 3, hit Submit, and hit UNDO before Beeminder replies.
// Expectata: UNDO can't be pressed till then, since the Submit can't be undone.
// Resultata (with UNDO pressable): an error once Beeminder replied, as UNDO
// waits for the Submit to finish, and then there's nothing to undo.
qual('UNDO is grayed out while Beeminder takes the datapoint', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  assert.ok(await disabled(page, '#undobut'))
  open(null)
  await see(page, '#bigbut', '0')
})

// Replicata: tap once and Submit, with Beeminder slow to answer, and reach for
// the dropdown.
// Expectata: grayed out till Beeminder answers, since picking a goal loads
// another page, which wouldn't hear Beeminder's answer.
// Resultata (in a mutant that never grayed it out while sending): usable while
// the datapoint was on its way.
qual('the goal dropdown is grayed out while Beeminder takes the datapoint', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut')
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  assert.ok(await disabled(page, '#goals'))
  open(null)
  await see(page, '#bigbut', '0')
  assert.ok(!await disabled(page, '#goals'))
})

// Replicata: a refresh of the goals is under way (as when you come back to
// TallyBee) when you tap 3 and Submit, then tap 2 more before Beeminder
// answers the refresh.
// Expectata: 3 gets submitted, and the 2 stay counted.
// Resultata (in a mutant that read the count when the Submit's turn came): 0,
// the 2 taps made after Submit sent along with the 3.
qual('Submit sends the count from when it was tapped, even while waiting its turn', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'GET' ? shut.then(() => null) : null
  await comeback(page)
  await calls(page, bee, LOAD + 2) // the goals and the user, held
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await tap(page, '#bigbut', 2)
  open()
  await see(page, '#bigbut', '2')
  assert.deepEqual(values(bee), ['3'])
})

// Replicata: TallyBee in two windows on pushups. In one, tap 3 and Submit; in
// the other, before Beeminder replies, press Clear.
// Expectata: the 3 go to Beeminder and the count ends at 0.
// Resultata (before): -3, since the reply took 3 off the cleared count.
qual('Clear in another window during a submission leaves the count at 0', async (page, bee) => {
  await login(page)
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await page.bringToFront()
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, 2 * LOAD + 1)
  await w.bringToFront()
  await clear(w) // FINAL DESIGN
  open(null)
  await see(w, '#bigbut', '0')
  await page.bringToFront()
  await see(page, '#bigbut', '0')
  await see(page, '#status', /pushups/)
  assert.deepEqual(values(bee), ['3'])
})

// Replicata: TallyBee in two windows on pushups. In one, tap 3 and Submit; in
// the other, before Beeminder replies, press Submit too.
// Expectata: the 3 go to Beeminder once, and the second window says it didn't
// send them.
// Resultata (before): the same 3 went twice, as two datapoints.
qual('Submit in another window during a submission sends the taps only once', async (page, bee) => {
  await login(page)
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await page.bringToFront()
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, 2 * LOAD + 1)
  await w.bringToFront()
  await see(w, '#bigbut', '3')
  await tap(w, '#subbut')
  open(null)
  await see(w, '#status', /Error/)
  await expectError(page, bee, /./)
  await see(w, '#bigbut', '0')
  assert.deepEqual(values(bee), ['3'])
})

// Replicata: Submit over a connection that never answers.
// Expectata: after a while, an error, the count kept, and Submit usable again.
// Resultata (before): "Submitting…" forever, with Submit and Clear grayed out.
qual('a request that Beeminder never answers gives up with an error', async (page, bee) => {
  await page.clock.install()
  await login(page)
  bee.reply = c => c.method === 'POST' ? new Promise(() => {}) : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  await page.clock.runFor(120000)
  await see(page, '#status', /Error/)
  await expectError(page, bee, /./)
  assert.ok(!await disabled(page, '#subbut'))
  assert.equal(await count(page), 3)
})

// Replicata: a goal with no datapoints and no current value, as for a goal in
// an error state. Pick it, tap 1, and Submit.
// Expectata: an error, and TallyBee working as before, even after reloading.
// Resultata (before): TallyBee saved something it then couldn't read back, and
// stopped working, even after reloading, till its storage got cleared.
qual('TallyBee never saves something it could not read back', async (page, bee) => {
  await login(page)
  bee.goals[2].curval = null
  await choose(page, 'newodo')
  await tap(page, '#bigbut')
  await tap(page, '#subbut')
  await see(page, '#status', /Error/)
  await expectError(page, bee, /./)
  await page.reload()
  await see(page, '#goals', /pushups/)
  await see(page, '#bigbut', '1')
  assert.equal(await page.getAttribute('#status', 'data-kind'), null)
})

// Replicata: tap 3, hit Submit, Beeminder has a hiccup.
// Expectata: the count stays so you can submit it again, which won't make a
// duplicate datapoint if Beeminder did get the first one after all.
// Resultata (in a mutant that sent each try with a new requestid): a resend
// with a requestid of its own, which Beeminder would add as a second datapoint
// if it had the first after all.
qual('a failed submit keeps the count and says why; resubmitting is idempotent', async (page, bee) => {
  await login(page)
  bee.reply = c => c.method === 'POST' ? [500, { errors: { message: 'Kaboom' } }] : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await see(page, '#status', /500.*Kaboom/)
  await expectError(page, bee, /Kaboom/)
  assert.equal(await page.getAttribute('#status', 'data-kind'), 'err')
  assert.equal(await count(page), 3)
  bee.reply = () => null
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  await tap(page, '#bigbut')
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  const [a, b, c] = posts(bee).map(p => p.params.requestid)
  assert.equal(a, b)
  assert.notEqual(b, c)
})

// Replicata: tap 3 and Submit; the reply gets lost. The phone later reloads the
// page (as phones do with pages in the background), and you Submit again.
// Expectata: the resend has the same requestid, so it can't be a duplicate.
// Resultata (in a mutant that started a new requestid each time the page
// loaded): the resend after the reload with a new requestid.
qual('resubmitting after the page reloads is still idempotent', async (page, bee) => {
  await login(page)
  bee.reply = c => c.method === 'POST' ? 'abort' : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  await page.reload()
  await see(page, '#goals', /pushups/)
  bee.reply = () => null
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  const [a, b, c] = posts(bee).map(p => p.params.requestid)
  assert.ok(a === b && b === c, JSON.stringify([a, b, c]))
})

// Replicata: tap 20 and Submit. Beeminder saves it but the reply is lost. You
// see the 20 on Beeminder's site so you hit Clear, then tap 15 and Submit.
// Expectata: a new datapoint of 15, next to the 20.
// Resultata (before): the 15 went out with the 20's requestid, so Beeminder
// replaced the 20 with it.
qual('Clear starts a new datapoint, even after a lost reply', async (page, bee) => {
  await login(page)
  bee.reply = c => c.method === 'POST' ? 'abort' : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  await clear(page) // FINAL DESIGN
  await see(page, '#bigbut', '0')
  bee.reply = () => null
  await tap(page, '#bigbut', 2)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  const [a, b] = posts(bee).map(p => p.params.requestid)
  assert.notEqual(a, b)
})

// Replicata: two TallyBee windows on the same goal. Submit 5 from one, then 3
// from the other.
// Expectata: two datapoints.
// Resultata (before): both went out with the same requestid, so Beeminder
// replaced the 5 with the 3.
qual('two windows never send two datapoints under one requestid', async (page, bee) => {
  await login(page)
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  await page.bringToFront()
  await tap(page, '#bigbut', 5)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  await w.bringToFront()
  await see(w, '#bigbut', '0')
  await tap(w, '#bigbut', 3)
  await tap(w, '#subbut')
  await see(w, '#bigbut', '0')
  const [a, b] = posts(bee).map(p => p.params.requestid)
  assert.notEqual(a, b)
  assert.deepEqual(values(bee), ['5', '3'])
})

// Replicata: tap 3 and Submit, with no connection.
// Expectata: an error, the 3 kept, and Submit usable, to try again.
// Resultata (in a mutant that took the 3 off the count when Submit was
// pressed, rather than once Beeminder had them): 0, the 3 lost.
qual('no internet keeps the count and says so', async (page, bee) => {
  await login(page)
  bee.reply = c => c.method === 'POST' ? 'abort' : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await see(page, '#status', /Error/)
  await expectError(page, bee, /fetch/i)
  assert.equal(await count(page), 3)
  assert.ok(!await disabled(page, '#subbut'))
})

// Replicata: press −1 twice, and Submit.
// Expectata: -2 sent, as Beedroid lets you.
// Resultata (in a mutant whose Submit sent only counts above 0): Submit grayed
// out, and nothing sent.
qual('negative counts can be submitted, like in Beedroid', async (page, bee) => {
  await login(page)
  await tap(page, '#minusbut', 2)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.deepEqual(values(bee), ['-2'])
})

// Replicata: on odometer goal pages, whose last datapoint is 120 (and whose
// current value is 320), tap 3 and Submit; then tap 2 and Submit.
// Expectata: 120 at first, as the big number and the number to send; 123, and
// 123 sent; then 125, and 125 sent. Beedroid treats non-cumulative goals like
// odometers: the tally starts from the last datapoint and what's submitted is
// the new total. The big number is the number to send, always, so it's the
// reading: it stays at 123 after the Submit, as that's the reading then.
// Resultata (in a mutant that built on the goal's current value): 320.
qual('for a non-cumulative goal the count adds to the last datapoint', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  await see(page, '#num', '120')
  await see(page, '#bigbut', '120')
  await tap(page, '#bigbut', 3)
  await see(page, '#num', '123')
  await see(page, '#bigbut', '123')
  await tap(page, '#subbut')
  await settled(page)
  await see(page, '#num', '123')
  await see(page, '#bigbut', '123')
  await tap(page, '#bigbut', 2)
  await see(page, '#bigbut', '125')
  await see(page, '#num', '125')
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(values(bee), ['123', '125'])
})

// Replicata: an odometer goal whose last datapoint is 0.14 (hours, say). Tap
// once, and Submit.
// Expectata: 1.14, and 1.14 sent.
// Resultata (before): 1.1400000000000001, and that sent, since that's what
// JavaScript's arithmetic makes of 1 + 0.14.
qual('an odometer goal with decimal values gets no stray digits', async (page, bee) => {
  bee.goals.push({ slug: 'hours', kyoom: false, curval: 0.14, deadline: 0,
                   last_datapoint: datapoint(0.14), safesum: 'safe for 2 days',
                   queued: false })
  await login(page)
  await choose(page, 'hours')
  await tap(page, '#bigbut')
  await see(page, '#num', '1.14')
  await see(page, '#bigbut', '1.14')
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(values(bee), ['1.14'])
})

// Replicata: on odometer goal newodo, which has no datapoints and a current
// value of 7, tap once.
// Expectata: 8.
// Resultata (in a mutant that started a goal with no datapoints from 0): 1.
qual('a non-cumulative goal with no datapoints starts from its current value', async page => {
  await login(page)
  await choose(page, 'newodo')
  await tap(page, '#bigbut')
  await see(page, '#num', '8')
  await see(page, '#bigbut', '8')
})

// Type the number to send, n, in its field, and press Enter
async function type(page, n) {
  await page.fill('#num', n)
  await page.press('#num', 'Enter')
}

// Replicata: you did 50 pushups without TallyBee. Type 50 as the number to
// send, and press Enter; then Submit.
// Expectata: the count is 50, and Submit sends 50.
// Resultata (before): the number couldn't be typed, only tapped out.
qual('you can type the number to send', async (page, bee) => {
  await login(page)
  await type(page, '50')
  await see(page, '#bigbut', '50')
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.deepEqual(values(bee), ['50'])
})

// Replicata: on odometer goal pages, at 120, type 130 as the number to send,
// and tap once.
// Expectata: 130, then 131, and Submit sends 131.
// Resultata (in a mutant that made the typed reading the count): 250, then
// 251, built on the 120.
qual('on an odometer goal you type the reading', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  await type(page, '130')
  await see(page, '#bigbut', '130')
  await tap(page, '#bigbut')
  await see(page, '#bigbut', '131')
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(values(bee), ['131'])
})

// Replicata: tap 3, type 50 by mistake, and press UNDO.
// Expectata: 3 again.
// Resultata (in a mutant that didn't make a typed number a change of its own,
// for UNDO): 2, as UNDO undid the last tap instead.
qual('UNDO undoes a typed number', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await type(page, '50')
  await see(page, '#bigbut', '50')
  await tap(page, '#undobut')
  await see(page, '#bigbut', '3')
})

// Replicata: tap 3, then try to type, after the 3, each of a letter, a
// decimal point (as in 3.5, or 3,5, as in places that write a comma for it),
// a space, an e (as in 3e2), a plus, and a minus; and paste in "1,000".
// Expectata: none of it goes in: the field says 3 still, as the big number
// does, each time, and Submit sends 3.
// Resultata (before): what was typed stayed in the field, which then said
// something other than the big number, which Submit couldn't send till the
// field was made to say the same number again.
qual("what isn't a whole number can't be typed as the number to send", async (page, bee) => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await tap(page, '#num')
  await page.keyboard.press('End')
  for (const key of ['a', '.', ',', ' ', 'e', '+', '-']) {
    await page.keyboard.type(key)
    assert.equal(await page.inputValue('#num'), '3', key)
    assert.equal(await count(page), 3, key)
  }
  await page.keyboard.insertText('1,000') // as a paste does
  assert.equal(await page.inputValue('#num'), '3', 'pasted')
  await page.keyboard.press('Enter')
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(values(bee), ['3'])
})

// Replicata: tap 3; in the number to send, put a minus in place of the 3,
// watching the big number; type 5; then put a minus there again, and tap the
// big button.
// Expectata: the minus alone, waiting for its digits, with the big number 3
// still; then -5, both; then, the field left with the minus alone in it, the
// number to send in it again: -4, after the tap.
// Resultata (before): the minus alone made the field red, and Submit gray.
qual('a minus can start the number to send, and waits for its digits', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await tap(page, '#num')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('-')
  assert.equal(await page.inputValue('#num'), '-')
  assert.equal(await count(page), 3)
  await page.keyboard.type('5')
  await see(page, '#bigbut', '-5')
  assert.equal(await page.inputValue('#num'), '-5')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('-')
  await tap(page, '#bigbut')
  await see(page, '#bigbut', '-4')
  assert.equal(await page.inputValue('#num'), '-4')
})

// Replicata: tap 3; in the number to send, put a minus in place of the 3; and
// before you type its digits, TallyBee loads the goals again (as when you come
// back to it, or every 2 seconds while Beeminder updates the goal); type 5.
// Expectata: the minus waiting for its digits all the while, and then -5.
// Resultata (before): the goals' loading put the 3 back in place of the minus,
// so typing 5 made 35.
qual('a minus waiting for its digits survives the goals loading', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await tap(page, '#num')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('-')
  await comeback(page) // which loads the goals again
  await settled(page)
  assert.equal(await page.inputValue('#num'), '-')
  await page.keyboard.type('5')
  await see(page, '#bigbut', '-5')
  assert.equal(await page.inputValue('#num'), '-5')
})

// Replicata: tap 3; in the number to send, put a minus in place of the 3, and,
// before typing any digit, press Enter, the phone keyboard's done key.
// Expectata: the field says 3 again, as the big number does: a minus waiting
// for its digits is undone when the field is left.
// Resultata (in a mutant that, when the field was left, didn't show the number
// to send again): the minus, alone, still in the field, with the big number 3.
qual('a minus left alone in the number to send is undone when you press Enter', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await tap(page, '#num')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('-')
  await page.keyboard.press('Enter')
  await see(page, '#num', '3')
  assert.equal(await count(page), 3)
})

// Replicata: type 05 as the number to send, a key at a time; then empty the
// field.
// Expectata: 5, the field saying 5 too, at once; then 0, both.
// Resultata (before): an error, as JavaScript writes 5 as 5, not 05.
qual('a number typed with a leading zero, like 05, is that number', async page => {
  await login(page)
  await tap(page, '#num')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('05')
  await see(page, '#bigbut', '5')
  assert.equal(await page.inputValue('#num'), '5')
  await page.keyboard.press('Backspace')
  await see(page, '#bigbut', '0')
  assert.equal(await page.inputValue('#num'), '0')
})

// Replicata: tap 3; tap the number to send, select what it says, and type
// 42, a key at a time, watching the big number, before pressing Enter.
// Expectata: the big number follows along, 4, then 42, as it always says what
// Submit would send.
// Resultata (before): 3 till Enter was pressed.
qual('the big number follows the number to send as it is typed', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await tap(page, '#num')
  await page.keyboard.press('ControlOrMeta+A')
  for (const [key, n] of [['4', '4'], ['2', '42']]) {
    await page.keyboard.type(key)
    await see(page, '#bigbut', n)
  }
  assert.equal(await page.evaluate(() => document.activeElement.id), 'num')
})

// Replicata: tap 3; tap the number to send, empty it, type 50 a key at a time,
// and press Enter; press UNDO.
// Expectata: 3 again: the whole edit undone, as for the comment.
// Resultata (in a mutant that made each keystroke a change of its own): 5.
qual('UNDO undoes a typed number whole, not a keystroke', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await tap(page, '#num')
  await page.fill('#num', '')
  await page.keyboard.type('50')
  await page.keyboard.press('Enter')
  await see(page, '#bigbut', '50')
  await tap(page, '#undobut')
  await see(page, '#bigbut', '3')
  assert.ok(!await disabled(page, '#undobut'), 'the taps still undoable')
})

// Replicata: TallyBee in two windows. In one, tap 3 and Submit, with Beeminder
// slow to answer; meanwhile, in the other, tap the number to send. Once the
// Submit gets there, type 7 in the other, press Enter, and press UNDO; then
// Submit there.
// Expectata: UNDO takes the 7 back to 0, the count as it was when the 7 got
// typed, and the second Submit sends that 0: the 3 go to Beeminder once.
// Resultata (before): UNDO brought back the 3, the count as it was when the
// field got the focus, before the first Submit got there, so the second
// Submit sent the 3 again.
qual("UNDO of an edit can't bring back taps another window submitted meanwhile", async (page, bee) => {
  await login(page)
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut.then(() => null) : null
  await page.bringToFront()
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, 2 * LOAD + 1)
  await w.bringToFront()
  await see(w, '#bigbut', '3')
  await tap(w, '#num')
  open()
  await see(page, '#status', /pushups/)
  await see(w, '#num', '0')
  await w.keyboard.press('ControlOrMeta+A')
  await w.keyboard.type('7')
  await w.keyboard.press('Enter')
  await see(w, '#bigbut', '7')
  await tap(w, '#undobut')
  await see(w, '#bigbut', '0')
  await tap(w, '#subbut')
  await see(w, '#status', /pushups/)
  assert.deepEqual(values(bee), ['3', '0'])
})

// Replicata: TallyBee in two windows. In one, tap 3 and Submit, with Beeminder
// slow to answer; meanwhile, in the other, type 7 as the number to send. Once
// the Submit gets there, which leaves 4 to send in the other, type 2 there,
// after the 4, press Enter, and press UNDO.
// Expectata: UNDO takes the 42 back to 4, the count as it was just before the
// 2 got typed, after the last Submit.
// Resultata (before): UNDO grayed out, with nothing to undo: the edit had
// given UNDO its way back at the 7, which the Submit then took away.
qual('UNDO takes back what was typed after another window submitted mid-edit', async (page, bee) => {
  await login(page)
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut.then(() => null) : null
  await page.bringToFront()
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, 2 * LOAD + 1)
  await w.bringToFront()
  await see(w, '#bigbut', '3')
  await tap(w, '#num')
  await w.keyboard.press('ControlOrMeta+A')
  await w.keyboard.type('7')
  await see(w, '#bigbut', '7')
  open()
  await see(page, '#status', /pushups/)
  await see(w, '#num', '4')
  await w.keyboard.press('End')
  await w.keyboard.type('2')
  await see(w, '#bigbut', '42')
  await w.keyboard.press('Enter')
  assert.ok(!await disabled(w, '#undobut'), 'UNDO, for the 2')
  await tap(w, '#undobut')
  await see(w, '#bigbut', '4')
})

// Replicata: open TallyBee, logged out (or with no connection), tap 2, type 7
// as the number to send, and type a comment.
// Expectata: 7, and the comment, saved, for when you log in; Submit grayed
// out, with no goal to send to.
// Resultata (before): the number to send grayed out till the goals loaded.
qual('logged out, the number and the comment can still be typed', async page => {
  await page.goto(APP)
  await tap(page, '#bigbut', 2)
  assert.ok(!await disabled(page, '#num'))
  await type(page, '7')
  await see(page, '#bigbut', '7')
  await remark(page, 'before logging in')
  assert.deepEqual([(await tallied(page)).count, (await tallied(page)).comment],
                   [7, 'before logging in'])
  assert.ok(await disabled(page, '#subbut'))
})

// Replicata: type 123456789012345, 15 digits, as the number to send, and then
// a 16th digit.
// Expectata: all 15 show, in a field grown to fit them, the footer still
// fitting the screen; the 16th doesn't go in, as JavaScript's numbers hold no
// more digits than 15 exactly.
// Resultata (before): the field stayed 4 digits wide, cutting off the rest
// with no sign that it had; and more digits went in, and got rounded, and,
// from 22 of them, written like 1e+21.
qual('a long number to send shows whole, up to 15 digits', async page => {
  await login(page)
  await tap(page, '#num')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('123456789012345')
  await page.keyboard.type('6')
  await see(page, '#num', '123456789012345')
  await see(page, '#bigbut', '123456789012345')
  const r = await page.$eval('#num', e => [e.scrollWidth, e.clientWidth])
  assert.ok(r[0] <= r[1], JSON.stringify(r))
  await page.keyboard.press('Enter')
  await fits(page)
})

// Replicata: with a phone's text at 200% (which makes a 400px-wide phone like
// a 200px-wide one: see "with text at 200% on a phone, the controls still
// fit"), type 123456789012345, 15 digits, as the number to send, and press
// Enter.
// Expectata: all 15 digits; or, where even the field's whole row is too narrow
// for them, the field ending in "…", so that it's plain that the number is
// cut short.
// Resultata (before): 12345678901234, the 15th digit cut off, with no sign that
// it was.
qual('a long number to send shows whole, or that it is cut short, even with text at 200%', async page => {
  await login(page)
  await tap(page, '#num')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('123456789012345')
  await page.keyboard.press('Enter')
  await see(page, '#num', '123456789012345')
  const r = await page.$eval('#num', e => [e.scrollWidth, e.clientWidth])
  // How the field looks, and how it looks with what it says just cut off at
  // its edge, like before
  const a = await page.locator('#num').screenshot()
  await page.$eval('#num', e => { e.style.textOverflow = 'clip' })
  const b = await page.locator('#num').screenshot()
  assert.ok(r[0] <= r[1] || !a.equals(b), `cut off with no sign: ${r}`)
}, { viewport: { width: 200, height: 433 } })

// Replicata: start typing a number, and before you press Enter, TallyBee
// loads the goals again (as it does every 2 seconds while Beeminder updates
// the goal).
// Expectata: what you're typing stays as you typed it.
// Resultata (in a mutant that set what the field says, rather than its
// default): "0", the 42 being typed gone.
qual("TallyBee doesn't change the number to send while you're typing it", async page => {
  await login(page)
  await page.fill('#num', '42')
  await comeback(page) // which loads the goals again
  await settled(page)
  assert.equal(await page.inputValue('#num'), '42')
  await page.press('#num', 'Enter')
  await see(page, '#bigbut', '42')
})

// Replicata: on a phone, tap the number to send, type 50, and press the
// keyboard's done key (Enter).
// Expectata: the count is 50, and the field lets go of the focus, which puts
// the keyboard away, as for the comment, so that putting it away takes no tap
// on the big button, which would count.
// Resultata (before): the field kept the focus, so the keyboard stayed up, and
// the tap on the big button that then put it away counted too: type 50, tap,
// and Submit sent 51.
qual("Enter, the phone keyboard's done key, puts the number to send away", async page => {
  await login(page)
  assert.equal(await page.getAttribute('#num', 'enterkeyhint'), 'done')
  await tap(page, '#num')
  await page.fill('#num', '50')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'num')
  await page.keyboard.press('Enter')
  await see(page, '#bigbut', '50')
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'num')
  // and so does an Enter with nothing typed
  await tap(page, '#num')
  await page.keyboard.press('Enter')
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'num')
  assert.equal(await count(page), 50)
})

// Replicata: log in, and tap twice.
// Expectata: 0 to send, and then 2.
// Resultata (in a mutant that never updated it): 0 still.
qual('the footer shows what Submit will send', async page => {
  await login(page)
  await see(page, '#num', '0')
  await tap(page, '#bigbut', 2)
  await see(page, '#num', '2')
})

// For bee.reply (see qual): Beeminder takes the datapoint TallyBee POSTs, as
// the newest of odometer goal pages (bee.goals[1]), which is then "safe for 4
// days", but its reply gets lost
const lostreply = bee => c => {
  if (c.method !== 'POST') return null
  bee.goals[1].last_datapoint = datapoint(Number(c.params.value),
    { daystamp: c.params.daystamp, comment: c.params.comment, requestid: c.params.requestid })
  bee.goals[1].safesum = 'safe for 4 days'
  return 'abort'
}

// Replicata: on odometer goal pages (at 120), tap 3 and Submit. Beeminder saves
// 123, but its reply is lost. Switch away and back, which refreshes the goals,
// now at 123, and Submit again.
// Expectata: the resend is 123 again, updating that datapoint in place.
// Resultata (before): 126, as if 3 more pages.
qual('resending an odometer datapoint after a lost reply sends the same value', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  bee.reply = lostreply(bee)
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  await comeback(page)
  await see(page, '#safesum', 'safe for 4 days')
  await see(page, '#num', '123')
  bee.reply = () => null
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(values(bee), ['123', '123'])
  const [a, b] = posts(bee).map(p => p.params.requestid)
  assert.equal(a, b)
})

// Replicata: on odometer goal pages (at 120), tap 3 and Submit. Beeminder saves
// 123, but its reply is lost. Press UNDO, to undo the third tap, and switch
// away and back, which refreshes the goals, now at 123. Submit again.
// Expectata: 122, as the same datapoint, updating the 123 in place.
// Resultata (before): 125, since UNDO put back the datapoint as it was before
// its first Submit, with no base pinned to it, so it got built on the 123.
qual('UNDO after a lost reply keeps the odometer datapoint the same datapoint', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  bee.reply = lostreply(bee)
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  await tap(page, '#undobut')
  await see(page, '#bigbut', '122')
  await comeback(page)
  await see(page, '#safesum', 'safe for 4 days')
  await see(page, '#num', '122')
  bee.reply = () => null
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(values(bee), ['123', '122'])
  const [a, b] = posts(bee).map(p => p.params.requestid)
  assert.equal(a, b)
})

// Replicata: on odometer goal pages (at 120), tap 3 and Submit, and tap once
// more while it's sending. It gets a 401, because you logged in on another
// device (and entered 130 there). Log in again here (134), and UNDO.
// Expectata: 133.
// Resultata (before): 123, built on the 120 that the rejected Submit had
// pinned, which UNDO put back.
qual('UNDO after a rejected submission brings back no base from it', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut.then(() => null) : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, 2 * LOAD + 1)
  await tap(page, '#bigbut')
  bee.tokens = ['tok456']
  bee.goals[1].last_datapoint = datapoint(130)
  open()
  await see(page, '#status', `Error: ${REAUTH}`)
  await expectError(page, bee, new RegExp(RegExp.escape(REAUTH)))
  await login(page, 'alice', 'tok456')
  await see(page, '#num', '134')
  await tap(page, '#undobut')
  await see(page, '#bigbut', '133')
  await see(page, '#num', '133')
})

// Replicata: on odometer goal pages (at 120), tap 3 and Submit. Beeminder saves
// 123, but its reply is lost. Switch away and back, which refreshes the goals,
// now at 123. Press Clear by mistake, then UNDO, and Submit again.
// Expectata: 123 again, as the same datapoint, updating it in place.
// Resultata (in a mutant whose UNDO of a Clear left out the pin, the base the
// datapoint was built on): 126, built on the 123.
qual('UNDO of a Clear brings back the odometer datapoint, base and all', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  bee.reply = lostreply(bee)
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  await comeback(page)
  await see(page, '#safesum', 'safe for 4 days')
  await clear(page) // FINAL DESIGN
  await till(page, async () => (await tallied(page)).count === 0)
  await see(page, '#bigbut', '123') // where the goal is now
  await tap(page, '#undobut')
  await till(page, async () => (await tallied(page)).count === 3)
  await see(page, '#bigbut', '123') // where the datapoint had it
  await see(page, '#num', '123')
  bee.reply = () => null
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(values(bee), ['123', '123'])
  const [a, b] = posts(bee).map(p => p.params.requestid)
  assert.equal(a, b)
})

// Replicata: on odometer goal pages (at 120), tap 3 and Submit, and Beeminder
// saves 123 but its reply is lost. Refresh the goals (now at 123), then Clear,
// tap 2, and Submit.
// Expectata: a new datapoint of 125.
// Resultata (before): 122, built on the 120 that the cleared datapoint had
// pinned.
qual('Clear starts a new odometer datapoint from where the goal is now', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  bee.reply = lostreply(bee)
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  bee.reply = () => null
  await comeback(page)
  await see(page, '#safesum', 'safe for 4 days')
  await clear(page) // FINAL DESIGN
  await till(page, async () => (await tallied(page)).count === 0)
  await tap(page, '#bigbut', 2)
  await see(page, '#num', '125')
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(values(bee), ['123', '125'])
  const [a, b] = posts(bee).map(p => p.params.requestid)
  assert.notEqual(a, b)
})

// Replicata: on odometer goal pages (at 120), tap 3 and Submit, which gets a
// 401 because you logged in on another device (and entered 130 there). Log in
// again here.
// Expectata: 133.
// Resultata (before): 123, built on the 120 that the rejected Submit had
// pinned.
qual('a submission that Beeminder rejects pins nothing', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  await tap(page, '#bigbut', 3)
  bee.tokens = ['tok456']
  bee.goals[1].last_datapoint = datapoint(130)
  await tap(page, '#subbut')
  await see(page, '#status', `Error: ${REAUTH}`)
  await expectError(page, bee, new RegExp(RegExp.escape(REAUTH)))
  await login(page, 'alice', 'tok456')
  await see(page, '#num', '133')
})

// Replicata: odometer goal pages has datapoints 100 (yesterday) and 120 (today).
// Edit yesterday's (even just its comment) on Beeminder's site, which makes it
// the goal's last_datapoint in the API. Then tap 3 in TallyBee.
// Expectata: 123, from the newest reading, like in Beedroid.
// Resultata (before): 103.
qual("an odometer goal counts up from its newest datapoint, even after an older one's edited", async (page, bee) => {
  await login(page)
  bee.added.pages = datapoint(120)
  bee.goals[1].last_datapoint = datapoint(100)
  await choose(page, 'pages')
  await tap(page, '#bigbut', 3)
  await see(page, '#num', '123')
})

// Replicata: two windows in view side by side on odometer goal pages (at 120).
// Submit 3 in one; then tap 2 in the other.
// Expectata: the other says 125.
// Resultata (before): 122, from goal data older than the first window's
// datapoint.
qual("a window that stays in view sees another window's datapoint", async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  const w = await window2(page, APP + '?goal=pages')
  await see(w, '#goals', /pushups/)
  bee.reply = c => {
    if (c.method === 'POST')
      bee.goals[1].last_datapoint = datapoint(Number(c.params.value))
    return null
  }
  await w.bringToFront()
  await tap(w, '#bigbut', 3)
  await tap(w, '#subbut')
  await settled(w)
  await page.bringToFront()
  await tap(page, '#bigbut', 2)
  await see(page, '#num', '125')
})

// Replicata: on pages (at 120), tap 3 and Submit, and switch away and back
// while it's sending; Beeminder answers the refresh late, with what it had
// before the 123. Tap 2 more.
// Expectata: 125.
// Resultata (in a mutant that loaded the goals without waiting its turn):
// "safe for 3 days", from before the 123, from then on, but only in 2 runs of
// 16. In the rest, the fake Beeminder here got the refresh only after letting
// the Submit's answer go, so it answered with the 123, and this qual passed.
qual('a goals refresh during a submission cannot undo the datapoint', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  const [postshut, postopen] = gate()
  const [getshut, getopen] = gate()
  // Beeminder answers each GET with what it had when the GET came in, but late
  bee.reply = c => c.method === 'POST'
    ? postshut.then(() => {
        bee.goals[1].last_datapoint = datapoint(123)
        bee.goals[1].safesum = 'safe for 4 days'
        return null
      })
    : (answer => getshut.then(() => answer))(structuredClone(defaultReply(bee, c)))
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, 2 * LOAD + 1)
  await comeback(page)
  postopen()
  await see(page, '#status', /^✓/)
  getopen()
  await see(page, '#safesum', 'safe for 4 days')
  await tap(page, '#bigbut', 2)
  await see(page, '#num', '125')
})

// Replicata: on pages (at 120), a refresh of the goals is under way when you
// tap 3 and Submit; meanwhile someone entered 130 on Beeminder's site.
// Expectata: 133 gets submitted.
// Resultata (in a mutant that took the goal as it was when Submit was
// pressed): 123, built on the 120 from before the refresh.
qual('a submission waiting on a goals refresh uses the refreshed goal', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  const [shut, open] = gate()
  bee.reply = c => c.method === 'GET' ? shut.then(() => null) : null
  bee.goals[1].last_datapoint = datapoint(130)
  await comeback(page)
  await calls(page, bee, 2 * LOAD + 2)
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  open()
  await see(page, '#status', /^✓/)
  assert.deepEqual(values(bee), ['133'])
})

// ---------------------------------------------------------------- the day

// The page's clock, for quals about days: noon on 2026-10-02 in New York,
// alice's timezone, which is already the next day in Tokyo, the timezone of
// the device in these quals (see TOKYO)
const NOON = new Date('2026-10-02T16:00:00Z')
const TOKYO = { timezoneId: 'Asia/Tokyo' }

// The day dropdown's options, as [value, label]
const days = page => page.$$eval('#day option', os => os.map(o => [o.value, o.text]))

// Replicata: at noon on 2026-10-02 in New York (alice's timezone on Beeminder,
// though her phone is set to Tokyo's, where it's the 3rd already), look at the
// day, and Submit.
// Expectata: the day says "Today (2nd)", as Beeminder's own form does, with
// the 6 days before it to pick from, like "Yesterday (1st)"; and the datapoint
// goes for that day, 20261002.
// Resultata (before): no day shown; Beeminder put the datapoint on whatever
// day it was for it when the datapoint got there.
qual("the day shows, as Beeminder's own form shows it, and the datapoint goes for it", async (page, bee) => {
  await page.clock.setFixedTime(NOON)
  await login(page)
  assert.deepEqual(await days(page), [
    ['20261002', 'Today (2nd)'], ['20261001', 'Yesterday (1st)'],
    ['20260930', '2 days ago (30th)'], ['20260929', '3 days ago (29th)'],
    ['20260928', '4 days ago (28th)'], ['20260927', '5 days ago (27th)'],
    ['20260926', '6 days ago (26th)']])
  assert.equal(await page.inputValue('#day'), '20261002')
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(posts(bee).map(p => p.params.daystamp), ['20261002'])
}, TOKYO)

// Replicata: at noon on the 2nd, tap 3 and pick yesterday; reload; press UNDO,
// and pick yesterday again; Submit.
// Expectata: yesterday, still, after the reload; UNDO takes back the pick,
// whole, as its own change, back to today; the datapoint goes for yesterday,
// 20261001; and the next one is for today again.
// Resultata (before): no way to send a datapoint for another day.
qual('a datapoint can go for one of the days before', async (page, bee) => {
  await page.clock.setFixedTime(NOON)
  await login(page)
  await tap(page, '#bigbut', 3)
  await page.selectOption('#day', '20261001')
  await page.reload()
  await see(page, '#goals', /pushups/)
  assert.equal(await page.inputValue('#day'), '20261001')
  await tap(page, '#undobut')
  await till(page, async () => await page.inputValue('#day') === '20261002')
  assert.equal(await count(page), 3)
  await page.selectOption('#day', '20261001')
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(posts(bee).map(p => p.params.daystamp), ['20261001'])
  assert.equal(await page.inputValue('#day'), '20261002')
}, TOKYO)

// Replicata: a goal whose day ends at 11pm, at 11:30pm in New York; and one
// whose day ends at 6am, at 4am.
// Expectata: the first already on the next day (the 3rd), the second still
// on the day before (the 1st), as Beeminder counts days: by alice's timezone
// and each goal's deadline.
// Resultata (in a mutant that took days to end at midnight): the 2nd, both
// times.
for (const [deadline, now, today] of [[-3600, '2026-10-03T03:30:00Z', ['20261003', 'Today (3rd)']],
                                      [6 * 3600, '2026-10-02T08:00:00Z', ['20261001', 'Today (1st)']]])
  qual(`the day ends at the goal's deadline (${deadline / 3600}h)`, async (page, bee) => {
    bee.goals[0].deadline = deadline
    await page.clock.setFixedTime(new Date(now))
    await login(page)
    assert.deepEqual((await days(page))[0], today)
  }, TOKYO)

// ------------------------------------------------------------ the comment

// Replicata: open TallyBee, logged out, and look at the comment field; log in
// (pushups, whose last datapoint's comment is "set 1"); pick pages (whose last
// datapoint has no comment); pick newodo (which has no datapoints).
// Expectata: the comment field says what the last datapoint's comment was,
// as Beeminder's own form does: "set 1", then nothing; with no datapoint, as
// when logged out, what it says logged out.
// Resultata (before): what it says logged out, always.
qual("the comment field shows the last datapoint's comment, as on Beeminder", async page => {
  await page.goto(APP)
  const placeholder = () => page.getAttribute('#comment', 'placeholder')
  const loggedout = await placeholder()
  assert.match(loggedout, /^\p{L}{2,}/u)
  await login(page)
  assert.equal(await placeholder(), 'set 1')
  await choose(page, 'pages')
  assert.equal(await placeholder(), '')
  await choose(page, 'newodo')
  assert.equal(await placeholder(), loggedout)
})

// Replicata: log in (pushups, whose last datapoint is 3, "set 1", on the 30th);
// pick pages (120, no comment, on the 29th), and newodo (no datapoints); then,
// on pushups, at noon on the 2nd, type "x", tap 2, and Submit.
// Expectata: the last datapoint, as Beeminder's own site shows it, day, value
// and comment, if any: 30 3 "set 1", then 29 120, then nothing; then the one
// just sent, 02 2 "x via TallyBee at …".
// Resultata (before): no last datapoint shown.
// SPEC CHANGE (for the owner to approve): this expected 29 120 "" for pages,
// but Beeminder's own site shows a datapoint with no comment with no quotes:
// see htmlForDatapoint in its app/javascript/goal.js, and the data-display of
// its app/views/datapoints/_datapoint.html.erb.
qual('the last datapoint shows, as on Beeminder: its day, value and comment', async page => {
  await page.clock.setFixedTime(NOON)
  await login(page)
  await see(page, '#lastdp', '30 3 "set 1"')
  await choose(page, 'pages')
  await see(page, '#lastdp', '29 120')
  await choose(page, 'newodo')
  await see(page, '#lastdp', '')
  await choose(page, 'pushups')
  await remark(page, 'x')
  await tap(page, '#bigbut', 2)
  await tap(page, '#subbut')
  await see(page, '#lastdp', /^02 2 "x via TallyBee at .*"$/)
})

// Replicata: log in, type a comment, tap 3, and Submit.
// Expectata: the datapoint's comment is what you typed, then "via TallyBee
// at" and the time.
// Resultata (before): no way to add a comment.
qual('a comment typed before Submit goes with the datapoint', async (page, bee) => {
  await login(page)
  await remark(page, 'felt strong')
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.match(posts(bee)[0].params.comment,
               /^felt strong via TallyBee at \w{3} \w{3} \d\d \d{4} /)
})

// Replicata: tap 1 and Submit, with no comment; then type a comment with
// spaces at either end, "  set 2 ", tap 1, and Submit.
// Expectata: the first datapoint's comment is just what TallyBee sent before
// there were comments, "via TallyBee at" and the time; the second's is the
// comment as typed, spaces and all, a space, and then that.
// Resultata (in the prototypes of this round, which trimmed the whole): the
// spaces at the start of the comment were cut.
qual('Beeminder gets the comment exactly as typed, and with none, exactly what it got before', async (page, bee) => {
  await page.clock.setFixedTime(new Date('2026-09-30T12:34:56Z'))
  await login(page)
  const via = 'via TallyBee at ' + await page.evaluate(() => String(new Date()))
  await tap(page, '#bigbut')
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  await remark(page, '  set 2 ')
  await tap(page, '#bigbut')
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.deepEqual(posts(bee).map(p => p.params.comment), [via, `  set 2  ${via}`])
})

// Replicata: type a comment, without pressing Enter, and the phone reloads
// the page; then open TallyBee in another window, and change the comment
// there.
// Expectata: the comment, as typed, after reloading and in the other window,
// and the other window's change in both.
// Resultata (in a mutant that saved the comment only when its field was left):
// no comment after the reload.
qual('the comment survives reloading, and all TallyBee windows share it', async page => {
  await login(page)
  await tap(page, '#comment')
  await page.keyboard.type('set 1')
  await page.reload()
  await see(page, '#goals', /pushups/)
  await see(page, '#comment', 'set 1')
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  await see(w, '#comment', 'set 1')
  await w.bringToFront()
  await remark(w, 'set 2')
  await page.bringToFront()
  await see(page, '#comment', 'set 2')
})

// Replicata: type a comment, tap 3, and Submit; then type another comment, tap
// once, and press Clear.
// Expectata: each time, the comment field empties, for the next datapoint,
// which goes without a comment.
// Resultata (in a mutant that kept the comment for the next datapoint):
// "set 1" still there after the Submit.
// SPEC CHANGE (following from the owner's answer to question 9 in AGENTS.md,
// that Clear be grayed out at 0): a tap before the Clear.
qual('Submit and Clear start the next datapoint with no comment', async (page, bee) => {
  await login(page)
  await remark(page, 'set 1')
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  await see(page, '#comment', '')
  await remark(page, 'set 2')
  await tap(page, '#bigbut')
  await clear(page) // FINAL DESIGN
  await see(page, '#comment', '')
  await tap(page, '#bigbut', 2)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.match(posts(bee)[1].params.comment, /^via TallyBee at /)
})

// Replicata: type a comment and tap 3, then press Clear by mistake. Press
// UNDO.
// Expectata: the 3 and the comment, both back.
// Resultata (in a mutant whose UNDO of a Clear left out the comment): the 3,
// with no comment.
qual('UNDO brings back a cleared comment along with the count', async page => {
  await login(page)
  await remark(page, 'felt strong')
  await tap(page, '#bigbut', 3)
  await clear(page) // FINAL DESIGN
  await see(page, '#bigbut', '0')
  await see(page, '#comment', '')
  await tap(page, '#undobut')
  await see(page, '#bigbut', '3')
  await see(page, '#comment', 'felt strong')
})

// Replicata: type "felt" and press Enter; tap the field again, type " strong"
// after it, and press Enter. Press UNDO, and UNDO again. Then make it "felt
// fine", tap the big button, and press UNDO.
// Expectata: the first UNDO takes the comment back to "felt", undoing that
// whole edit (one tap into the field, typing, and done), and the second the
// edit before it, back to no comment, and then there's nothing to undo; the
// third UNDO undoes the tap, and only the tap.
// Resultata (in a mutant whose UNDO undid only the last keystroke):
// "felt stron".
qual('UNDO undoes the last edit of the comment, whole, and only that', async page => {
  await login(page)
  await remark(page, 'felt')
  await tap(page, '#comment')
  await page.keyboard.press('End')
  await page.keyboard.type(' strong') // one keystroke at a time
  await page.keyboard.press('Enter')
  await see(page, '#comment', 'felt strong')
  await tap(page, '#undobut')
  await see(page, '#comment', 'felt')
  await tap(page, '#undobut')
  await see(page, '#comment', '')
  assert.ok(await disabled(page, '#undobut'), 'after undoing both')
  await remark(page, 'felt fine')
  await tap(page, '#bigbut')
  await tap(page, '#undobut')
  await see(page, '#bigbut', '0')
  await see(page, '#comment', 'felt fine')
})

// Replicata: tap the comment field and type "abc"; press UNDO with the field
// still focused (as in browsers where pressing a button leaves the focus
// where it was, like Safari); type "d", and press UNDO again.
// Expectata: the first UNDO empties the comment, and "d" is then undoable
// too, back to the comment as it was when the field got the focus.
// Resultata (in prototype A, where only an edit's first keystroke made it
// undoable): after the first UNDO, nothing more to undo.
qual('UNDO pressed while typing the comment leaves what is typed next undoable', async page => {
  await login(page)
  await tap(page, '#comment')
  await page.keyboard.type('abc')
  const undo = () => page.$eval('#undobut', b => b.click()) // no focus moves
  await undo()
  await see(page, '#comment', '')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'comment')
  await page.keyboard.type('d')
  await see(page, '#comment', 'd')
  assert.ok(!await disabled(page, '#undobut'))
  await undo()
  await see(page, '#comment', '')
})

// Replicata: on odometer goal pages (at 120), tap 3, type a comment, and
// Submit. Beeminder saves 123, but its reply is lost. Switch away and back,
// which refreshes the goals, now at 123. Press UNDO, which takes back the
// comment, and Submit again.
// Expectata: 123 again, as the same datapoint, updating it in place: UNDO put
// back the comment, and only the comment.
// Resultata (with UNDO putting back the whole datapoint as it was before the
// comment, as in the prototypes of this design): 126, since that datapoint
// had no base pinned to it yet.
qual('UNDO of a comment edit puts back the comment, and only the comment', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  bee.reply = lostreply(bee)
  await tap(page, '#bigbut', 3)
  await remark(page, 'oops')
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  await comeback(page)
  await see(page, '#safesum', 'safe for 4 days')
  await tap(page, '#undobut')
  await see(page, '#comment', '')
  await see(page, '#num', '123')
  bee.reply = () => null
  await tap(page, '#subbut')
  await settled(page)
  assert.deepEqual(values(bee), ['123', '123'])
  const [a, b] = posts(bee).map(p => p.params.requestid)
  assert.equal(a, b)
})

// Replicata: TallyBee in two windows. In one, type the comment "set 1", tap 3,
// and Submit, with Beeminder slow to answer; meanwhile, in the other, tap the
// comment field. Once the Submit gets there, type "x" there, press Enter, and
// press UNDO.
// Expectata: UNDO takes the comment back to none, as it was when the "x" got
// typed, "set 1" having gone with the datapoint.
// Resultata (before): "set 1" back, as the comment was when the field got the
// focus, before the Submit got there, to go with the next datapoint too.
qual("UNDO of an edit can't bring back a comment another window submitted meanwhile", async (page, bee) => {
  await login(page)
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut.then(() => null) : null
  await page.bringToFront()
  await remark(page, 'set 1')
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, 2 * LOAD + 1)
  await w.bringToFront()
  await see(w, '#comment', 'set 1')
  await tap(w, '#comment')
  open()
  await see(page, '#status', /pushups/)
  await see(w, '#comment', '')
  await w.keyboard.type('x')
  await w.keyboard.press('Enter')
  await see(w, '#comment', 'x')
  await tap(w, '#undobut')
  await see(w, '#comment', '')
})

// Replicata: type in the comment field and then, without pressing Enter, tap
// the big button; press UNDO.
// Expectata: the field lets go of the focus as the finger lands, before the
// tap counts, as the number to send does (see #num); the tap counts, as a
// change of its own, so UNDO takes back the tap and leaves the comment.
// Resultata (in a mutant that didn't end the edit as the finger landed): the
// comment field still had the focus as the tap counted.
qual('a tap on the big button ends an edit of the comment, then counts', async page => {
  await login(page)
  await tap(page, '#comment')
  await page.keyboard.type('slow')
  await page.$eval('#bigbut', b => b.addEventListener('pointerup', () => {
    window.focused = document.activeElement.id }, { capture: true }))
  await tap(page, '#bigbut')
  assert.notEqual(await page.evaluate(() => window.focused), 'comment')
  assert.equal(await count(page), 1)
  await tap(page, '#undobut')
  await see(page, '#bigbut', '0')
  await see(page, '#comment', 'slow')
})

// Replicata: type a comment, and, without pressing Enter, touch the big button
// with nose and chin at once (which makes no click); then press UNDO.
// Expectata: the touch counts, and the comment field lets go of the focus,
// which puts a phone's keyboard away and ends the edit, so that UNDO takes
// back the touch, and only the touch.
// Resultata (without the comment field letting go): it kept the focus, so
// the keyboard stayed up.
qual('a touch on the big button, even with nose and chin at once, ends an edit of the comment', async page => {
  await login(page)
  await tap(page, '#comment')
  await page.keyboard.type('felt strong')
  await touch(page, [[150, 300], [250, 350]], 50)
  assert.equal(await count(page), 1)
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'comment')
  await tap(page, '#undobut')
  await see(page, '#bigbut', '0')
  await see(page, '#comment', 'felt strong')
})

// Replicata: with the TallyBee live now (be07e32), which remembers what UNDO
// would put back as the whole pending datapoint, with no comment (there were
// none yet), tap 3. Then get this TallyBee, and press UNDO.
// Expectata: the 3, with no comment, and unfolded, and then the 2, still with
// no comment, and no error.
// Resultata (in a draft of a prototype of this design): an error at once, and
// nothing in TallyBee working, since what UNDO would put back had no comment.
qual('what TallyBee remembered before there were comments still works, UNDO and all', async page => {
  await page.goto(APP)
  await page.evaluate(() => localStorage.setItem('tallybee', JSON.stringify({
    count: 3, requestid: 'r1', pin: null,
    prev: { count: 2, requestid: 'r1', pin: null }, slug: 'pushups' })))
  await page.reload()
  await see(page, '#bigbut', '3')
  await see(page, '#comment', '')
  assert.ok(await unfolded(page))
  await tap(page, '#undobut')
  await see(page, '#bigbut', '2')
  await see(page, '#comment', '')
})

// Replicata: with the TallyBee of ce83b01, whose prev holds only what the
// last change changed (for a tap, just the count), and no comment, tap 3.
// Then get this TallyBee, and press UNDO.
// Expectata: the 3, with no comment, unfolded, and then the 2, still with no
// comment.
// Resultata (in a mutant that took a prev to be a whole pending datapoint): an
// error at once, and the remembered 3 not shown.
qual('what TallyBee remembered as a prev of just the count still works', async page => {
  await page.goto(APP)
  await page.evaluate(() => localStorage.setItem('tallybee', JSON.stringify({
    count: 3, requestid: 'r1', pin: null, prev: { count: 2 }, slug: 'pushups' })))
  await page.reload()
  await see(page, '#bigbut', '3')
  await see(page, '#comment', '')
  assert.ok(await unfolded(page))
  await tap(page, '#undobut')
  await see(page, '#bigbut', '2')
  await see(page, '#comment', '')
})

// Replicata: TallyBee from before UNDO (2369030), which remembered no prev,
// comment, or fold, left a count of 5. Open this TallyBee, and edit the
// comment, and press UNDO.
// Expectata: 5, with no comment, unfolded; and the edit undoable like any
// other.
// Resultata (in a mutant that gave what it remembered no comment of "" when it
// had none): an error at once, and the remembered 5 not shown.
qual('what TallyBee remembered before UNDO gets no comment, and is unfolded', async page => {
  await page.goto(APP)
  await page.evaluate(() => localStorage.setItem('tallybee', JSON.stringify(
    { count: 5, requestid: 'r-old', pin: null, slug: 'pushups' })))
  await page.reload()
  await see(page, '#bigbut', '5')
  await see(page, '#comment', '')
  assert.ok(await unfolded(page))
  await remark(page, 'old')
  await tap(page, '#undobut')
  await see(page, '#comment', '')
  assert.equal(await count(page), 5)
})

// Replicata: what TallyBee remembers gets broken (by a bug, say): its comment
// isn't text, or whether the footer is folded isn't true or false, or what
// UNDO would put back as the comment isn't text. Open TallyBee.
// Expectata: each time, an error saying so.
// Resultata (before): no error.
for (const [what, broken] of [['comment', { comment: 5 }], ['fold', { folded: 'yes' }],
                              ["UNDO's comment", { prev: { comment: null } }],
                              ["UNDO's count", { prev: undefined, undos: [{ count: 'two' }] }]])
  qual(`a broken memory of the ${what} fails loudly`, async (page, bee) => {
    await page.goto(APP)
    await page.evaluate(b => localStorage.setItem('tallybee', JSON.stringify({
      count: 3, requestid: 'r1', pin: null, comment: '', prev: null, slug: null,
      folded: false, ...b })), broken)
    await page.reload()
    await see(page, '#status', /^Error: .*"count":3/)
    await expectError(page, bee, /"count":3/)
    // and the error from then showing the rest of the page, which can't be
    // done with script.js stopped partway
    await expectError(page, bee, /before initialization/)
  })

// Replicata: something puts text in the comment field without its ever
// getting the focus (like a browser extension filling it in).
// Expectata: an error saying that the edit had no start, changing nothing.
// Resultata (in a mutant that took an edit with no start to start from no
// comment): no error.
qual('an edit of the comment with no start fails loudly, changing nothing', async (page, bee) => {
  await login(page)
  await page.$eval('#comment', c => {
    c.value = 'sneaky'
    c.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await see(page, '#status', /^Error: .*before/)
  await expectError(page, bee, /before/)
  assert.equal(JSON.parse(await page.evaluate(() =>
    localStorage.getItem('tallybee'))).comment, '')
})

// Replicata: edit the comment to "a" (tap the field, type, press Enter); then
// something puts text in the field without its getting the focus again.
// Expectata: an error saying that the edit had no start, changing nothing,
// just as for such an edit before any other.
// Resultata (before): no error; the text became the comment, and UNDO then
// put back the comment from before "a", two edits back.
qual('an edit of the comment with no start fails loudly, even after an earlier edit', async (page, bee) => {
  await login(page)
  await remark(page, 'a')
  await page.$eval('#comment', c => {
    c.value = 'sneaky'
    c.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await see(page, '#status', /^Error: .*before/)
  await expectError(page, bee, /before/)
  assert.equal(JSON.parse(await page.evaluate(() =>
    localStorage.getItem('tallybee'))).comment, 'a')
})

// Replicata: tap once, and press UNDO; then something puts text in the
// comment field without its getting the focus.
// Expectata: an error saying that the edit had no start, changing nothing,
// just as for such an edit before any other.
// Resultata (in a mutant whose UNDO, pressed with no edit under way, took one
// to have started): no error; the text became the comment.
qual('an edit of the comment with no start fails loudly, even after an UNDO', async (page, bee) => {
  await login(page)
  await tap(page, '#bigbut')
  await tap(page, '#undobut')
  await see(page, '#bigbut', '0')
  await page.$eval('#comment', c => {
    c.value = 'sneaky'
    c.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await see(page, '#status', /^Error: .*before/)
  await expectError(page, bee, /before/)
  assert.equal(JSON.parse(await page.evaluate(() =>
    localStorage.getItem('tallybee'))).comment, '')
})

// Replicata: tap 3 and Submit, with Beeminder slow to answer, and look at the
// comment field.
// Expectata: grayed out, like Clear, till Beeminder answers, since the
// comment going is the one there when Submit was pressed.
// Resultata (in a mutant that never grayed it out): usable while the datapoint
// was on its way.
qual('the comment field is grayed out while Beeminder takes the datapoint', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  assert.ok(await disabled(page, '#comment'))
  assert.ok(await opacity(page, '#comment') < 0.5)
  open(null)
  await see(page, '#bigbut', '0')
  assert.ok(!await disabled(page, '#comment'))
})

// Replicata: type "first", and Submit while a refresh of the goals holds it
// up (as when you come back to TallyBee); before it goes, change the comment
// to "second" in another window.
// Expectata: "first" goes: the comment as it was when Submit was pressed.
// Resultata (in a mutant that read the comment when the Submit's turn came):
// "second" went.
qual('Submit sends the comment as it was when pressed, even while waiting its turn', async (page, bee) => {
  await login(page)
  await remark(page, 'first')
  const [shut, open] = gate()
  bee.reply = c => c.method === 'GET' ? shut.then(() => null) : null
  await comeback(page)
  await calls(page, bee, LOAD + 2)
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  const w = await window2(page, APP)
  await w.bringToFront()
  await remark(w, 'second')
  await page.bringToFront()
  await see(page, '#comment', 'second')
  open()
  await see(page, '#bigbut', '0')
  assert.match(posts(bee)[0].params.comment, /^first via TallyBee at /)
})

// Replicata: on a phone, type a comment, and press the keyboard's done key.
// Expectata: the field lets go of the focus, which puts the keyboard away, so
// there's no need to tap the big button (which would count) to put it away.
// Resultata (in a mutant with no blur at Enter): the field kept the focus,
// which keeps a phone's keyboard up.
qual("Enter, the phone keyboard's done key, puts the comment away", async page => {
  await login(page)
  assert.equal(await page.getAttribute('#comment', 'enterkeyhint'), 'done')
  await tap(page, '#comment')
  await page.keyboard.type('felt strong')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'comment')
  await page.keyboard.press('Enter')
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'comment')
  await see(page, '#comment', 'felt strong')
  assert.equal(await count(page), 0)
})

// Replicata: type a comment with a keyboard that composes words before they
// go in (like a Japanese one), and press Enter to settle on a word.
// Expectata: that Enter only settles the word: the field keeps the focus, and
// the keyboard stays up.
// Resultata (in a mutant that put the field away at any Enter): it lost the
// focus, mid-word.
qual("the Enter that settles a composed word doesn't put the comment away", async page => {
  await login(page)
  await tap(page, '#comment')
  const cdp = await page.context().newCDPSession(page)
  for (const d of ['k', 'ka', 'かん'])
    await cdp.send('Input.imeSetComposition', { text: d, selectionStart: d.length,
                                                selectionEnd: d.length })
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'comment')
})

// Replicata: type "hello" in the comment field, move the cursor back 3
// characters, and type "XY".
// Expectata: "heXYllo": each keystroke gets saved (see script.js) without
// moving the cursor.
// Resultata (in a mutant that, at each keystroke, set the field's text to
// something else and back, which puts the cursor at the end): "heXlloY".
qual('typing in the middle of the comment leaves the cursor there', async page => {
  await login(page)
  await tap(page, '#comment')
  await page.keyboard.type('hello')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('XY')
  assert.equal(await page.inputValue('#comment'), 'heXYllo')
})

// Replicata: on an Android phone, whose keyboard types each word as a
// "composition" (underlined till it's done), type "hello world" as the
// comment.
// Expectata: "hello world", saved as that, with each word one composition.
// Resultata (in a draft, as it could be): saving each keystroke ended the
// composition, so each letter became a word of its own.
qual('a keyboard that types a word at a time gets the comment right', async page => {
  await login(page)
  await tap(page, '#comment')
  await page.$eval('#comment', c => { window.starts = 0
    c.addEventListener('compositionstart', () => window.starts++) })
  const cdp = await page.context().newCDPSession(page)
  for (const [word, drafts] of [['hello', ['h', 'he', 'hel', 'hell']],
                                [' world', [' w', ' wo', ' wor', ' worl']]]) {
    for (const d of [...drafts, word])
      await cdp.send('Input.imeSetComposition', { text: d, selectionStart: d.length,
                                                  selectionEnd: d.length })
    await cdp.send('Input.insertText', { text: word })
  }
  assert.equal(await page.inputValue('#comment'), 'hello world')
  assert.equal(await page.evaluate(() => window.starts), 2)
  assert.equal(await page.evaluate(() =>
    JSON.parse(localStorage.getItem('tallybee')).comment), 'hello world')
})

// Replicata: on a computer, click the comment field, type "a b", and press
// Enter.
// Expectata: the comment is "a b", and nothing counted.
// Resultata (in a mutant that counted Space and Enter anywhere on the page):
// 2.
qual("Space and Enter in the comment field don't count", async page => {
  await login(page)
  await page.click('#comment')
  await page.keyboard.type('a b')
  await page.keyboard.press('Enter')
  await see(page, '#comment', 'a b')
  assert.equal(await count(page), 0)
}, DESK)

// Replicata: on a computer, click the big button; press Tab from there, past
// Clear and the day, to the comment field, type "abc", and press Enter; then
// click UNDO.
// Expectata: "abc" saved as the comment, with no error, and UNDO taking it
// back to empty: an edit starts when the field gets the focus, however it
// gets it.
// Resultata (in a mutant of this build that took an edit's start from a
// touch or click on the field): an error at each keystroke, each of which
// emptied the field again.
// SPEC CHANGE (following from the owner's answer to question 9 in AGENTS.md,
// that Clear be grayed out at 0, which takes it out of the Tab order): a click
// on the big button first, rather than just giving it the focus, so that
// there's a tally for Clear to clear.
qual('a comment typed after tabbing to its field is saved, and undoable', async page => {
  await login(page)
  await page.click('#bigbut')
  // FINAL DESIGN: 2 Tabs, with Clear in the menu
  for (let i = 0; i < 2; i++) await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'comment')
  await page.keyboard.type('abc')
  await page.keyboard.press('Enter')
  await see(page, '#comment', 'abc')
  assert.equal(JSON.parse(await page.evaluate(() =>
    localStorage.getItem('tallybee'))).comment, 'abc')
  await page.click('#undobut')
  await see(page, '#comment', '')
}, DESK)

// Replicata: on an iPhone, tap the comment field; or find it with a screen
// reader.
// Expectata: no zooming in (iPhones zoom in on text smaller than 16px); a
// field at least 44px tall, for fingers, shaped like the buttons, a capsule;
// and a name, and a placeholder.
// Resultata (in a mutant with 14px text in the field): 14px.
qual('the comment field is a 44px capsule, with 16px text, and a name', async page => {
  await login(page)
  const f = await page.$eval('#comment', e => ({ px: parseFloat(getComputedStyle(e).fontSize),
    radius: getComputedStyle(e).borderRadius, ...e.getBoundingClientRect().toJSON() }))
  assert.ok(f.height >= 44 && f.px >= 16, JSON.stringify(f))
  assert.equal(f.radius, await page.$eval('#undobut', e => getComputedStyle(e).borderRadius))
  for (const attr of ['aria-label', 'placeholder'])
    assert.match(await page.getAttribute('#comment', attr) ?? '', /^\p{L}{2,}/u, attr)
  assert.equal(await page.getByRole('textbox', { exact: true,
    name: await page.getAttribute('#comment', 'aria-label') }).count(), 1)
})

// Replicata: on an iPhone, tap the comment field, or the number to send, and
// type.
// Expectata: the fields take the typing, and selecting their text, as fields
// do (user-select: text). iPhones are said not to let you type in a field that
// can't be selected (untried here: these quals run Chrome only).
// Resultata (before): the fields got user-select: none, from the buttons'
// style.
qual('the text fields can be typed in and selected, even on iPhones', async page => {
  await login(page)
  for (const sel of ['#comment', '#num'])
    assert.deepEqual(await page.$eval(sel, e => [getComputedStyle(e).userSelect,
      getComputedStyle(e).webkitUserSelect]), ['text', 'text'], sel)
})

// Replicata: look at the comment's row, on a phone.
// Expectata: the day at the row's left edge; the comment field taking all the
// room the day and the ? leave, from 8px after the day to 8px short of the ?,
// at the row's right edge.
// Resultata (in a mutant whose field didn't grow): a field 201px wide, the ?
// beside it, and the rest of the row empty.
qual("the comment field fills its row, but for the day and the ?", async page => {
  await login(page)
  const [d, c, q, row] = [await box(page, '#day'), await box(page, '#comment'),
                          await box(page, '#infobut'), await box(page, '#drawer > :last-child')]
  assert.ok(d.x === row.x && d.x + d.width + 8 === c.x && c.x + c.width + 8 === q.x &&
            q.x + q.width === row.x + row.width, JSON.stringify([d, c, q, row]))
})

// Replicata: open TallyBee on a slow connection, and type in the comment field
// before it's done loading.
// Expectata: the field grayed out till then, like the dropdown and Submit, so
// that nothing typed there gets lost when TallyBee shows what it remembers.
// Resultata (in a mutant of index.html whose field started out usable): usable
// before script.js ran.
qual('the comment field starts out grayed out, before script.js runs', async page => {
  const [shut, open] = gate()
  await page.route(APP + 'script.js', r => shut.then(() => serve(r)))
  await page.goto(APP, { waitUntil: 'commit' })
  await page.waitForSelector('#comment', { state: 'attached' })
  assert.ok(await disabled(page, '#comment'))
  open()
})

// ------------------------------------------------------------------ goals

// Replicata: log in, which selects pushups, and then pick pages.
// Expectata: the selected goal's safesum, Beeminder's summary of what's due:
// "+2 pushups due by 12am", and then "safe for 3 days".
// Resultata (in a mutant that never showed it): nothing.
qual("the selected goal's safesum is shown", async page => {
  await login(page)
  await see(page, '#safesum', '+2 pushups due by 12am')
  await choose(page, 'pages')
  await see(page, '#safesum', 'safe for 3 days')
})

// Run the page's clock (see page.clock.install) in steps, letting the page
// answer each step, till the fake Beeminder has had n calls
async function runtill(page, bee, n) {
  for (let i = 0; i < 40 && bee.calls.length < n; i++) {
    await page.clock.runFor(250)
    await page.waitForTimeout(25)
  }
  await calls(page, bee, n)
}

// Replicata: pushups says "+2 pushups due by 12am". Tap 2 and Submit.
// Beeminder takes a while to update the goal.
// Expectata: the old safesum, grayed out at once, and for as long as Beeminder
// is updating the goal, and then the new one, like "safe for 1 day", and no
// more calls to Beeminder.
// Resultata (before): the old one, not grayed out, as if nothing had been
// submitted, till you left TallyBee and came back.
qual('the safesum catches up after a submission', async (page, bee) => {
  await page.clock.install()
  await login(page)
  // Like the real Beeminder, which updates a goal after it gets a datapoint
  bee.reply = c => { if (c.method === 'POST') bee.goals[0].queued = true
                     return null }
  const gray = async () => await opacity(page, '#safesum') < 0.5
  await tap(page, '#bigbut', 2)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.ok(await gray(), 'grayed out at once')
  await runtill(page, bee, 2 * LOAD + 1) // the goals again, still being updated
  await settled(page)
  assert.equal(await page.textContent('#safesum'), '+2 pushups due by 12am')
  assert.ok(await gray(), 'grayed out while Beeminder updates the goal')
  bee.goals[0].queued = false
  bee.goals[0].safesum = 'safe for 1 day'
  await runtill(page, bee, 3 * LOAD + 1)
  await see(page, '#safesum', 'safe for 1 day')
  assert.ok(!await gray())
  await page.clock.runFor(60000)
  await settled(page)
  assert.equal(bee.calls.length, 3 * LOAD + 1, 'more calls after the goal was updated')
})

// Replicata: tap 2 and Submit. While Beeminder takes a while to update the
// goal, leave TallyBee and come back, twice.
// Expectata: TallyBee asks Beeminder for the goals again 2 seconds after the
// Submit (as Beeminder takes at least that long to update the goal), and every
// 2 seconds after, and when you come back.
// Resultata (in a draft of this round): it asked right away, and each time you
// came back started another round of asking every 2 seconds.
qual('while Beeminder updates the goal, TallyBee asks about it every 2 seconds', async (page, bee) => {
  await page.clock.install()
  await login(page)
  bee.reply = c => { if (c.method === 'POST') bee.goals[0].queued = true
                     return null }
  await tap(page, '#bigbut', 2)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  await settled(page)
  // (the goals' load, and the datapoint)
  assert.equal(bee.calls.length, LOAD + 1, 'asked right away')
  await comeback(page)
  await comeback(page)
  await calls(page, bee, 3 * LOAD + 1)
  await settled(page)
  for (const n of [4 * LOAD + 1, 5 * LOAD + 1]) {
    await page.clock.runFor(2000)
    await calls(page, bee, n)
    await settled(page) // for any more that might come
    assert.equal(bee.calls.length, n, JSON.stringify(bee.calls.map(c => c.path)))
  }
})

// Replicata: tap 3 and Submit. 2 seconds later, while TallyBee is loading the
// goals (and Beeminder is slow), tap twice by mistake, press Clear, and tap 5
// more times.
// Expectata: 5.
// Resultata (in a draft of this round): Clear waited for the goals, so the
// count went to 7, and then, when the goals came, to 0.
qual('Clear clears at once, even while the goals are loading', async (page, bee) => {
  await page.clock.install()
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'GET' ? shut.then(() => null) : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  await runtill(page, bee, LOAD + 3) // the goals and the user, asked for at once
  await tap(page, '#bigbut', 2)
  await clear(page) // FINAL DESIGN
  await see(page, '#bigbut', '0')
  await tap(page, '#bigbut', 5)
  open()
  await settled(page)
  await see(page, '#bigbut', '5')
})

// Replicata: pick pages; switch to another tab and back; then open TallyBee's
// plain URL, which names no goal.
// Expectata: pages, each time.
// Resultata (in a mutant that didn't remember the goal selected last):
// pushups, the most urgent goal, at the plain URL.
qual('the selected goal is remembered', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  bee.goals[1].safesum = 'safe for 2 days'
  await comeback(page)
  await see(page, '#safesum', 'safe for 2 days') // refreshed, still on pages
  assert.equal(await page.inputValue('#goals'), 'pages')
  await page.goto(APP) // with no goal in the URL
  await see(page, '#safesum', 'safe for 2 days')
  assert.equal(await page.inputValue('#goals'), 'pages')
})

// Replicata: log in; pushups' safesum changes on Beeminder; switch to another
// tab and back.
// Expectata: the new safesum.
// Resultata (in a mutant that loaded the goals only as the page loaded): the
// old one.
qual('goals get refreshed when you come back to the page', async (page, bee) => {
  await login(page)
  bee.goals[0].safesum = '+0 due by 11:59pm'
  await comeback(page)
  await see(page, '#safesum', '+0 due by 11:59pm')
})

// Replicata: logged in, open TallyBee with no connection (as the service
// worker lets you: see sw.js), with pushups' safesum changed on Beeminder
// since; then get the connection back.
// Expectata: an error, as the goals can't load (meanwhile, the goals as they
// last loaded in the tab: see goals in script.js), and then, as soon as the
// connection is back, the goals as they are now.
// Resultata (before the tab kept its goals): no goals at all till then; and
// before that, none till you left TallyBee and came back to it.
qual('the goals load as soon as the connection comes back', async (page, bee) => {
  await login(page)
  // (The routes serve TallyBee itself even offline, as the service worker
  // would, so it's the fake Beeminder that has to be out of reach.)
  await page.context().setOffline(true)
  bee.reply = () => 'abort'
  bee.goals[0].safesum = 'safe for 2 days'
  await page.reload()
  await see(page, '#status', /Error/)
  await expectError(page, bee, /fetch/i)
  assert.equal(await page.textContent('#safesum'), '+2 pushups due by 12am')
  bee.reply = () => null
  await page.context().setOffline(false)
  await see(page, '#safesum', 'safe for 2 days')
})

// Replicata: a new Beeminder user, with no goals yet, logs in to TallyBee, then
// makes a goal on Beeminder's site and comes back.
// Expectata: the new goal is selected.
// Resultata (before): no goal selected, and no way to submit till you pick one.
qual('an account with no goals gets its first goal selected once it has one', async (page, bee) => {
  bee.goals = []
  const state = await authorize(page)
  await page.goto(`${APP}?` +
    new URLSearchParams({ access_token: TOKEN, username: 'alice', state }))
  await calls(page, bee, 2) // the goals and the user, with no goal to ask about
  bee.goals = structuredClone(GOALS)
  await comeback(page)
  await see(page, '#goals', /pushups/)
  assert.equal(await page.inputValue('#goals'), 'pushups')
})

// Replicata: log in; pick pages; and, logged out, look at the goal's link (the
// ↗ beside the dropdown).
// Expectata: a link to the goal's page on Beeminder, opening apart from
// TallyBee: beeminder.com/alice/pushups, then /alice/pages; logged out, no
// link, grayed out.
// Resultata (before): no link to the goal.
qual("the ↗ beside the dropdown links to the goal's page on Beeminder", async page => {
  await page.goto(APP)
  assert.equal(await page.getAttribute('#goallink', 'href'), null)
  await login(page)
  const link = () => page.$eval('#goallink', a => [a.href, a.target])
  assert.deepEqual(await link(), ['https://www.beeminder.com/alice/pushups', '_blank'])
  await choose(page, 'pages')
  assert.deepEqual(await link(), ['https://www.beeminder.com/alice/pages', '_blank'])
})

// Replicata: on pushups, tap 3; pick pages, an odometer goal at 120, with
// Beeminder slow to answer, watching the big number.
// Expectata: 3, then 123, the reading, and nothing else in between, as the
// tab remembers the goals as they last loaded, till they load again.
// Resultata (before): 0, from index.html, then 3, the count with no goal to
// build on, before 123.
qual('picking a goal shows no number in between', async (page, bee) => {
  await page.context().addInitScript(() => {
    window.counts = [] // each number the big button shows, in turn
    new MutationObserver(() => {
      const c = document.getElementById('count')?.textContent
      if (c && c !== window.counts.at(-1)) window.counts.push(c)
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
  await login(page)
  await tap(page, '#bigbut', 3)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'GET' ? shut.then(() => null) : null
  await page.selectOption('#goals', 'pages')
  await page.waitForURL(APP + '?goal=pages')
  await see(page, '#bigbut', '123')
  open()
  await settled(page)
  assert.deepEqual(await page.evaluate(() => window.counts), ['123'])
})

// Replicata: pick pages in the dropdown, on a slow connection.
// Expectata: right away, the infinibee, and the footer grayed out, till pages'
// page comes.
// Resultata (before): nothing changed till then, so that TallyBee looked
// frozen, or broken.
qual('picking a goal shows the infinibee, and grays out the footer, till it comes', async page => {
  await login(page)
  // Picked, and looked at at once, in the page, before its next page comes
  // (selectOption would wait for that)
  const ids = ['goals', 'subbut', 'num', 'comment', 'clearbut']
  const seen = await page.$eval('#goals', (s, ids) => {
    s.value = 'pages'
    s.dispatchEvent(new Event('change'))
    return [!document.getElementById('infinibee').hidden,
            ...ids.map(id => document.getElementById(id).disabled)]
  }, ids)
  assert.deepEqual(seen, [true, ...ids.map(() => true)], JSON.stringify(['infinibee', ...ids]))
  await page.waitForURL(APP + '?goal=pages')
  await see(page, '#safesum', 'safe for 3 days')
  assert.ok(!await page.isVisible('#infinibee'))
})

// Replicata: look at the dropdown, on a phone, and on a computer.
// Expectata: never wider than the longest goal name there can be, 20
// characters, and its padding. Characters as CSS measures them, that is: 20ch,
// 20 times the width of a 0 in the dropdown's font.
// Resultata (before): as wide as all the room the rest of its row left: 1066px
// on a computer.
// (This measured 20 zeros drawn on a canvas, which, by CSS's definition of ch,
// "the used advance measure of the "0" (ZERO, U+0030) glyph in the font used to
// render it" (w3.org/TR/css-values-4), is 20ch too. But not in Chrome 154 on
// macOS, in its system font: there, at 16px, 20ch is 201.56px, and 20 zeros,
// drawn on a canvas or on the page, 195.31px. So it failed there, by 6px,
// with style.css capping the dropdown at 20ch.)
for (const [width, height, opts] of [[390, 844], [1280, 800, DESK]])
  qual(`the dropdown is no wider than a goal's name can be (${width}x${height})`, async page => {
    await login(page)
    const [w, most] = await page.$eval('#goals', e => {
      const s = getComputedStyle(e), d = document.createElement('div')
      Object.assign(d.style, { width: '20ch', fontStyle: s.fontStyle,
        fontWeight: s.fontWeight, fontSize: s.fontSize, fontFamily: s.fontFamily })
      document.body.append(d)
      const ch20 = d.getBoundingClientRect().width
      d.remove()
      return [e.getBoundingClientRect().width, ch20 +
        ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
          .reduce((a, p) => a + parseFloat(s[p]), 0)]
    })
    assert.ok(w <= most + 0.5, `${w}px, over ${most}px`)
  }, { ...opts, viewport: { width, height } })

// ------------------------------------------------------------- goal links

// Replicata: log in, which selects pushups, and so remembers it; then open
// tallybee.beeminder.com/?goal=pages.
// Expectata: pages.
// Resultata (in a mutant that put the goal selected last before the link's):
// pushups.
qual('a link to a goal, like tallybee.beeminder.com/?goal=pages, selects it', async page => {
  await login(page) // which selects, and so remembers, pushups
  await page.goto(APP + '?goal=pages')
  await see(page, '#safesum', 'safe for 3 days')
  assert.equal(await page.inputValue('#goals'), 'pages')
})

// Replicata: pick pages in the dropdown.
// Expectata: TallyBee at tallybee.beeminder.com/?goal=pages, and loaded from
// that URL, so that a bookmark, or an app installed from the page, opens
// pages.
// Resultata (in a mutant that only changed the URL in the address bar): the
// page as loaded from tallybee.beeminder.com/, which names no goal.
qual('picking a goal puts it in the URL, for bookmarks and home-screen icons', async page => {
  await login(page)
  await choose(page, 'pages')
  assert.equal(page.url(), APP + '?goal=pages')
  // The page was loaded from that URL, so an app installed from it opens it
  assert.equal(await page.evaluate(() =>
    performance.getEntriesByType('navigation')[0].name), APP + '?goal=pages')
})

// Replicata: logged out, open tallybee.beeminder.com/?goal=pages, and log in
// (Beeminder sends you back to TallyBee's plain URL).
// Expectata: pages, selected, and in the URL.
// Resultata (in a mutant that remembered a page's goal only once the goals had
// loaded): pushups, the goal from the link forgotten on the way to Beeminder.
qual('a link to a goal survives logging in', async page => {
  await page.goto(APP + '?goal=pages')
  await login(page) // Beeminder sends us back to the URL without the goal
  await see(page, '#safesum', 'safe for 3 days')
  assert.equal(page.url(), APP + '?goal=pages')
})

// Replicata: log in at tallybee.beeminder.com (which selects pushups), open
// ?goal=pages in another tab, then reload the first tab, as phones do to tabs
// in the background.
// Expectata: still pushups.
// Resultata (before): pages, the goal the other tab left as the one selected
// last, since the first tab's URL named no goal.
qual('a page keeps its goal when reloaded, whatever other tabs select', async page => {
  await login(page)
  assert.equal(page.url(), APP + '?goal=pushups')
  const w = await window2(page, APP + '?goal=pages')
  await see(w, '#safesum', 'safe for 3 days')
  await page.bringToFront()
  await page.reload()
  await see(page, '#goals', /pushups/)
  assert.equal(await page.inputValue('#goals'), 'pushups')
})

// Replicata: make a home-screen icon for goal "pages", then rename the goal.
// Expectata: the icon opens TallyBee with no goal selected, rather than some
// other goal that a pushup count could get submitted to by mistake, and an
// error naming the goal it's for.
// Resultata (in a mutant that fell back to the first goal): pushups selected.
// SPEC CHANGE (per the owner's "Yes, always fail loudly." to question 14 in
// AGENTS.md): this was "a link to a goal you do not have selects no goal", with
// no error.
qual('a link to a goal you do not have selects no goal, and fails loudly', async (page, bee) => {
  await login(page)
  await page.goto(APP + '?goal=nosuchgoal')
  await see(page, '#status', /^Error: .*nosuchgoal/)
  await expectError(page, bee, /nosuchgoal/)
  await see(page, '#goals', /pushups/)
  assert.equal(await page.inputValue('#goals'), '')
  await tap(page, '#bigbut')
  assert.ok(await disabled(page, '#subbut'))
})

// Replicata: open TallyBee at a goal's URL, like ?goal=pages, and install it
// as an app (or add it to the home screen).
// Expectata: an app named for the goal, "pages", that opens pages.
// Resultata (before): an app named "TallyBee".
qual("an app installed from a goal's page is named for the goal, and opens it", async page => {
  await page.goto(APP + '?goal=pages')
  const { json, parsed } = await appManifest(page)
  assert.deepEqual([parsed.name, json.short_name, parsed.startUrl, parsed.id],
                   ['pages', 'pages', APP + '?goal=pages', APP + '?goal=pages'])
})

// Replicata: log in for the first time, which loads TallyBee at its plain URL
// and then, once the goals load, selects the first goal, pushups, putting it in
// the URL; install it.
// Expectata: an app for pushups.
// Resultata (before): an app named "TallyBee" that opened TallyBee's plain URL,
// and so whichever goal was selected last, since Chrome on Android reads the
// manifest as soon as the page loads, before the goals do, and keeps it.
qual('an app installed right after logging in is for the goal selected', async (page, bee) => {
  const [shut, open] = gate()
  bee.reply = c => c.method === 'GET' ? shut.then(() => null) : null
  const state = await authorize(page)
  await page.goto(`${APP}?` +
    new URLSearchParams({ access_token: TOKEN, username: 'alice', state }))
  await page.waitForURL(APP)
  await appManifest(page) // as Chrome on Android does when the page loads
  open()
  await see(page, '#goals', /pushups/)
  assert.equal(page.url(), APP + '?goal=pushups')
  const { json, parsed } = await appManifest(page)
  assert.deepEqual([parsed.name, json.short_name, parsed.startUrl, parsed.id],
                   ['pushups', 'pushups', APP + '?goal=pushups', APP + '?goal=pushups'])
})

// Replicata: open TallyBee, and look for its app manifest: in the HTML as it
// comes, and in the page once script.js has run.
// Expectata: none in the HTML, and one in the page. Safari reads only the
// first app manifest a page has, so the page starts with none, till script.js
// adds the one for the page's goal.
// Resultata (in a mutant with be07e32's link to manifest.webmanifest back in
// index.html): a manifest in the HTML.
qual("the page starts with no app manifest, so that Safari reads its goal's", async page => {
  await page.goto(APP)
  const html = await page.evaluate(async u => (await fetch(u)).text(), APP)
  assert.doesNotMatch(html, /<link[^>]*manifest/)
  assert.equal(await page.locator('link[rel=manifest]').count(), 1)
})

// ----------------------------------------------------- icons and previews

// Replicata: open TallyBee at a goal's URL, and ask Chrome whether it can be
// installed as an app.
// Expectata: no complaint.
// Resultata (in a mutant whose app manifest asked to open in a browser tab):
// "manifest-display-not-supported".
// Chrome won't install apps in the private-browsing profiles the other quals
// use, nor from pages we serve ourselves under someone else's https URL. So
// this one serves this directory at http://localhost (which Chrome trusts like
// https) to Chrome with a throwaway ordinary profile.
test('Chrome has no complaint about TallyBee as an app', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tallybee-quals-'))
  const context = await chromium.launchPersistentContext(dir, { channel: 'chrome' })
  try {
    await localhost(async url => {
      const page = await context.newPage()
      await page.goto(url + '?goal=pages')
      const cdp = await context.newCDPSession(page)
      const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
      assert.deepEqual(installabilityErrors.map(e => e.errorId), [])
    })
  } finally {
    await context.close()
    rmSync(dir, { recursive: true })
  }
})

// ------------------------------------------------------- with no connection

// Wait, up to WAIT ms, for a service worker to be ready to answer for the page
// (see sw.js)
const ready = page => page.waitForFunction(
  () => navigator.serviceWorker.ready.then(() => true), null, { timeout: WAIT })

// Replicata: open TallyBee, then lose the connection (say, in a gym's
// basement), and open it again.
// Expectata: it opens, looking as it does online, and counts.
// Resultata (before): the browser's own page saying there's no internet.
test('after one visit, TallyBee opens and counts with no connection', async () => {
  const context = await browser.newContext({ viewport: PHONE, hasTouch: true,
                                             isMobile: true })
  try {
    await localhost(async url => {
      const page = await context.newPage()
      await page.goto(url + '?goal=pushups')
      await ready(page)
      await context.setOffline(true)
      await page.reload()
      await page.tap('#bigbut')
      assert.equal(await page.textContent('#bigbut'), '1')
      const { height } = await box(page, '#bigbut') // styled: most of the screen
      assert.ok(height > PHONE.height / 2, `the big button is ${height}px tall`)
    })
  } finally { await context.close() }
})

// Replicata: open TallyBee at pages and at pushups, from GitHub Pages, which
// lets browsers keep each file for 10 minutes; a new version of TallyBee gets
// published; pick pushups again, which loads its page again.
// Expectata: the new version, page and script both, right away.
// Resultata (before): the old page, as kept by the browser, and so, once the
// script it kept was out of date and got fetched again, the old page with the
// new script, which looks for things the old page doesn't have: "can't access
// property "addEventListener", $(...) is null".
test('a new version, published from GitHub Pages, opens whole, right away', async () => {
  let version = 1
  const context = await browser.newContext()
  try {
    await localhost(async url => {
      const page = await context.newPage()
      await page.goto(url + '?goal=pages')
      await ready(page)
      await page.goto(url + '?goal=pushups') // now with the service worker answering
      await page.goto(url + '?goal=pages')
      const versions = () => page.evaluate(() =>
        [document.title, document.documentElement.dataset.script])
      assert.deepEqual(await versions(), ['TallyBee 1', '1'])
      version = 2
      await page.goto(url + '?goal=pushups')
      assert.deepEqual(await versions(), ['TallyBee 2', '2'])
    }, (path, body) => path.endsWith('index.html')
      ? String(body).replace('<title>TallyBee</title>', `<title>TallyBee ${version}</title>`)
      : path.endsWith('script.js')
      ? `${body}\ndocument.documentElement.dataset.script = ${version}\n`
      : body,
    { 'cache-control': 'max-age=600' }) // as GitHub Pages sends
  } finally { await context.close() }
})

// Replicata: open TallyBee; a new version of TallyBee gets published; open it
// again.
// Expectata: the new version, right away.
// Resultata (with a service worker that answers from its copies first): the
// old version, till the time after.
test('online, TallyBee always opens its newest version', async () => {
  let version = 1
  const context = await browser.newContext()
  try {
    await localhost(async url => {
      const page = await context.newPage()
      await page.goto(url)
      await ready(page)
      await page.reload() // now with the service worker answering
      assert.equal(await page.title(), 'TallyBee 1')
      version = 2
      await page.reload()
      assert.equal(await page.title(), 'TallyBee 2')
    }, (path, body) => path.endsWith('index.html')
      ? String(body).replace('<title>TallyBee</title>', `<title>TallyBee ${version}</title>`)
      : body)
  } finally { await context.close() }
})

// Every copy the service worker keeps (see sw.js): its URL, and its text
const copies = page => page.evaluate(async () => (await Promise.all(
  (await caches.keys()).map(async n => { const c = await caches.open(n)
    return Promise.all((await c.keys()).map(async r =>
      ({ url: r.url, text: await (await c.match(r)).text() }))) }))).flat())

// Wait up to WAIT ms for the service worker to have kept a copy with text in
// it
async function kept(page, text) {
  assert.ok(await till(page, async () => (await copies(page)).some(c => c.text.includes(text))),
            `no copy with ${JSON.stringify(text)} in it`)
}

// Replicata: open TallyBee at a goal; a new version of TallyBee gets
// published; open it again; then lose the connection and open it once more.
// Expectata: the new version, page and script both.
// Resultata (before): the version from the first visit, since the service
// worker never managed to update its copies.
test('offline, TallyBee opens the version it last opened online', async () => {
  let version = 1
  const context = await browser.newContext()
  try {
    await localhost(async url => {
      const page = await context.newPage()
      await page.goto(url + '?goal=pushups')
      await ready(page)
      version = 2
      await page.reload() // now with the service worker answering
      assert.equal(await page.title(), 'TallyBee 2')
      await kept(page, '<title>TallyBee 2</title>')
      await kept(page, 'window.version = 2')
      await context.setOffline(true)
      await page.reload()
      assert.deepEqual([await page.title(), await page.evaluate(() => window.version)],
                       ['TallyBee 2', 2])
    }, (path, body) => path.endsWith('index.html')
      ? String(body).replace('<title>TallyBee</title>', `<title>TallyBee ${version}</title>`)
      : path.endsWith('script.js') ? `${body}\nwindow.version = ${version}\n` : body)
  } finally { await context.close() }
})

// Replicata: with the service worker on, log in, which means Beeminder sends
// you back to TallyBee with your access token in the URL.
// Expectata: the service worker keeps no copy under that URL. (TallyBee takes
// the token out of the page's URL right away: see autoLogin.)
// Resultata (in a mutant of sw.js that kept each copy under its whole URL): a
// copy under the URL with the token in it.
test('the service worker keeps no URL with an access token in it', async () => {
  let version = 1
  const context = await browser.newContext()
  try {
    await localhost(async url => {
      const page = await context.newPage()
      await page.goto(url)
      await ready(page)
      version = 2
      await page.goto(url + '?' + new URLSearchParams({ access_token: 'SECRET',
                                                       username: 'alice', state: 'x' }))
      await kept(page, '<title>TallyBee 2</title>') // under whatever URL
      const urls = (await copies(page)).map(c => c.url)
      assert.ok(urls.length > 0 && urls.every(u => !u.includes('SECRET')),
                JSON.stringify(urls))
    }, (path, body) => path.endsWith('index.html')
      ? String(body).replace('<title>TallyBee</title>', `<title>TallyBee ${version}</title>`)
      : body)
  } finally { await context.close() }
})

// Replicata: with the service worker on, logged in, open TallyBee, which asks
// Beeminder for the goals; then lose the connection, and open it again.
// Expectata: Beeminder's answer goes straight to the page, around the service
// worker, which keeps copies only of TallyBee's own files; so, with no
// connection, the goals don't load, and TallyBee says why, that Beeminder's
// answer didn't come. (The tab shows the goals as they last loaded meanwhile:
// see goals in script.js.)
// Resultata (in a mutant of sw.js without its check that a request is for
// one of TallyBee's own files): the answer came through the service worker,
// which kept a copy of it, and, with no connection, answered with that, as if
// it were new.
test("the service worker leaves Beeminder's answers alone", async () => {
  const bee = newbee()
  const context = await browser.newContext()
  await context.route(API + '**', r => fakeBeeminder(bee, r))
  try {
    await localhost(async url => {
      const page = await context.newPage()
      await page.goto(url)
      await ready(page)
      // Logged in, as autoLogin leaves it
      await page.evaluate(t => localStorage.setItem('beeminder-token',
        JSON.stringify({ token: t, user: 'alice' })), TOKEN)
      const answer = page.waitForResponse(r => r.url().startsWith(API + 'users/me/goals.json'))
      await page.reload() // now with the service worker answering
      assert.equal((await answer).fromServiceWorker(), false)
      await see(page, '#goals', /pushups/)
      bee.reply = () => 'abort'
      await context.setOffline(true)
      await page.reload()
      await see(page, '#status', /^Error: .*fetch/i)
    })
  } finally { await context.close() }
})

// Replicata: open TallyBee; then, while a new version of it is being
// published, open it again, and get a 404 for its script, which isn't there
// for the moment; then lose the connection, and open TallyBee once more.
// Expectata: it opens, and counts, from the copies that the service worker
// kept before the 404, as it keeps no copy of an error.
// Resultata (in a mutant of sw.js that kept a copy of whatever it got): the
// 404 took the place of the copy of the script, so TallyBee opened with no
// script, and taps counted nothing.
test('a 404 while TallyBee is being published leaves its offline copy alone', async () => {
  let version = 1
  const context = await browser.newContext({ viewport: PHONE, hasTouch: true,
                                             isMobile: true })
  try {
    await localhost(async url => {
      const page = await context.newPage()
      await page.goto(url)
      await ready(page)
      await page.reload() // now with the service worker answering
      await context.route(url + 'script.js', r => r.fulfill({ status: 404, body: 'Not found' }))
      await page.reload()
      await context.unroute(url + 'script.js')
      // Chrome keeps the service worker's copies one at a time, in the order
      // they come, so once it has kept a copy of a file fetched after the 404,
      // it's done with the 404
      version = 2
      await page.evaluate(async () => { await fetch('style.css') })
      await kept(page, '/* version 2 */')
      await context.setOffline(true)
      await page.reload()
      await page.tap('#bigbut')
      assert.equal(await page.textContent('#bigbut'), '1')
    }, (path, body) => path.endsWith('style.css') ? `${body}\n/* version ${version} */\n` : body)
  } finally { await context.close() }
})

// Replicata: open TallyBee, with no goal named in its URL and none selected
// yet, and read its app manifest.
// Expectata: TallyBee, opening TallyBee's own URL, standalone (with no browser
// around it), black, and with icons of 192px and 512px, and a maskable one of
// 512px, each the size it says.
// Resultata (in a mutant whose manifest said that the 192px icon was 512px):
// that icon not the size it said.
qual("the app manifest: TallyBee, standalone, black, with icons that exist", async page => {
  await page.goto(APP)
  const cdp = await page.context().newCDPSession(page)
  const { url, errors, data } = await cdp.send('Page.getAppManifest')
  assert.deepEqual(errors, [])
  const m = JSON.parse(data)
  assert.equal(m.name, 'TallyBee')
  assert.equal(m.display, 'standalone')
  assert.equal(m.start_url, APP) // with no goal named in the URL, and none selected yet
  assert.equal(m.theme_color, '#000000')
  assert.equal(m.background_color, '#000000')
  for (const icon of m.icons) {
    const src = new URL(icon.src, url).href
    const size = await page.evaluate(async u => {
      const i = await createImageBitmap(await (await fetch(u)).blob())
      return `${i.width}x${i.height}`
    }, src)
    assert.equal(size, icon.sizes, src)
  }
  assert.deepEqual(m.icons.map(i => `${i.sizes} ${i.purpose ?? 'any'}`).sort(),
                   ['192x192 any', '512x512 any', '512x512 maskable'])
})

// Replicata: install TallyBee on Android, which crops its icon (the maskable
// one) to a circle or some other shape, so that only the icon's middle 80%
// circle is sure to show.
// Expectata: big tally marks, with the disclosure still all there.
// Resultata (before): the tally marks spanned 27% of the icon's width, with a
// lot of empty space around them.
qual("Android's icon: big tally marks, the disclosure, nothing outside the middle 80%", async page => {
  await page.goto(APP)
  const cdp = await page.context().newCDPSession(page)
  const { url, data } = await cdp.send('Page.getAppManifest')
  const icon = JSON.parse(data).icons.find(i => i.purpose === 'maskable')
  const { span, red, outside } = await page.evaluate(async u => {
    const i = await createImageBitmap(await (await fetch(u)).blob())
    const c = new OffscreenCanvas(i.width, i.height).getContext('2d')
    c.drawImage(i, 0, 0)
    const { data: d, width: w, height: h } = c.getImageData(0, 0, i.width, i.height)
    const xs = [] // where the tally marks' blue (#2e6bf0) is
    let red = 0, outside = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [r, g, b] = d.subarray(4 * (y * w + x))
      if (Math.abs(r - 0x2e) + Math.abs(g - 0x6b) + Math.abs(b - 0xf0) < 60) xs.push(x)
      if (r > 150 && g < 90 && b < 90) red++
      const pale = r >= 250 && g >= 215 && b <= g - 5 // the background's yellows
      if (Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) > 0.4 * w && !pale) outside++
    }
    return { span: (Math.max(...xs) - Math.min(...xs) + 1) / w, red, outside }
  }, new URL(icon.src, url).href)
  assert.ok(span > 1 / 3, `the tally marks span ${span} of the icon's width`)
  assert.ok(red > 500, `only ${red} pixels of the disclosure's red`)
  assert.equal(outside, 0, 'pixels outside the middle 80% that are not background')
})

// Replicata: share a link to TallyBee, say in a chat, which shows a preview
// made from the page's meta tags.
// Expectata: TallyBee, with the same description as search results get, and
// the 1200x630 og.png, with its size and alt text, as a large card; and black
// as the theme color.
// Resultata (in a mutant that previewed with the 512px icon): a 512x512 image.
qual('link previews get a title, description, and a 1200x630 image', async page => {
  await page.goto(APP)
  const meta = await page.$$eval('meta', ms => Object.fromEntries(ms.map(m =>
    [m.getAttribute('property') ?? m.name, m.content])))
  assert.equal(meta['og:title'], 'TallyBee')
  assert.ok(meta.description)
  assert.equal(meta['og:description'], meta.description)
  assert.equal(meta['og:url'], APP)
  assert.match(meta['og:image'], /^https:\/\/tallybee\.beeminder\.com\/./)
  const size = await page.evaluate(async u => {
    const i = await createImageBitmap(await (await fetch(u)).blob())
    return [i.width, i.height]
  }, meta['og:image'])
  assert.deepEqual(size, [1200, 630])
  assert.deepEqual([meta['og:image:width'], meta['og:image:height']],
                   ['1200', '630'])
  assert.equal(meta['og:image:alt'], 'TallyBee')
  assert.equal(meta['twitter:card'], 'summary_large_image')
  assert.equal(meta['theme-color'], '#000000')
})

// Replicata: open TallyBee, and fetch each icon, and the app manifest, that it
// links to.
// Expectata: each one there.
// Resultata (in a mutant of index.html linking to an icon that isn't there): a
// 404.
qual('every icon the page links to exists', async page => {
  await page.goto(APP)
  const hrefs = await page.$$eval(
    'link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]',
    ls => ls.map(l => l.href))
  assert.ok(hrefs.length >= 3, JSON.stringify(hrefs))
  for (const h of hrefs) assert.equal(await status(page, h), 200, h)
})

// ------------------------------------------------------- folding the footer

// Replicata: open TallyBee for the first time, log in, tap 3, and tap the fold
// button (at the right end of the bottom row); press UNDO; tap the fold button
// again.
// Expectata: at first, every control, the fold button saying the footer is
// unfolded; after the first tap, just the bar: −1, UNDO, Submit and the fold
// button, which says the footer is folded; UNDO takes back the last tap, not
// the fold; after the second tap, every control again.
// Resultata (before): no way to fold the footer, which always took three rows.
qual('folding the footer leaves the bar; unfolding brings back the rest', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  const showing = () => Promise.all([...FOLDAWAY, ...BAR].map(s => page.isVisible(s)))
  const all = [...FOLDAWAY.map(() => true), ...BAR.map(() => true)]
  assert.deepEqual(await showing(), all, 'at first')
  assert.ok(await unfolded(page))
  await tap(page, '#foldbut')
  assert.deepEqual(await showing(),
                   [...FOLDAWAY.map(() => false), ...BAR.map(() => true)])
  assert.ok(!await unfolded(page))
  await tap(page, '#undobut')
  await see(page, '#bigbut', '2')
  assert.ok(!await unfolded(page), 'UNDO unfolded the footer')
  await tap(page, '#foldbut')
  assert.deepEqual(await showing(), all, 'unfolded again')
  assert.ok(await unfolded(page))
})

// Replicata: open TallyBee, logged in, on a phone upright, a narrow one, and
// one turned sideways.
// Expectata: unfolded, from the top down: Clear and the login button (and
// the safesum); the day, the comment field and the ?; the number to send, the
// dropdown and the goal's link; and the bar's −1, UNDO, Submit and fold
// button, each row on a line of its own, but sideways, where there's room,
// Clear's row and the comment's share a line, and so do the send row and the
// bar.
// Resultata (in a mutant that put the bar above the drawer): the send row and
// the rest of the bar above Clear's row and the comment's.
for (const [width, height, lines] of [[390, 844, [0, 1, 2, 3]], [320, 568, [0, 1, 2, 3]],
                                      [844, 390, [0, 0, 1, 1]]])
  // FINAL DESIGN: renamed from "unfolded, the footer goes from Clear's row
  // down to the bar"
  qual(`unfolded, the footer goes from the info line down to the bar (${width}x${height})`, async page => {
    await login(page)
    // FINAL DESIGN: the info line, the username and the last datapoint, where
    // Clear's row was
    const rows = [['#loginbut', '#lastdp'], ['#day', '#comment', '#infobut'],
                  ['#num', '#goals', '#goallink'], BAR]
    // Each row's controls' middles, top to bottom
    const mids = await Promise.all(rows.map(r => Promise.all(r.map(async sel => {
      const b = await box(page, sel)
      return Math.round(b.y + b.height / 2)
    }))))
    mids.forEach((m, i) => assert.ok(m.every(y => y === m[0]), `row ${i}: ${m}`))
    const ys = [...new Set(mids.map(m => m[0]))].sort((a, b) => a - b)
    assert.deepEqual(mids.map(m => ys.indexOf(m[0])), lines, JSON.stringify(mids))
    const [c, i] = [await box(page, '#comment'), await box(page, '#infobut')]
    assert.ok(c.x + c.width < i.x, 'the ? at the right of the comment field')
  }, { viewport: { width, height } })

// Replicata: open TallyBee, logged out, on a 320px phone, and on a phone
// turned sideways; log in as alice, and as someone with a long name, on a
// 390px one.
// Expectata: the login button right beside Clear, 8px from it, like any two
// neighbors; on the narrow phone, its label on two lines rather than a line of
// its own (which would take 56px from tapping); the username as wide as the
// name, no wider; and a long name whole, on one line.
// Resultata (in one of this round's builds, which kept the margin that once
// set Clear apart from UNDO in its row): logged out on the phone turned
// sideways, the login button sat 46px from Clear, up against the comment
// field.
// FINAL DESIGN: renamed from "the login button sits beside Clear, as wide as
// its label, which wraps only if it must"
qual('the login button heads the footer, as wide as its label, which wraps only if it must', async page => {
  // Whether boxes a and b are side by side: their middles level, and b 8px
  // after a
  const beside = (a, b) => Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < 1 &&
                           Math.abs(a.x + a.width + 8 - b.x) < 1
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto(APP)
  // FINAL DESIGN: with Clear in the menu, the login button heads the footer,
  // at its left edge
  void beside
  let l = await box(page, '#loginbut')
  assert.ok(l.x === 16 && l.x + l.width <= 304 && l.height < 2 * 44, JSON.stringify(l))
  await page.setViewportSize({ width: 844, height: 390 })
  l = await box(page, '#loginbut')
  // (the footer's margin there is 22px: see .footer in style.css)
  assert.ok(l.x === 844 / 2 - 400 && l.height === 44, JSON.stringify(l))
  await page.setViewportSize(PHONE)
  for (const name of ['alice', 'christophermoravec']) {
    // Logged in, the username can't be pressed to log in as someone else, so
    // log out first, by forgetting the access token
    await page.evaluate(() => localStorage.removeItem('beeminder-token'))
    await page.reload()
    await login(page, name)
    l = await box(page, '#loginbut')
    // The width of its label, and of its padding and border
    const fit = await page.$eval('#loginbut', b => {
      const r = document.createRange(), s = getComputedStyle(b)
      r.selectNodeContents(b)
      return r.getBoundingClientRect().width + parseFloat(s.paddingLeft) +
        parseFloat(s.paddingRight) + parseFloat(s.borderLeftWidth) +
        parseFloat(s.borderRightWidth)
    })
    // FINAL DESIGN: the username, plain text, is one line of words, 20px
    // tall, at the footer's left edge
    assert.ok(l.x === 16 && l.height === 20 && Math.abs(l.width - fit) < 1,
              JSON.stringify({ name, l, fit }))
  }
})

// Replicata: look at the footer, unfolded, on a phone.
// Expectata: its rows on the 4px grid that style.css lays out: each 12px below
// the one above it (16px below the line on top, for the first).
// Resultata (in a mutant with 8px between the drawer's rows): the comment's
// row 8px below Clear's.
qual("the footer's rows are 12px apart", async page => {
  await login(page)
  // FINAL DESIGN: from the info line (its username), where Clear's row was
  const rows = await Promise.all(['.footer', '#loginbut', '#comment', '#num', '#minusbut']
    .map(s => box(page, s)))
  assert.deepEqual(rows.slice(1).map((r, i) => r.y - (i ? rows[i].y + rows[i].height
                                                        : rows[0].y + 1)),
                   [16, 12, 12, 12], JSON.stringify(rows))
})

// Replicata: log in, on a phone turned sideways, like a 568x320 iPhone SE.
// Expectata: the goal's whole name, pushups, in the dropdown, and all that
// the comment field says while empty.
// Resultata (before, with the dropdown 84px wide, and in one of this round's
// builds, with it 97px wide): "push…"; and in that build, the comment field's
// words cut off.
qual('sideways, the dropdown shows the whole goal, and the comment field all it says', async page => {
  await login(page)
  // Whether text, in the font of the field matching sel, fits inside the field's
  // padding
  const whole = (sel, text) => page.$eval(sel, (e, text) => {
    const s = getComputedStyle(e), c = document.createElement('canvas').getContext('2d')
    c.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
    return c.measureText(text).width <=
      e.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
  }, text)
  assert.ok(await whole('#goals', 'pushups'), 'pushups')
  assert.ok(await whole('#comment', await page.getAttribute('#comment', 'placeholder')),
            'the comment field')
}, { viewport: { width: 568, height: 320 } })

// Replicata: look at the footer, folded and unfolded.
// Expectata: no "Send" or "to" anywhere: the number to send and the dropdown
// say what they are by being there, as on Beeminder's own site, and folded,
// the bar is just its controls, with no summary of what Submit would send.
// Resultata (before): "Send 12 to pushups", and folded, the summary "Send 12
// t…", cut short on every phone.
qual('no "Send" or "to" in the footer, folded or not', async page => {
  await login(page)
  await taps(page, 12)
  const words = () => page.$eval('.footer', f => f.innerText)
  assert.doesNotMatch(await words(), /\bSend\b|\bto\b/)
  await tap(page, '#foldbut')
  assert.doesNotMatch(await words(), /\bSend\b|\bto\b/)
  assert.equal(await page.locator('#gist').count(), 0)
})

// Replicata: on a 320px-wide phone, logged in with a long username, tap 12,
// and fold the footer.
// Expectata: one row of controls, each at least 44 by 44 px, whole, on the
// screen, and none on top of another; and a footer no taller than that row
// and its margins: 16px above and below, and the 1px line on top.
// Resultata (in a mutant whose summary wouldn't shrink): the bar's controls on
// a line below it, in a footer 109px tall.
qual('folded, the footer is one row, even on a 320px phone', async page => {
  await login(page, 'christophermoravec')
  await tap(page, '#bigbut', 12)
  await tap(page, '#foldbut')
  const bs = await Promise.all(BAR.map(s => box(page, s)))
  bs.forEach((b, i) => assert.ok(b.width >= 44 && b.height >= 44 && b.x >= 0 &&
    b.x + b.width <= 320 && b.y === bs[0].y, `${BAR[i]}: ${JSON.stringify(b)}`))
  bs.forEach((a, i) => bs.slice(i + 1).forEach((b, j) => assert.ok(
    a.x + a.width <= b.x || b.x + b.width <= a.x, `${BAR[i]} overlaps ${BAR[i + 1 + j]}`)))
  const f = await box(page, '.footer')
  assert.ok(f.height <= 77, JSON.stringify(f))
}, { viewport: { width: 320, height: 568 } })

// Replicata: fold the footer on a phone just wide enough for −1, UNDO, Submit
// and the fold button in a row, 8px apart, between the footer's 16px margins
// (297px wide, in the font these quals get).
// Expectata: one row, the summary taking none of its room, and a footer no
// taller than that row and its margins (77px).
// Resultata (in this round's builds): from 297 to 304px wide, the fold button
// went on a row of its own, as the summary kept 8px of room for itself.
qual('folded, the bar is one row wherever its controls fit in one', async page => {
  await login(page)
  await tap(page, '#foldbut')
  const ws = await Promise.all(BAR.map(async s => (await box(page, s)).width))
  const width = Math.ceil(ws.reduce((a, b) => a + b) + 8 * (BAR.length - 1) + 2 * 16)
  await page.setViewportSize({ width, height: 640 })
  const ys = await Promise.all(BAR.map(async s => (await box(page, s)).y))
  const f = await box(page, '.footer')
  assert.ok(ys.every(y => y === ys[0]) && f.height <= 77, JSON.stringify({ width, ys, f }))
})

// Replicata: fold the footer, on a phone upright and sideways, big and small.
// Expectata: the big button gets the whole screen but the one row and its
// margins (77px).
// Resultata (before): the footer took three rows (two, sideways), which left
// 655 of 844px for tapping on a 390x844 phone, and 187 of 320 on a 568x320
// one.
for (const [width, height] of [[390, 844], [320, 568], [844, 390], [568, 320]])
  qual(`folded, the big button gets all but one row (${width}x${height})`, async page => {
    await login(page)
    await tap(page, '#foldbut')
    const big = await box(page, '#bigbut')
    assert.ok(big.height >= height - 77, JSON.stringify(big))
  }, { viewport: { width, height } })

// Replicata: on a phone as narrow as 280px, like the first Galaxy Fold's front
// screen, tap 12 and fold the footer.
// Expectata: the bar's controls take two rows, as they must there, and the big
// button gets the rest: the summary takes no room of its own.
// Resultata (in a mutant whose summary wouldn't shrink): the summary on a line
// of its own, above the bar's two, taking room from the big button.
qual('folded on a 280px phone, the big button gets all but the bar', async page => {
  await login(page)
  await taps(page, 12)
  await tap(page, '#foldbut')
  const [m, f, big] = await Promise.all(['#minusbut', '#foldbut', '#bigbut'].map(s => box(page, s)))
  assert.ok(f.y > m.y, 'one row')
  assert.ok(big.height >= 653 - (33 + f.y + f.height - m.y), JSON.stringify({ m, f, big }))
}, { viewport: { width: 280, height: 653 } })

// Replicata: with a finger over Submit, fold the footer, and unfold it, on
// phones upright and sideways, big and small, on a computer, and on a phone
// with its text at 200% (with long names).
// Expectata: −1, UNDO, Submit and the fold button stay right where they were:
// it's the top of the footer that moves.
// Resultata (in a mutant that didn't keep the bar's controls to the right): at
// 320x568 and 390x844, −1, UNDO, Submit and the fold button at the left while
// unfolded, and at the right while folded.
for (const [width, height, opts, long] of [[320, 568], [390, 844], [844, 390], [568, 320],
                                           [540, 360], [1280, 800, DESK], [280, 653],
                                           [200, 433, {}, true]])
  qual(`folding and unfolding moves nothing in the bar (${width}x${height})`, async (page, bee) => {
    if (long) bee.goals.push({ slug: 'reading-for-the-book-club', kyoom: true,
      curval: 0, deadline: 0, last_datapoint: null, safesum: 'safe for 9 days', queued: false })
    await login(page, long ? 'christophermoravec' : 'alice')
    await taps(page, 3)
    const where = () => Promise.all(BAR.map(s => box(page, s)))
    const a = await where()
    await tap(page, '#foldbut')
    assert.deepEqual(await where(), a, 'folded')
    await tap(page, '#foldbut')
    assert.deepEqual(await where(), a, 'unfolded again')
  }, { ...opts, viewport: { width, height } })

// Replicata: fold the footer, and unfold it, on a phone of each width from
// 200px to 700px, a pixel at a time.
// Expectata: at every width, −1, UNDO, Submit and the fold button stay right
// where they were.
// Resultata (in one of this round's builds, which put the summary in the same
// line-wrapping row as the bar's controls): from 245 to 252px wide, and from
// 297 to 304px, folding moved −1, UNDO and Submit, to make room for the
// summary.
qual('folding and unfolding moves nothing in the bar, at any width', async page => {
  await login(page)
  await taps(page, 3)
  const moved = []
  for (let width = 200; width <= 700; width++) {
    await page.setViewportSize({ width, height: 640 })
    if (await page.evaluate(sels => {
      const where = () => sels.map(s =>
        JSON.stringify(document.querySelector(s).getBoundingClientRect())).join()
      const fold = () => document.getElementById('foldbut').click()
      const a = where()
      fold()
      const b = where()
      fold()
      return b !== a || where() !== a
    }, BAR)) moved.push(width)
  }
  assert.deepEqual(moved, [])
})

// Replicata: open TallyBee for the first time; fold the footer; the phone
// reloads the page; open TallyBee in another window, and unfold it there.
// Expectata: unfolded at first, so a new user sees the login button; still
// folded after reloading, and in the other window; and unfolded in both once
// the other window unfolds it. TallyBee remembers it with the rest (see
// script.js), as folded: false, then true, then false.
// Resultata (in a mutant that unfolded the footer each time the page loaded):
// unfolded after the reload.
qual('the fold is remembered, and shared by all TallyBee windows', async page => {
  await page.goto(APP)
  const folded = async p => JSON.parse(await p.evaluate(() =>
    localStorage.getItem('tallybee'))).folded
  assert.ok(await page.isVisible('#loginbut'), 'unfolded at first')
  assert.equal(await folded(page), false)
  await login(page)
  await tap(page, '#foldbut')
  assert.equal(await folded(page), true)
  await page.reload()
  await see(page, '#goals', /pushups/)
  assert.ok(!await unfolded(page))
  // FINAL DESIGN: the comment field, not Clear (in the menu), is what shows
  // that the footer is unfolded
  assert.ok(!await page.isVisible('#comment'))
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  assert.ok(!await w.isVisible('#comment'))
  await w.bringToFront()
  await tap(w, '#foldbut')
  await page.bringToFront()
  await page.locator('#comment').waitFor()
  assert.ok(await unfolded(page))
  assert.equal(await folded(page), false)
})

// Replicata: on a computer, press Tab over and over, from the big button; then
// fold the footer and do it again.
// Expectata: unfolded, the focus goes through every control, row by row
// (though not the username, which only says who's logged in); folded, only
// through −1, UNDO, Submit and the fold button, never to a control that's
// folded away.
// Resultata (in a mutant that folded the drawer away by making it
// see-through): Tab went to Clear and on, through the controls folded away.
qual('the Tab order goes row by row, and skips what is folded away', async page => {
  await login(page)
  await tap(page, '#bigbut') // so that UNDO and Submit can take the focus
  const order = async n => {
    await page.focus('#bigbut')
    const ids = []
    for (let i = 0; i < n; i++) {
      await page.keyboard.press('Tab')
      ids.push(await page.evaluate(() => document.activeElement.id))
    }
    return ids
  }
  // FINAL DESIGN: not Clear, which is in the menu
  assert.deepEqual(await order(10), ['day', 'comment', 'infobut', 'num',
    'goals', 'goallink', 'minusbut', 'undobut', 'subbut', 'foldbut'])
  await page.click('#foldbut')
  assert.deepEqual(await order(4), ['minusbut', 'undobut', 'subbut', 'foldbut'])
}, DESK)

// Replicata: use TallyBee with a screen reader, and fold the footer.
// Expectata: the fold button has a name, says whether the footer is folded,
// and names what it folds away, which is every control it folds away; and
// what's folded away is gone for the screen reader too.
// Resultata (in a mutant that never changed aria-expanded): "expanded" still,
// folded.
qual('screen readers hear the fold button, whether it is folded, and not what it hides', async page => {
  await login(page)
  assert.match(await page.getAttribute('#foldbut', 'aria-label') ?? '', /^\p{L}{2,}/u)
  const ids = (await page.getAttribute('#foldbut', 'aria-controls') ?? '').split(' ')
  for (const sel of FOLDAWAY)
    assert.ok(await page.$eval(sel, (e, ids) => ids.some(id =>
      document.getElementById(id)?.contains(e)), ids), `${sel} in ${ids}`)
  // FINAL DESIGN: the menu button, not Clear (in the menu), is what folding
  // hides
  assert.equal(await page.getByRole('button', { name: 'Help' }).count(), 1)
  await tap(page, '#foldbut')
  assert.equal(await page.getAttribute('#foldbut', 'aria-expanded'), 'false')
  for (const role of ['combobox', 'textbox'])
    assert.equal(await page.getByRole(role).count(), 0, role)
  assert.equal(await page.getByRole('button', { name: 'Help' }).count(), 0)
  for (const id of ids) assert.ok(await page.$eval('#' + id, e => e.hidden), id)
})

// Replicata: fold the footer, tap 3, and Submit, with Beeminder slow to
// answer; then tap 2 and Submit, over a connection that fails.
// Expectata: "Submitting…", then that it worked, then the error, each above
// the bar, with the footer still folded.
// Resultata (in a mutant of index.html with the status line in the drawer): no
// status line at all while folded.
qual('folded, status messages still show', async (page, bee) => {
  await login(page)
  await tap(page, '#foldbut')
  const above = async () => {
    const s = await box(page, '#status')
    assert.ok(s.height > 0 && s.y + s.height <= (await box(page, '#minusbut')).y,
              JSON.stringify(s))
    assert.ok(!await unfolded(page))
  }
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut.then(() => null) : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await see(page, '#status', 'Submitting…')
  await above()
  open()
  await see(page, '#status', /✓.*pushups/)
  await above()
  bee.reply = c => c.method === 'POST' ? 'abort' : null
  await tap(page, '#bigbut', 2)
  await tap(page, '#subbut')
  await see(page, '#status', /Error/)
  await expectError(page, bee, /fetch/i)
  await above()
})

// Replicata: fold the footer, tap 2, and Submit. Tap 3 and Submit again, and
// Beeminder has a hiccup. Unfold the footer, and Submit again.
// Expectata: the footer folded through both Submits and the error, and
// unfolded through the Submit after it.
// Resultata (in a mutant that unfolded the footer to show an error): unfolded
// at the error.
// SPEC CHANGE (following from the owner's "Probably reasonable?" to question 7
// in AGENTS.md): this was "even when you get logged out", with a 401 for the
// error, and a login after it. Logged out, the footer now shows unfolded, for
// the login button: see "logged out, the footer shows unfolded, with the login
// button".
qual('the footer never folds or unfolds by itself, even at an error', async (page, bee) => {
  await login(page)
  await tap(page, '#foldbut')
  await tap(page, '#bigbut', 2)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.ok(!await unfolded(page), 'after a Submit')
  await tap(page, '#bigbut', 3)
  bee.reply = c => c.method === 'POST' ? [500, { errors: { message: 'Kaboom' } }] : null
  await tap(page, '#subbut')
  await see(page, '#status', /500.*Kaboom/)
  await expectError(page, bee, /Kaboom/)
  assert.ok(!await unfolded(page), 'after the error')
  await tap(page, '#foldbut')
  bee.reply = () => null
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.ok(await unfolded(page), 'after a Submit')
})

// Replicata: log in, tap 3, and Submit, which gets a 401, as you logged in on
// another device; then log in again here.
// Expectata: the 3 kept, and Submit grayed out while logged out, though the
// goals still show; then usable again, logged in.
// Resultata (before): Submit yellow and usable while logged out, though
// pressing it sent nothing, and only said to log in again.
qual('Submit is grayed out while logged out, even with the goals still showing', async (page, bee) => {
  await login(page)
  await tap(page, '#bigbut', 3)
  bee.tokens = ['tok456']
  await tap(page, '#subbut')
  await see(page, '#status', `Error: ${REAUTH}`)
  await expectError(page, bee, new RegExp(RegExp.escape(REAUTH)))
  await see(page, '#goals', /pushups/)
  assert.ok(await disabled(page, '#subbut'), 'logged out')
  assert.equal(await count(page), 3)
  await login(page, 'alice', 'tok456')
  assert.ok(!await disabled(page, '#subbut'), 'logged in again')
})

// Replicata: log in, fold the footer, tap 2, and Submit, which gets a 401, as
// you logged in on another device; then log in again here.
// Expectata: logged out, the footer unfolded, with the login button there to
// press, which the error says to do, and the fold button grayed out, as
// there's nothing it can do; then, logged in again, the footer folded, as
// before.
// Resultata (before): the footer folded still, with the login button folded
// away.
qual('logged out, the footer shows unfolded, with the login button', async (page, bee) => {
  await login(page)
  await tap(page, '#foldbut')
  await tap(page, '#bigbut', 2)
  bee.tokens = ['tok456']
  await tap(page, '#subbut')
  await see(page, '#status', `Error: ${REAUTH}`)
  await expectError(page, bee, new RegExp(RegExp.escape(REAUTH)))
  assert.ok(await page.isVisible('#loginbut'), 'logged out: the login button')
  assert.ok(await unfolded(page), 'logged out')
  assert.ok(await disabled(page, '#foldbut'), 'logged out: the fold button')
  await login(page, 'alice', 'tok456')
  assert.ok(!await unfolded(page), 'logged in again')
  assert.ok(!await disabled(page, '#foldbut'), 'logged in again: the fold button')
  assert.equal(await count(page), 2)
})

// Whether the fold button's chevron points up, as it shows on the screen: its
// tip (its path's middle) above its ends
const pointsup = page => page.$eval('#foldbut path', p => {
  const m = p.getScreenCTM()
  const [a, tip] = [0, p.getTotalLength() / 2].map(l => p.getPointAtLength(l).matrixTransform(m))
  return tip.y < a.y
})

// Replicata: fold the footer, and unfold it.
// Expectata: the fold button a 44px circle, like the ?, with a chevron in its
// middle that points up (there's more above) when folded, and down when
// unfolded, turning over in about a fifth of a second; and that's all that
// moves: the footer itself folds and unfolds at once.
// Resultata (in a mutant with the chevron the other way round): pointing up
// while unfolded.
qual("the fold button's chevron points the way the footer can go", async page => {
  await login(page)
  const round = sel => page.$eval(sel, e => { const r = e.getBoundingClientRect()
    return [r.width, r.height, parseFloat(getComputedStyle(e).borderTopLeftRadius) >= r.width / 2] })
  assert.deepEqual(await round('#foldbut'), [44, 44, true])
  assert.deepEqual(await round('#foldbut'), await round('#infobut'))
  const [b, c] = [await box(page, '#foldbut'), await box(page, '#foldbut svg')]
  assert.ok(Math.abs(c.x + c.width / 2 - (b.x + b.width / 2)) < 0.5 &&
            Math.abs(c.y + c.height / 2 - (b.y + b.height / 2)) < 0.5,
            `the chevron in the middle: ${JSON.stringify([b, c])}`)
  assert.ok(!await pointsup(page), 'unfolded')
  await moves(page)
  await tap(page, '#foldbut')
  const big = await box(page, '#bigbut')
  await still(page, '#foldbut svg')
  assert.ok(await pointsup(page), 'folded')
  assert.deepEqual(await page.evaluate(() => window.moved), [['svg', 'rotate']])
  assert.equal(await page.$eval('#foldbut svg', s => getComputedStyle(s).transitionDuration),
               '0.2s')
  assert.deepEqual(await box(page, '#bigbut'), big, 'the footer should fold at once')
})

// Record, in window.moved, each transition (what changes gradually) that
// starts in the footer from now on: [the element's id or tag, the property]
const moves = page => page.evaluate(() => { window.moved = []
  document.querySelector('.footer').addEventListener('transitionrun', e => {
    if (e.propertyName !== 'background-color') // a button's press fading back
      window.moved.push([e.target.id || e.target.tagName, e.propertyName]) }) })

// Replicata: ask your device for less motion; fold the footer, and unfold it.
// Expectata: the chevron flips at once, without turning.
// Resultata (in a mutant without style.css's rule for less motion): the
// chevron not flipped right after the tap, as it was turning.
qual('folding holds still for people who ask their device for less motion', async page => {
  await login(page)
  await moves(page)
  await tap(page, '#foldbut')
  assert.ok(await pointsup(page), 'flipped')
  await tap(page, '#foldbut')
  await frames(page)
  assert.deepEqual(await page.evaluate(() => window.moved), [])
}, { reducedMotion: 'reduce' })

// Replicata: on a phone with its text at 200%, with long names, fold the
// footer, tap 12, and unfold it; Submit while Beeminder is down, with a long
// error.
// Expectata: the footer, which would now be taller than the screen, is no
// taller than it: its upper rows scroll, and the bar, fold button and all,
// stays on the screen, so folding the footer brings back room to tap.
// Resultata (in prototype A): the bar went below the screen with the bottom
// of the footer, so the footer couldn't be folded again.
qual('with text at 200%, the fold button stays on the screen, even under a long error', async (page, bee) => {
  bee.goals.push({ slug: 'reading-for-the-book-club', kyoom: true, curval: 0,
                   deadline: 0, last_datapoint: null, safesum: 'safe for 9 days', queued: false })
  await login(page, 'christophermoravec')
  await tap(page, '#foldbut')
  await tap(page, '#bigbut', 12)
  await tap(page, '#foldbut')
  bee.reply = c => c.method === 'POST'
    ? [502, { errors: 'Bad gateway. '.repeat(50) }] : null
  await tap(page, '#subbut')
  await see(page, '#status', /502/)
  await expectError(page, bee, /502/)
  const f = await box(page, '.footer')
  assert.ok(f.y >= 0 && f.y + f.height <= 433, `the footer: ${JSON.stringify(f)}`)
  for (const sel of BAR) {
    const b = await box(page, sel)
    assert.ok(b.y >= 0 && b.y + b.height <= 433, `${sel}: ${JSON.stringify(b)}`)
  }
  // The rows above the bar scroll, so every control can still be got to
  await page.locator('#comment').scrollIntoViewIfNeeded()
  const [c, n] = [await box(page, '#comment'), await box(page, '#num')]
  assert.ok(c.y >= f.y && c.y + c.height <= n.y, JSON.stringify([c, n]))
  await tap(page, '#foldbut')
  assert.ok((await box(page, '#bigbut')).height >= 200)
  await tap(page, '#bigbut')
  assert.equal(await count(page), 13)
}, { viewport: { width: 200, height: 433 } })

// Replicata: on a phone with its text at 200%, with long names, open
// TallyBee, unfolded, and tap the big button; then Submit while Beeminder is
// down, with a long error, and tap again.
// Expectata: the big button keeps a fifth of the screen to tap, at least, the
// drawer scrolling instead; so what folding the footer would hide, the drawer
// and the send row, takes about half the screen (here, 50%: the owner OK'd
// "about half" in AGENTS.md, question 8); and the taps count. Under the error
// too, with the drawer, squeezed, still showing one control whole.
// Resultata (before): the drawer took all the room the bar left, so the big
// button was 0px tall, with nowhere to tap but the footer. (And in a draft of
// this build, under the error, the drawer was a 34px sliver of a 44px row.)
qual('unfolded, with text at 200%, the big button keeps room to tap', async (page, bee) => {
  bee.goals.push({ slug: 'reading-for-the-book-club', kyoom: true, curval: 0,
                   deadline: 0, last_datapoint: null, safesum: 'safe for 9 days', queued: false })
  await login(page, 'christophermoravec')
  const room = async when => {
    const big = await box(page, '#bigbut')
    assert.ok(big.height >= 433 / 5 - 0.5, `${when}: ${JSON.stringify(big)}`)
  }
  await room('at first')
  await tap(page, '#bigbut')
  assert.equal(await count(page), 1)
  bee.reply = c => c.method === 'POST'
    ? [502, { errors: 'Bad gateway. '.repeat(50) }] : null
  await tap(page, '#subbut')
  await see(page, '#status', /502/)
  await expectError(page, bee, /502/)
  await room('under the error')
  await page.locator('#comment').scrollIntoViewIfNeeded()
  assert.equal(await clipper(page, '#comment'), null, 'the comment, under the error')
  await tap(page, '#bigbut')
  assert.equal(await count(page), 2)
}, { viewport: { width: 200, height: 433 } })

// Replicata: on a phone with its text at 200% (as on a 400x866 phone, or a
// 360x780 one), with long names, unfolded, Submit with no connection; then,
// connected again, Submit, which gets a 401, as you logged in on another
// device.
// Expectata: each error's first line whole, at least 1.25em (20px) tall, so
// that it can be read, with the bar and the big button's fifth of the screen
// as before (see the qual above): the drawer, which scrolls, gives way instead.
// Resultata (in v2026.10.02b): "Error: Failed to fetch" 5.5px tall at
// 200x433, and 3.3px at 180x390, a red sliver.
for (const [width, height] of [[200, 433], [180, 390]])
  qual(`with text at 200%, an error shows its first line whole (${width}x${height})`, async (page, bee) => {
    bee.goals.push({ slug: 'reading-for-the-book-club', kyoom: true, curval: 0,
                     deadline: 0, last_datapoint: null, safesum: 'safe for 9 days', queued: false })
    await login(page, 'christophermoravec')
    bee.reply = () => 'abort'
    await tap(page, '#subbut')
    await see(page, '#status', /Error/)
    await expectError(page, bee, /fetch/i)
    const line = async when => {
      const s = await box(page, '#status')
      assert.ok(s.height >= 20, `${when}: ${JSON.stringify(s)}`)
      for (const sel of BAR) {
        const b = await box(page, sel)
        assert.ok(b.y + b.height <= height, `${when}, ${sel}: ${JSON.stringify(b)}`)
      }
      assert.ok((await box(page, '#bigbut')).height >= height / 5 - 0.5, when)
    }
    await line('offline')
    bee.reply = () => null
    bee.tokens = ['tok456']
    await tap(page, '#subbut')
    await see(page, '#status', `Error: ${REAUTH}`)
    await expectError(page, bee, new RegExp(RegExp.escape(REAUTH)))
    await line('after the 401')
  }, { viewport: { width, height } })

// Replicata: open TallyBee, logged out, and logged in with a long username, on
// phones upright and sideways, big and small, and on a computer, with text at
// its usual size.
// Expectata: the drawer whole, with nothing in it to scroll to: the fifth of
// the screen that the big button always keeps (see the qual above) makes the
// drawer scroll only where text is made huge.
// Resultata (with the drawer capped at a quarter of the screen instead, as
// first built): at 320x568, logged in, the drawer scrolled.
qual('at the usual text size, the drawer shows whole', async page => {
  const whole = async what => {
    for (const [width, height] of [[390, 844], [412, 915], [360, 780], [320, 568],
                                   [280, 653], [844, 390], [640, 360], [568, 320],
                                   [1280, 800]]) {
      await page.setViewportSize({ width, height })
      const d = await page.$eval('#drawer', d => [d.scrollHeight, d.clientHeight])
      assert.ok(d[0] <= d[1], `${what}, ${width}x${height}: ${d}`)
    }
  }
  await page.goto(APP)
  await whole('logged out')
  await page.setViewportSize(PHONE)
  await login(page, 'christophermoravec')
  await whole('logged in')
})

// Replicata: on an Android phone with gesture navigation, in TallyBee where
// Chrome lets the page reach under the phone's navigation bar (as in an
// installed app), and says how far up the bar reaches (here 48px), look at
// the bar, unfolded and folded.
// Expectata: −1, UNDO, Submit and the fold button all above the navigation
// bar, where they can be tapped.
// Resultata (before): the bar partly under the navigation bar: −1 from 784 to
// 828px of 844, 32px into the navigation bar's 48.
qual("the bar stays above the phone's own navigation bar", async page => {
  await login(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setSafeAreaInsetsOverride',
                 { insets: { bottom: 48, bottomMax: 48 } })
  // The page knows how far up the navigation bar reaches
  assert.equal(await page.evaluate(() => {
    const d = document.body.appendChild(document.createElement('div'))
    d.style.height = 'env(safe-area-inset-bottom)'
    const h = d.getBoundingClientRect().height
    d.remove()
    return h
  }), 48)
  const above = async when => {
    for (const sel of BAR) {
      const b = await box(page, sel)
      assert.ok(b.y + b.height <= PHONE.height - 48, `${when}, ${sel}: ${JSON.stringify(b)}`)
    }
  }
  await above('unfolded')
  await tap(page, '#foldbut')
  await above('folded')
})

// Replicata: on phones upright and sideways, big and small, and with text at
// 200%, with long names, unfolded and folded, Submit when Beeminder is down,
// with a long error.
// Expectata: the page itself never scrolls: it's never taller or wider than
// the screen (what's in the footer scrolls instead, where it must). Chrome on
// Android slides its own bar at the bottom away as a page scrolls, which
// would change how far up the phone's navigation bar reaches into the page
// (see .footer in style.css).
// Resultata (in a mutant whose footer couldn't be squeezed to fit the screen):
// at 568x320, unfolded, under the error, a page 337px tall. (And in
// v2026.10.02b, whose drawer kept one control, 44px, whole, even where the
// bar then didn't fit, at 188x334, a 375x667 phone with its text at 200%,
// unfolded, under the error: a page 356px tall, Submit and the fold button
// below the screen.)
qual('the page itself never scrolls, even under a long error', async (page, bee) => {
  bee.goals.push({ slug: 'reading-for-the-book-club', kyoom: true, curval: 0,
                   deadline: 0, last_datapoint: null, safesum: 'safe for 9 days', queued: false })
  await login(page, 'christophermoravec')
  bee.reply = c => c.method === 'POST'
    ? [502, { errors: 'Bad gateway. '.repeat(50) }] : null
  await tap(page, '#subbut')
  await see(page, '#status', /502/)
  await expectError(page, bee, /502/)
  // How big the page is, and the screen
  const extent = () => page.evaluate(() => { const e = document.scrollingElement
    return [e.scrollWidth, e.scrollHeight, e.clientWidth, e.clientHeight] })
  for (const [width, height] of [[390, 844], [320, 568], [280, 653], [844, 390],
                                 [568, 320], [200, 433], [188, 334]]) {
    await page.setViewportSize({ width, height })
    for (const when of ['unfolded', 'folded']) {
      const [sw, sh, cw, ch] = await extent()
      assert.ok(sw <= cw && sh <= ch, `${width}x${height}, ${when}: ${[sw, sh]}`)
      await tap(page, '#foldbut')
    }
  }
})

// Replicata: on an Android phone, open TallyBee installed as an app, where
// Chrome works out 100dvh (100 units of the dynamic viewport height) as taller
// than the app's window, by about the height of its own toolbar, as Chromium
// issues 463721080 and 453570183 report of installed apps; then try to scroll
// the page.
// Expectata: the page fits its window anyway, the bar whole on the screen, and
// there's nothing to scroll. (Headless Chrome gets 100dvh right, so a 6% zoom
// of the page stands in for Chrome's mistake: zoom scales lengths in viewport
// units, like 100dvh, but not percentages, like html's 100%.)
// Resultata (v2026.10.03b, whose page was 100dvh tall): a page 895px tall in
// an 844px window, which scrolled 51px, with the bar's bottom off the screen
// till it did. (And clipped to its window, as it was before 3d3b99a, the
// page's bottom 51px stayed off the screen: wishlist 15's "the bottom of the
// footer bar runs off the bottom of the screen and is inaccessible".)
qual('the page fits its window even where Chrome makes 100dvh taller, as in installed apps', async page => {
  await login(page)
  await page.addStyleTag({ content: 'body { zoom: 1.06 }' })
  const [sh, ch] = await page.evaluate(() => { const e = document.scrollingElement
    return [e.scrollHeight, e.clientHeight] })
  assert.ok(sh <= ch, `a page ${sh}px tall in a ${ch}px window`)
  for (const sel of BAR) {
    const b = await box(page, sel)
    assert.ok(b.y + b.height <= PHONE.height, `${sel}: ${JSON.stringify(b)}`)
  }
  await page.evaluate(() => scrollBy(0, 200))
  assert.equal(await page.evaluate(() => scrollY), 0)
})

// Replicata: put the phone on the floor with the footer unfolded, sideways,
// where the comment field is on the footer's top line, and count pushups,
// touching your nose to the very bottom of the black area, just above the
// buttons and the comment field.
// Expectata: each touch counts one more, and none brings up the keyboard.
// Resultata (in a mutant with no room at the top of the footer): the first
// such touch counted nothing.
qual('touches at the bottom edge of the big button count, and press no button (844x390)', async page => {
  await login(page)
  await edgeTouches(page, '.footer :is(button, select, input)')
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'comment')
}, { viewport: { width: 844, height: 390 } })

// -------------------------------------------------------------- the page

// Replicata: tap ?, then the help's text, then ×; open it again and press
// Escape; open it again and tap outside it.
// Expectata: the help, credits and all, open till the ×, Escape, or a tap
// outside it closes it; a tap on its text leaves it open.
// Resultata (in a mutant whose help didn't keep taps on it to itself): a tap
// on its text closed it.
qual('the ? button opens the help and credits, closable by ×, Escape, or tapping outside', async page => {
  await login(page)
  const open = () => page.$eval('#info', d => d.open)
  await tap(page, '#infobut')
  assert.ok(await open())
  await see(page, '#info', /Jake Coble added the coup de grace/)
  await tap(page, '#info .modal-body p')
  assert.ok(await open(), 'tapping the text leaves it open')
  await tap(page, '#info .close')
  assert.ok(!await open())
  await tap(page, '#infobut')
  await page.keyboard.press('Escape')
  assert.ok(!await open())
  await tap(page, '#infobut')
  await page.touchscreen.tap(10, 10)
  assert.ok(!await open())
})

// Replicata: tap the ? button, and look at the end of the help.
// Expectata: "Source / Sourcery", with "Source" linking to TallyBee's code on
// GitHub and "Sourcery" to sourcery.html, the record of how it was made.
// Resultata (before): no links to either.
qual('the help ends with links to the source and the sourcery', async page => {
  await login(page)
  await tap(page, '#infobut')
  const last = page.locator('#info .modal-body p').last()
  assert.equal(await last.textContent(), 'Source / Sourcery')
  assert.deepEqual(await last.locator('a').evaluateAll(as => as.map(a =>
    [a.textContent, a.getAttribute('href')])),
    [['Source', 'https://github.com/beeminder/tallybee'], ['Sourcery', 'sourcery.html']])
  assert.equal(await status(page, APP + 'sourcery.html'), 200)
})

// Replicata: serve this directory at localhost (as in the comment at the top
// of script.js), copy the beeminder-token that the live TallyBee saved (see
// beeminder.js) into the copy's localStorage, and reload it.
// Expectata: the copy, logged in, with the goals loaded from Beeminder, which
// lets any page call it (it answers with access-control-allow-origin: *).
// Resultata (before): the same, but with no word anywhere on how to get there,
// as logging in on the copy sends you to the live TallyBee. (So this qual
// was green from the start: it's here so that the recipe keeps working.)
qual('a copy served at localhost works with a token copied from the live TallyBee', async page => {
  await page.route(/^http:\/\/localhost:\d+\//, r => r.continue())
  await localhost(async url => {
    await page.goto(url)
    await page.evaluate(token => localStorage.setItem('beeminder-token',
      JSON.stringify({ token, user: 'alice' })), TOKEN)
    await page.reload()
    await see(page, '#goals', /pushups/)
  })
})

// Replicata: on a small phone in landscape, tap the ? button.
// Expectata: ways to close it: the ×, and tapping above the help.
// Resultata (before): the × is off the top of the screen.
qual('the credits can be closed even on a tiny screen', async page => {
  await login(page)
  const open = () => page.$eval('#info', d => d.open)
  // Open the help, and wait for it to finish sliding in
  const help = async () => {
    await tap(page, '#infobut')
    await still(page, '#info')
  }
  await help()
  const b = await box(page, '#info .close')
  assert.ok(b.y >= 0 && b.y + b.height <= 320, JSON.stringify(b))
  await tap(page, '#info .close')
  assert.ok(!await open())
  await help()
  await page.touchscreen.tap(10, 10)
  assert.ok(!await open())
}, { viewport: { width: 568, height: 320 } })

// Replicata: ask your device for less motion, and tap the ? button.
// Expectata: the help appears without sliding in.
// Resultata (before): it slid in anyway.
qual('the help holds still for people who ask their device for less motion', async page => {
  await login(page)
  await tap(page, '#infobut')
  assert.equal(await page.$eval('#info', d => d.getAnimations().length), 0)
}, { reducedMotion: 'reduce' })

// Replicata: on a 320px-wide phone, log in with a long username, and tap once.
// Expectata: every control in the footer whole, on the screen, and none on top
// of another, or of the version tag.
// Resultata (in a mutant without the footer's room at the bottom for the
// version tag): the fold button on top of the version tag.
qual('the controls fit a narrow phone without overlapping', async page => {
  await login(page, 'christophermoravec')
  await tap(page, '#bigbut')
  await fits(page)
}, { viewport: { width: 320, height: 568 } })

// Replicata: set a phone's text size as big as it goes, which makes a
// 400px-wide phone like a 200px-wide one, and open TallyBee, with a goal with
// a long name, and tap 12.
// Expectata: all the controls, whole, and none on top of another.
// Resultata (before): the rows of controls ran off the right edge, and (in a
// draft of the redesign) the send row did, as wide as the longest goal name.
// SPEC CHANGE (for the owner to approve): unfolded, the comment's row makes
// the footer taller than such a screen, leaving no big button to tap, and the
// drawer scrolls. So the 12 get tapped with the footer folded, and then,
// unfolded, each of the drawer's two rows gets checked once scrolled to.
// SPEC CHANGE (following from the owner's "I guess?" to question 8 in
// AGENTS.md, which keeps a fifth of the screen for the big button, so that it
// has room to tap, even here): the drawer's first row is now taller than the
// drawer, so each of the drawer's controls, rather than each of its rows, gets
// checked once scrolled to.
qual('with text at 200% on a phone, the controls still fit', async (page, bee) => {
  bee.goals.push({ slug: 'reading-for-the-book-club', kyoom: true, curval: 0,
                   deadline: 0, last_datapoint: null, safesum: 'safe for 9 days', queued: false })
  await login(page, 'christophermoravec')
  await tap(page, '#foldbut')
  await tap(page, '#bigbut', 12)
  await tap(page, '#foldbut')
  // FINAL DESIGN: Clear is in the menu, and the safesum in the top line
  const drawer = ['#loginbut', '#lastdp', '#day', '#comment', '#infobut']
  const rest = FOOTER.filter(s => !drawer.includes(s))
  for (const sel of drawer) {
    await page.locator(sel).scrollIntoViewIfNeeded()
    await fits(page, [sel, ...rest])
    assert.equal(await clipper(page, sel), null, sel)
  }
  await apart(page, drawer)
}, { viewport: { width: 200, height: 433 } })

// Replicata: log in and turn a phone sideways, like a 640x360 Android phone.
// Expectata: most of the screen, more than 55% of its height, still for
// tapping.
// Resultata (before): 53% at 568x320; and in a draft of the redesign, 41% at
// 568x320, 48% at 640x360, and 52% at 844x390.
// SPEC CHANGE (approved 2026-10-02 by the person working on this for the
// owner): not at 568x320, like a first iPhone SE sideways, any more. There,
// unfolded, the day, the last datapoint and the goal's link leave 36% (of
// 320px, in the font these quals get). Folded, it gets all but one row, as
// ever (see "folded, the big button gets all but one row").
// FINAL DESIGN: 568x320 is back, at 58%
for (const [width, height] of [[568, 320], [640, 360], [667, 375], [844, 390]])
  qual(`a phone turned sideways (${width}x${height}) still has most of its screen for tapping`, async page => {
    await login(page)
    const big = await box(page, '#bigbut')
    assert.ok(big.height > 0.55 * height, JSON.stringify(big))
  }, { viewport: { width, height } })

// Replicata: Submit when Beeminder is down, with a long error page.
// Expectata: the error, cut to a few lines that scroll, above the controls,
// and the big button and the controls still there.
// Resultata (before): the error filled the screen, leaving no big button.
qual('even a long error leaves room to count and to press every button', async (page, bee) => {
  await login(page)
  bee.reply = c => c.method === 'POST'
    ? [502, { errors: 'Bad gateway. '.repeat(500) }] : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await see(page, '#status', /502/)
  await expectError(page, bee, /502/)
  const big = await box(page, '#bigbut')
  assert.ok(big.height > PHONE.height / 2, JSON.stringify(big))
  // FINAL DESIGN: not Clear, which is in the menu
  for (const sel of ['#minusbut', '#undobut', '#infobut', '#goals',
                     '#subbut', '#loginbut']) {
    const b = await box(page, sel)
    assert.ok(b.y >= big.height && b.y + b.height <= PHONE.height,
              `${sel}: ${JSON.stringify(b)}`)
  }
  // The rest of the error is there to scroll to, and nothing of it spills out
  // over the controls
  assert.ok(await page.$eval('#status', s => { s.scrollTop = 40
                                               return s.scrollTop > 0 }))
  const s = await box(page, '#status')
  assert.ok(s.y + s.height <= (await box(page, '#undobut')).y, JSON.stringify(s))
})

// Replicata: tap 3 and Submit, with your finger over the buttons.
// Expectata: "Submitting…", and then the message that it worked, appear
// without moving any button.
// Resultata (before): the status line came after the buttons, beside the
// safesum, so a message too long to fit there, like the one saying the Submit
// worked, moved every button up.
qual('status messages move no button', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut', 3)
  const sels = ['#undobut', '#infobut', '#goals', '#subbut', '#loginbut']
  const where = () => Promise.all(sels.map(s => box(page, s)))
  const a = await where()
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  await see(page, '#status', /./)
  assert.deepEqual(await where(), a, 'while submitting')
  open(null)
  await see(page, '#status', /pushups/)
  assert.deepEqual(await where(), a, 'once submitted')
})

// Replicata: count pushups with the phone on the floor, touching your nose to
// the very bottom of the black area, just above the buttons.
// Expectata: each touch counts one more, like anywhere else.
// Resultata (before): Chrome gave a touch that close to a button to the
// button, so it undid a pushup rather than counting one, or cleared the count,
// or went off to log in.
qual('touches at the bottom edge of the big button count, and press no button', async page => {
  await login(page)
  await edgeTouches(page)
})

// Replicata: the same, with the footer folded.
// Expectata: the same, and the footer still folded.
// Resultata (in a mutant with neither of the two things that keep these
// touches for the big button: the room at the top of the footer, and the big
// button's taking the focus, which makes Chrome count it as something to tap):
// a touch that pressed −1.
qual('folded, touches at the bottom edge of the big button count, and press no button', async page => {
  await login(page)
  await tap(page, '#foldbut')
  await edgeTouches(page)
  assert.ok(!await unfolded(page))
})

// Tap 5, then touch the big button 1px above its bottom edge, over the middle
// of each control (that shows, and matches sels) along that edge, and assert
// that each touch counted one, and pressed nothing else
async function edgeTouches(page, sels = '.footer button, .footer select') {
  await tap(page, '#bigbut', 5)
  const edge = await page.$eval('#bigbut', e => e.getBoundingClientRect().bottom)
  // The middles of the controls along the big button's bottom edge
  const xs = await page.$$eval(sels, (es, edge) => es
    .map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.top < edge + 60)
    .map(r => r.x + r.width / 2), edge)
  // SPEC CHANGE (was >= 3): unfolded, the row along the edge has two controls,
  // Clear and the login button, beside the safesum, in the approved design
  assert.ok(xs.length >= 2, JSON.stringify(xs))
  const cdp = await page.context().newCDPSession(page)
  let n = 5
  for (const x of xs) {
    // A touch 1px above the edge, as big as the biggest that Chrome looks
    // around for something clickable within (see .footer in style.css)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart',
      touchPoints: [{ x, y: edge - 1, radiusX: 16, radiusY: 16 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await see(page, '#bigbut', String(++n))
  }
  assert.equal(page.url(), APP + '?goal=pushups')
  assert.ok(!await page.$eval('#info', d => d.open))
}

// Replicata: tap the big blue number, watching it for any flicker.
// Expectata: the number changes, and that's all.
// Resultata (before): each tap dimmed it, and faded it back in over 150ms, and
// in Chrome on Android flashed translucent blue over the whole black area.
qual("the count doesn't flicker when it goes up", async page => {
  await login(page)
  // How many animations the big button, count included, has as each tap lands
  await page.evaluate(() => { window.flashes = []
    addEventListener('pointerup', () => window.flashes.push(document
      .getElementById('bigbut').getAnimations({ subtree: true }).length)) })
  await tap(page, '#bigbut', 3)
  assert.deepEqual(await page.evaluate(() => window.flashes), [0, 0, 0])
  assert.equal(await page.$eval('#bigbut', e =>
    getComputedStyle(e).webkitTapHighlightColor), 'rgba(0, 0, 0, 0)')
})

// Replicata: in Chrome on Android, tap a button.
// Expectata: the button looks pressed, and nothing else.
// Resultata (before): Chrome also flashed its tap highlight over it, a
// translucent blue rectangle, even over a round button.
qual('tapping a button flashes no rectangle over it', async page => {
  await login(page)
  await tap(page, '#infobut')
  const flashers = await page.$$eval('.footer button, .footer select, #info .close',
    es => es.filter(e => getComputedStyle(e).webkitTapHighlightColor !==
                         'rgba(0, 0, 0, 0)').map(e => e.id || e.className))
  assert.deepEqual(flashers, [])
})

// Replicata: on a phone, tap −1.
// Expectata: −1 looks pressed while touched, and then as it did before, not
// stuck with the lighter color it gets under a mouse (phones treat the last
// thing tapped as under the mouse).
// Resultata (in a mutant that showed hover colors on phones too): −1 stuck in
// its hover color.
qual('a tapped button goes back to how it looked', async page => {
  await login(page)
  await tap(page, '#bigbut', 2)
  const fill = () => page.$eval('#minusbut', e => getComputedStyle(e).backgroundColor)
  const rest = await fill()
  await tap(page, '#minusbut')
  // Chrome shows a tap as a press for at least 150ms, and the fade back only
  // starts after that
  await page.waitForFunction(() => !document.querySelector('#minusbut').matches(':active'))
  await still(page, '#minusbut') // the fade back
  assert.equal(await fill(), rest)
})

// Replicata: tap 3 and press Submit.
// Expectata: Submit turns gray at once.
// Resultata (in a draft of the redesign): it faded from yellow to gray through
// a muddy olive.
qual('Submit grays out at once, without fading', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut', 3)
  // How many animations Submit has each time it's grayed out (coming back, it
  // can fade in)
  await page.$eval('#subbut', b => { window.fades = []
    new MutationObserver(() => b.disabled && window.fades.push(b.getAnimations().length))
      .observe(b, { attributeFilter: ['disabled'] }) })
  await tap(page, '#subbut')
  await calls(page, bee, LOAD + 1)
  open(null)
  await see(page, '#bigbut', '0')
  const fades = await page.evaluate(() => window.fades)
  assert.ok(fades.length > 0 && fades.every(n => n === 0), JSON.stringify(fades))
})

// Replicata: tap from 11 up to 18.
// Expectata: nothing in the footer moves.
// Resultata (before): the dropdown and Submit moved with each digit, since
// some digits were narrower than others.
qual('nothing in the footer shifts sideways as the count changes, till it gets another digit', async page => {
  await login(page)
  await tap(page, '#bigbut', 11)
  const a = [await box(page, '#goals'), await box(page, '#subbut')]
  await tap(page, '#bigbut', 7)
  assert.deepEqual([await box(page, '#goals'), await box(page, '#subbut')], a)
})

// Replicata: open TallyBee, tap 3, and log in, watching the empty dropdown
// and Submit.
// Expectata: the dropdown, empty till then, is the same size before and after,
// and Submit stays put.
// Resultata (before): the empty dropdown was a sliver, which then grew to fit
// the goal's name, pushing Submit over.
qual('the dropdown and Submit stay put as the goals load', async page => {
  await page.goto(APP)
  await tap(page, '#bigbut', 3)
  const a = [await box(page, '#goals'), await box(page, '#subbut')]
  await login(page)
  assert.deepEqual([await box(page, '#goals'), await box(page, '#subbut')], a)
})

// Replicata: open TallyBee without logging in, and look at the send row.
// Expectata: the dropdown, the goal's link, the day and Submit grayed out,
// with no goal to send to; the number to send not, as it can be typed (see
// "logged out, the number and the comment can still be typed").
// Resultata (before): the empty dropdown, though it looked grayed out, could
// still be opened.
qual('logged out, what needs a goal is grayed out', async page => {
  await page.goto(APP)
  await tap(page, '#bigbut', 3)
  assert.ok(await disabled(page, '#goals'))
  assert.ok(await disabled(page, '#day'))
  assert.ok(await disabled(page, '#subbut'))
  for (const sel of ['#goals', '#goallink', '#day', '#subbut'])
    assert.ok(await opacity(page, sel) < 0.5, sel)
  assert.equal(await opacity(page, '#num'), 1)
})

// The ids of the footer's controls smaller than 44 by 44 px, the smallest that
// Apple recommends for fingers
// FINAL DESIGN: but the username, logged in, plain text (a disabled login
// button), one line of words
const small = page => page.$$eval('.footer :is(button, select, input, a):not(#loginbut:disabled)', es => es
  .map(e => [e.id, e.getBoundingClientRect()])
  .filter(([, r]) => r.width < 44 || r.height < 44).map(([id]) => id))

// Replicata: tap the controls, with a finger.
// Expectata: each at least 44 by 44 px.
// Resultata (before): 40px tall, and the ? 40px wide.
qual('every control is at least 44 by 44 px, for fingers', async page => {
  await login(page)
  assert.deepEqual(await small(page), [])
  await tap(page, '#infobut')
  const x = await box(page, '#info .close')
  assert.ok(x.width >= 44 && x.height >= 44, JSON.stringify(x))
})

// Replicata: on a phone as narrow as 280px, like the first Galaxy Fold's front
// screen, tap 1234 times.
// Expectata: still, every control at least 44 by 44 px.
// Resultata (in a draft of this round): the dropdown squeezed to 43px wide,
// with no room for any of the goal's name.
qual('every control is at least 44 by 44 px, even on a 280px phone', async page => {
  await login(page)
  await taps(page, 1234)
  await see(page, '#num', '1234')
  assert.deepEqual(await small(page), [])
}, { viewport: { width: 280, height: 653 } })

// Replicata: use TallyBee with a mouse.
// Expectata: the hand over whatever can be clicked, which changes color when
// the mouse is over it, and again when pressed, and the plain arrow over what's
// grayed out, like UNDO with nothing to undo.
// Resultata (before): the arrow over all the buttons, which didn't change when
// hovered or pressed.
qual('with a mouse, what can be clicked looks clickable', async page => {
  await login(page)
  assert.equal(await page.$eval('#undobut', e => getComputedStyle(e).cursor), 'default',
               'UNDO, with nothing to undo')
  await tap(page, '#bigbut') // so there's something to undo
  const fill = sel => page.$eval(sel, e => getComputedStyle(e).backgroundColor)
  const cursor = sel => page.$eval(sel, e => getComputedStyle(e).cursor)
  assert.equal(await cursor('#bigbut'), 'pointer')
  const looks = async sel => {
    assert.equal(await cursor(sel), 'pointer', sel)
    await page.mouse.move(0, 0)
    await still(page, sel) // the fade back
    const rest = await fill(sel)
    await page.hover(sel)
    await still(page, sel) // the fade in
    const hover = await fill(sel)
    assert.notEqual(hover, rest, `${sel} under the mouse`)
    await page.mouse.down()
    assert.notEqual(await fill(sel), hover, `${sel} pressed`)
    await page.mouse.move(0, 0) // so letting go doesn't click it
    await page.mouse.up()
  }
  for (const sel of ['#minusbut', '#undobut', '#infobut', '#goals',
                     '#day', '#goallink', '#subbut', '#foldbut']) await looks(sel)
  assert.equal(await cursor('#loginbut'), 'default') // the username: see its qual
  await tap(page, '#infobut')
  await still(page, '#info')
  await looks('#info .close')
  // FINAL DESIGN: Clear, in the menu (opened again, as letting go of the mouse
  // outside the menu closes it)
  await tap(page, '#infobut')
  await still(page, '#info')
  await looks('#clearbut')
}, DESK)

// Replicata: on a computer, click the big button, and press Tab; then open the
// help, with Enter on the ?.
// Expectata: a clear ring around Clear, the first control, and then around the
// help's ×: at least 2px thick, apart from the button, with a contrast of at
// least 3:1 against what's around it (WCAG's "focus appearance").
// Resultata (before): each browser's own ring (Chrome's is of the style
// "auto", which the browser draws however it likes).
// SPEC CHANGE (following from the owner's answer to question 9 in AGENTS.md,
// that Clear be grayed out at 0, which takes it out of the Tab order): a click
// on the big button first, so that there's a tally for Clear to clear.
qual('the keyboard focus shows clearly', async page => {
  await login(page)
  await page.click('#bigbut')
  // The ring around the focused element, and the color around the ring
  const ring = () => page.evaluate(() => {
    const e = document.activeElement, s = getComputedStyle(e)
    return { id: e.id || e.className, style: s.outlineStyle,
             width: parseFloat(s.outlineWidth), offset: parseFloat(s.outlineOffset),
             color: s.outlineColor,
             around: getComputedStyle(e.closest('.footer, .modal-header')).backgroundColor }
  })
  await page.keyboard.press('Tab')
  const first = await ring()
  await page.focus('#infobut')
  await page.keyboard.press('Enter')
  const close = await ring()
  // FINAL DESIGN: the day, with Clear in the menu
  assert.deepEqual([first.id, close.id], ['day', 'close'])
  for (const r of [first, close]) {
    assert.equal(r.style, 'solid', JSON.stringify(r))
    assert.ok(r.width >= 2 && r.offset > 0, JSON.stringify(r))
    assert.ok(contrast(r.color, r.around) >= 3, JSON.stringify(r))
  }
}, DESK)

// Replicata: press Tab, on a computer, through every control in the footer,
// unfolded, and then folded.
// Expectata: the ring around each, whole: none of it cut off by what's around
// it.
// Resultata (with the drawer, which can scroll, leaving no room for them, as
// it could): the drawer cut off the outer edge of the rings of the controls
// along its edges, like Clear's.
qual('the ring that shows where the keyboard is shows whole, around every control', async page => {
  await login(page)
  await tap(page, '#bigbut') // so that UNDO and Submit can take the focus
  for (const n of [9, 4]) {
    await page.focus('#bigbut')
    for (let i = 0; i < n; i++) {
      await page.keyboard.press('Tab')
      const id = await page.evaluate(() => document.activeElement.id)
      const reach = await page.$eval('#' + id, e => { const s = getComputedStyle(e)
        return parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth) })
      assert.equal(await clipper(page, '#' + id, reach), null, id)
    }
    await page.click('#foldbut')
  }
}, DESK)

// Replicata: on a computer zoomed in so far that the window is like a 200x433
// screen, with long names, so that the drawer is too short for its rows, and
// scrolls, press Tab through the footer, and Shift+Tab back.
// Expectata: the ring around each control whole, as on a big screen.
// Resultata: the drawer scrolled each control only just into view, cutting
// off the bottom of the rings of the comment field and the ?, and, going
// back, the top of Clear's.
qual('the ring that shows where the keyboard is shows whole, even where the drawer scrolls', async (page, bee) => {
  bee.goals.push({ slug: 'reading-for-the-book-club', kyoom: true, curval: 0,
                   deadline: 0, last_datapoint: null, safesum: 'safe for 9 days', queued: false })
  await login(page, 'christophermoravec')
  await taps(page, 1) // so that UNDO and Submit can take the focus
  assert.ok(await page.$eval('#drawer', d => d.scrollHeight > d.clientHeight), 'scrolls')
  await page.focus('#bigbut')
  for (const key of [...Array(9).fill('Tab'), ...Array(8).fill('Shift+Tab')]) {
    await page.keyboard.press(key)
    const id = await page.evaluate(() => document.activeElement.id)
    const reach = await page.$eval('#' + id, e => { const s = getComputedStyle(e)
      return parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth) })
    assert.equal(await clipper(page, '#' + id, reach), null, `${key} to ${id}`)
  }
}, { ...DESK, viewport: { width: 200, height: 433 } })

// Replicata: use TallyBee with a screen reader.
// Expectata: the page in English; the dropdowns, the number to send, and the
// goal's link called by a word; the ? and × buttons called by a word, not
// "question mark" and "times"; and the help called TallyBee.
// Resultata (before): none of that.
qual('screen readers get names for the dropdowns, the number, the link, the ? and × buttons, and the help', async page => {
  await login(page)
  assert.equal(await page.getAttribute('html', 'lang'), 'en')
  for (const [role, sel] of [['combobox', '#goals'], ['combobox', '#day'],
                             ['textbox', '#num'], ['link', '#goallink']]) {
    const name = await page.getAttribute(sel, 'aria-label') ?? ''
    assert.match(name, /^\p{L}{2,}/u, sel)
    assert.equal(await page.getByRole(role, { name, exact: true }).count(), 1, sel)
  }
  await tap(page, '#infobut')
  assert.equal(await page.getByRole('dialog', { name: 'TallyBee' }).count(), 1)
  for (const sel of ['#infobut', '#info .close'])
    assert.match(await page.getAttribute(sel, 'aria-label') ?? '', /^\p{L}{2,}/u, sel)
})

// Replicata: with a screen reader, open TallyBee, logged out, tap 2, and move
// through the page: the big button, then the footer.
// Expectata: the big button says what it's for, as its description, in the
// help's own words: "Just tap/click your screen to keep count of
// something."; and the goal's link, which is no link while there's no goal,
// says nothing then, rather than its arrow.
// Resultata (before): the big button only "2", and in the footer, "↗".
qual('screen readers hear what the big button is for, and no bare arrow', async page => {
  await page.goto(APP)
  await tap(page, '#bigbut', 2)
  const cdp = await page.context().newCDPSession(page)
  const { result } = await cdp.send('Runtime.evaluate',
                                    { expression: "document.getElementById('bigbut')" })
  const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId })
  const { nodes: [ax] } = await cdp.send('Accessibility.getPartialAXTree',
    { backendNodeId: node.backendNodeId, fetchRelatives: false })
  assert.equal(ax.description?.value,
               'Just tap/click your screen to keep count of something.')
  const footer = await page.locator('.footer').ariaSnapshot()
  assert.ok(!footer.includes('↗'), footer)
})

// Replicata: open TallyBee on a slow connection, and look at it before it's
// done loading.
// Expectata: the dropdown, Submit and UNDO grayed out, as they are once it has
// loaded, with nothing to submit or undo.
// Resultata (before): Submit, yellow, looking ready to use, till script.js
// ran.
qual('the dropdown, Submit and UNDO start out grayed out, before script.js runs', async page => {
  const [shut, open] = gate()
  await page.route(APP + 'script.js', r => shut.then(() => serve(r)))
  await page.goto(APP, { waitUntil: 'commit' })
  await page.waitForSelector('#subbut', { state: 'attached' })
  assert.ok(await disabled(page, '#goals'))
  assert.ok(await disabled(page, '#subbut'))
  assert.ok(await disabled(page, '#undobut'))
  open()
})

// Replicata: open the dropdown's list of goals, in a browser that draws it
// (like Chrome on a computer).
// Expectata: it's dark, like the rest of TallyBee.
// Resultata (before): white.
qual("what the browser draws itself, like the dropdown's list, is dark", async page => {
  await page.goto(APP)
  // A dropdown that TallyBee's CSS doesn't style, as the browser draws it
  const bg = await page.evaluate(() => getComputedStyle(document.body
    .appendChild(document.createElement('select'))).backgroundColor)
  assert.ok(contrast(bg, 'rgb(255, 255, 255)') > 4.5, bg)
})

// ------------------------------------------- FINAL DESIGN: new quals

// Replicata: log in; fold the footer; tap the top line's words; pick pages.
// Expectata: at the very top of the screen, folded or not, the goal's name and
// its safesum; the tap counts, like any on the black; and pages' name and
// safesum once it's picked.
qual('the top line shows the goal and its safesum, folded or not, and a tap on it counts', async page => {
  await page.goto(APP)
  assert.equal(await page.textContent('#topline'), ' ', 'logged out, with no goal')
  await login(page)
  await see(page, '#goalname', 'pushups')
  await see(page, '#safesum', '+2 pushups due by 12am')
  await tap(page, '#foldbut')
  assert.ok(await page.isVisible('#goalname') && await page.isVisible('#safesum'))
  const t = await box(page, '#topline')
  assert.ok(t.y === 0, JSON.stringify(t))
  const s = await box(page, '#safesum')
  await page.touchscreen.tap(s.x + s.width / 2, s.y + s.height / 2)
  await see(page, '#bigbut', '1')
  await tap(page, '#foldbut')
  await choose(page, 'pages')
  await see(page, '#goalname', 'pages')
  await see(page, '#safesum', 'safe for 3 days')
})

// Replicata: with a long safesum, tap 888 (the count as big as it gets), on
// phones big and small, with text at 200%, and sideways, folded and not.
// Expectata: the top line never over the count, and only whole lines of it
// (all of them, where there's room).
for (const [width, height] of [[390, 844], [320, 568], [844, 390], [568, 320],
                               [195, 422], [188, 334]])
  qual(`the top line never covers the count, and shows only whole lines (${width}x${height})`, async (page, bee) => {
    bee.goals[0].safesum = '+0.73 chapters due in 2 days by 11:59pm'
    await login(page)
    await taps(page, 888)
    for (const fold of [false, true]) {
      const [t, c, pad, all] = await page.evaluate(() => {
        const t = document.getElementById('topline')
        return [t.getBoundingClientRect().toJSON(),
                document.getElementById('count').getBoundingClientRect().toJSON(),
                parseFloat(getComputedStyle(t).paddingTop), t.scrollHeight]
      })
      assert.ok(t.bottom <= c.top, JSON.stringify({ fold, t, c }))
      assert.equal((t.height - pad) % 20, 0, JSON.stringify({ fold, t }))
      if (width >= 320) assert.equal(t.height, all, JSON.stringify({ fold, t, all }))
      await tap(page, '#foldbut')
    }
  }, { viewport: { width, height } })

// Replicata: unfolded, logged in, count pushups with a nose that lands a
// little below the black area, 20 to 32px (3 to 5mm) below it, anywhere
// across the screen.
// Expectata: nothing pressed: no field, no dropdown, no menu, nothing counted
// or cleared.
// Resultata (before): Clear, at the left.
qual('unfolded, a touch a little below the big button presses nothing', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  const edge = await page.$eval('#bigbut', e => e.getBoundingClientRect().bottom)
  const cdp = await page.context().newCDPSession(page)
  for (const dy of [20, 24, 28, 32]) for (const fx of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart',
      touchPoints: [{ x: PHONE.width * fx, y: edge + dy, radiusX: 16, radiusY: 16 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await settled(page)
  assert.equal(await count(page), 3)
  assert.ok(!await page.$eval('#info', d => d.open))
  assert.ok(['bigbut', ''].includes(await page.evaluate(() => document.activeElement.id)),
            await page.evaluate(() => document.activeElement.id))
  assert.equal(page.url(), APP + '?goal=pushups')
})
