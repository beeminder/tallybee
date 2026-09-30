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

// Alice's goals as the fake Beeminder returns them, trimmed to the fields that
// matter here. "pages" is an odometer-style (non-cumulative) goal whose curval
// differs from its last datapoint, like after an odometer reset. "newodo" is a
// non-cumulative goal with no datapoints yet. None is queued (being updated by
// Beeminder, as after it gets a datapoint).
const GOALS = [
  { slug: 'pushups', kyoom: true,  curval: 50,  last_datapoint: { value: 3 },
    safesum: '+2 pushups due by 12am', queued: false },
  { slug: 'pages',   kyoom: false, curval: 320, last_datapoint: { value: 120 },
    safesum: 'safe for 3 days', queued: false },
  { slug: 'newodo',  kyoom: false, curval: 7,   last_datapoint: null,
    safesum: 'safe for 1 day', queued: false },
]

// A desktop computer, with a mouse and a keyboard and no touchscreen, for
// quals that pass it as the options for the browser context
const DESK = { viewport: { width: 1280, height: 800 }, hasTouch: false,
               isMobile: false }

let browser
before(async () => { browser = await chromium.launch({ channel: 'chrome' }) })
after(() => browser.close())

// Define a qual. The function f gets a fresh page and the fake Beeminder's
// state, bee, which records every API call in bee.calls and every authorize
// redirect in bee.authorizes, and accepts the access tokens in bee.tokens.
// Setting bee.reply to a function lets a qual override the fake's reply to an
// API call: return [status, body], or 'abort' for a network failure, or a
// promise of either, or null for the default. Options for the browser context,
// like viewport, go in opts.
function qual(name, f, opts = {}) {
  test(name, async () => {
    const context = await browser.newContext({ viewport: PHONE, hasTouch: true,
                                               isMobile: true, ...opts })
    const bee = { goals: structuredClone(GOALS), added: {}, tokens: [TOKEN],
                  calls: [], authorizes: [], strays: [], errors: [],
                  reply: () => null }
    // Every page, including second windows, reports its uncaught errors
    context.on('page', p => {
      p.setDefaultTimeout(3000)
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
  const body = req.postData() ?? ''
  const json = /json/.test(await req.headerValue('content-type'))
  const params = Object.fromEntries([...url.searchParams,
    ...(json ? Object.entries(JSON.parse(body)) : new URLSearchParams(body))])
  // Like the real Beeminder, expand "me" to the user the token belongs to
  const path = url.pathname.slice(8).replace(/^users\/me\b/, 'users/alice')
  const call = { method: req.method(), path, params }
  const cors = { 'access-control-allow-origin': '*',
                 'access-control-allow-headers': 'content-type' }
  if (call.method === 'OPTIONS') return route.fulfill({ status: 200, headers: cors })
  bee.calls.push(call)
  const reply = await bee.reply(call) ?? defaultReply(bee, call)
  if (reply === 'abort') return route.abort('internetdisconnected')
  const [status, data] = reply
  return route.fulfill({ status, headers: cors, contentType: 'application/json',
                         body: JSON.stringify(data) })
}

function defaultReply(bee, { method, path, params }) {
  const dp = path.match(/^users\/alice\/goals\/([^/]+)\/datapoints\.json$/)
  if (!bee.tokens.includes(params.access_token)) return [401, { errors: {
    access_token: 'bad_token', message: 'No such access token found.' } }]
  if (method === 'GET' && path === 'users/alice/goals.json')
    return [200, bee.goals]
  // A goal's datapoints, the one added last first. The fake knows only that
  // one: bee.added's, if set (as after a POST, or after an older one got
  // edited, which makes that the goal's last_datapoint), else the goal's
  // last_datapoint.
  if (method === 'GET' && dp) return [200, [bee.added[dp[1]] ??
    bee.goals.find(g => g.slug === dp[1]).last_datapoint].filter(Boolean)]
  if (method === 'POST' && dp) return [200, bee.added[dp[1]] = {
    id: `dp${bee.calls.length}`, value: Number(params.value),
    comment: params.comment, requestid: params.requestid }]
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

// Wait up to 3 seconds for the text of the element matching selector sel to
// match want (a string for exact match or else a regex)
async function see(page, sel, want) {
  const ok = s => typeof want === 'string' ? s === want : want.test(s)
  let s
  for (let i = 0; i < 30; i++) {
    s = await page.locator(sel).first().textContent()
    if (ok(s)) return
    await page.waitForTimeout(100)
  }
  assert.fail(`${sel} says ${JSON.stringify(s)} instead of ${want}`)
}

// Wait up to 3 seconds for an uncaught error matching regex re, and forgive it
async function expectError(page, bee, re) {
  for (let i = 0; i < 30 && !bee.errors.some(e => re.test(e)); i++)
    await page.waitForTimeout(100)
  const i = bee.errors.findIndex(e => re.test(e))
  assert.ok(i >= 0, `no uncaught error matching ${re}: ${bee.errors}`)
  bee.errors.splice(i, 1)
}

// Wait up to 3 seconds for the fake Beeminder to have received n calls
async function calls(page, bee, n) {
  for (let i = 0; i < 30 && bee.calls.length < n; i++) await page.waitForTimeout(100)
  assert.equal(bee.calls.length, n, JSON.stringify(bee.calls))
}

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

// Tap the big button n times, all at once, which is faster than tap for big n
const taps = (page, n) => page.evaluate(n => {
  const b = document.getElementById('bigbut')
  for (let i = 0; i < n; i++)
    b.dispatchEvent(new PointerEvent('pointerup', { isPrimary: true, bubbles: true }))
}, n)

const count = async page => Number(await page.textContent('#bigbut'))
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

// Where on the screen the element matching sel is
const box = (page, sel) => page.locator(sel).boundingBox()

// Assert that every control in the footer, and its texts, are whole and on the
// screen, with nothing sticking out sideways, and none on top of another
async function fits(page) {
  const { width, height } = page.viewportSize()
  const sels = ['#undobut', '#clearbut', '#loginbut', '#infobut', '#num',
                '#goals', '#subbut', '#safesum', '.versiontag']
  const boxes = await Promise.all(sels.map(s => box(page, s)))
  assert.ok(await page.$eval('.footer', (f, w) => f.scrollWidth <= w, width))
  boxes.forEach((b, i) => assert.ok(b.x >= 0 && b.x + b.width <= width &&
    b.y >= 0 && b.y + b.height <= height, `${sels[i]} off screen: ${JSON.stringify(b)}`))
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b, j) => assert.ok(
    a.x + a.width <= b.x || b.x + b.width <= a.x ||
    a.y + a.height <= b.y || b.y + b.height <= a.y,
    `${sels[i]} overlaps ${sels[i + 1 + j]}`)))
}

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

// The access token must not stay in the page's URL: not in the address bar,
// and not in the URL the page was loaded from, which is what an app installed
// or a home-screen icon made from the page would open
qual('logging in loads the page again without the access token in the URL', async page => {
  await login(page)
  assert.equal(page.url(), APP + '?goal=pushups')
  assert.equal(await page.evaluate(() =>
    performance.getEntriesByType('navigation')[0].name), APP)
})

qual('denying access shows why, leaves the counter working, and does not loop', async (page, bee) => {
  await page.goto(denied(await authorize(page)))
  await see(page, '#status', /The user denied you access/)
  await expectError(page, bee, /The user denied you access/)
  await tap(page, '#bigbut', 2)
  assert.equal(await count(page), 2)
  assert.ok(await disabled(page, '#subbut'), 'Submit with no goal to submit to')
  assert.equal(bee.authorizes.length, 1)
})

// Replicata: logged in as alice with 2 counted, press the login button (to log
// in as someone else, say) and say no at Beeminder.
// Expectata: the error, plus alice's goals, still logged in.
// Resultata (before): the error, but no goals.
qual('denying access while logged in still loads your goals', async (page, bee) => {
  await login(page)
  await tap(page, '#bigbut', 2)
  await page.goto(denied(await authorize(page)))
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
  await expectError(page, bee, new RegExp(UNASKED))
  assert.deepEqual(JSON.parse(await stored(page)), { token: TOKEN, user: 'alice' })
  assert.doesNotMatch(page.url(), /access_token|evil/)
})

qual("a link with a login error you didn't ask for shows none of its text", async (page, bee) => {
  await page.goto(`${APP}?error=Beeminder+has+moved&error_description=log+in+elsewhere`)
  await see(page, '#status', `Error: ${UNASKED}`)
  await expectError(page, bee, new RegExp(UNASKED))
  assert.doesNotMatch(page.url(), /error|moved|elsewhere/)
})

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

qual("a link with an access token is ignored even after an unfinished login", async (page, bee) => {
  await authorize(page) // and then don't log in
  await page.goto(`${APP}?access_token=evil&username=alice`)
  await see(page, '#status', `Error: ${UNASKED}`)
  await expectError(page, bee, new RegExp(UNASKED))
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
  await expectError(page, bee, new RegExp(REAUTH))
  await see(page, '#loginbut', NOTALICE)
  assert.equal(await stored(page), null)
})

qual('a token Beeminder rejects when submitting gets forgotten, keeping the count', async (page, bee) => {
  await login(page)
  await tap(page, '#bigbut', 3)
  bee.reply = () => [401, { errors: { message: 'No such access token found.' } }]
  await tap(page, '#subbut')
  await see(page, '#status', `Error: ${REAUTH}`)
  await expectError(page, bee, new RegExp(REAUTH))
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

// Replicata: TallyBee in two windows. One has a Submit out to Beeminder with
// the access token we had, when the other logs in again, which gets a new
// token (so Beeminder rejects the old one, with a 401, to the first window).
// Expectata: still logged in, with the new token.
qual("a 401 for an old token doesn't log out a newer login", async (page, bee) => {
  await login(page)
  const w = await window2(page, APP)
  await see(w, '#goals', /pushups/)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut.then(() => null) : null
  await w.bringToFront()
  await tap(w, '#bigbut')
  await tap(w, '#subbut')
  await calls(page, bee, 3)
  await page.bringToFront()
  const state = await authorize(page)
  bee.tokens = ['tok456']
  await page.goto(`${APP}?` +
    new URLSearchParams({ access_token: 'tok456', username: 'alice', state }))
  open()
  await expectError(page, bee, new RegExp(REAUTH))
  await see(page, '#goals', /pushups/)
  assert.deepEqual(JSON.parse(await stored(page)), { token: 'tok456', user: 'alice' })
})

qual('a window that stays in view gets the goals when another window logs in', async page => {
  await page.goto(APP)
  const w = await window2(page, APP)
  await login(w)
  await page.bringToFront()
  await see(page, '#goals', /pushups/)
  await see(page, '#loginbut', 'alice')
})

qual('switching tabs while logged out calls no Beeminder', async (page, bee) => {
  await page.goto(APP)
  await comeback(page)
  await page.waitForTimeout(300)
  assert.deepEqual(bee.calls, [])
  assert.notEqual(await page.getAttribute('#status', 'data-kind'), 'err')
})

// --------------------------------------------------------------- counting

qual('each tap adds one', async page => {
  await login(page)
  assert.equal(await count(page), 0)
  await tap(page, '#bigbut', 3)
  assert.equal(await count(page), 3)
})

// Replicata: put the phone on the floor and hold your nose on the screen for a
// second at the bottom of a pushup.
// Expectata: that counts as a pushup, like in Beedroid.
qual('a long press counts (noses are slow)', async page => {
  await login(page)
  await page.evaluate(() => { window.menus = 0
    addEventListener('contextmenu', () => window.menus++) })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.synthesizeTapGesture', { x: 200, y: 300, duration: 1200,
    tapCount: 1, gestureSourceType: 'touch' })
  assert.equal(await count(page), 1)
  // A long press it was, the kind that makes no click, just a context menu
  assert.equal(await page.evaluate(() => window.menus), 1)
})

qual('touching with two fingers (or nose and chin) at once counts once', async page => {
  await login(page)
  await touch(page, [[150, 300], [250, 350]], 50)
  assert.equal(await count(page), 1)
})

qual('each tap buzzes for 25ms like in Beedroid', async page => {
  await login(page)
  await tap(page, '#bigbut', 2)
  assert.deepEqual(await page.evaluate(() => window.buzzes), [25, 25])
})

qual('tapping works on phones that cannot buzz, like iPhones', async page => {
  await login(page)
  await page.evaluate(() => { delete navigator.vibrate
                              delete Navigator.prototype.vibrate })
  await tap(page, '#bigbut', 2)
  assert.equal(await count(page), 2)
})

qual('UNDO subtracts one, even below zero', async page => {
  await login(page)
  await tap(page, '#bigbut')
  await tap(page, '#undobut', 3)
  assert.equal(await count(page), -2)
})

qual('the clear button zeroes the count', async page => {
  await login(page)
  await tap(page, '#bigbut', 3)
  await tap(page, '#clearbut')
  await see(page, '#bigbut', '0')
})

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

// Beedroid shrinks the count when it gets past 9999
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

// ------------------------------------------------------------- submitting

qual('Submit is grayed out till there is a count to submit', async page => {
  await login(page)
  assert.ok(await disabled(page, '#subbut'))
  await tap(page, '#bigbut')
  assert.ok(!await disabled(page, '#subbut'))
  await tap(page, '#undobut')
  assert.ok(await disabled(page, '#subbut'))
})

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
qual('Submit shows it is busy and taps made meanwhile are kept', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, 2)
  assert.ok(await disabled(page, '#subbut'))
  assert.equal(await page.getAttribute('#status', 'data-kind'), 'busy')
  await tap(page, '#bigbut', 2)
  open(null)
  await see(page, '#bigbut', '2')
  assert.deepEqual(values(bee), ['3'])
  assert.ok(!await disabled(page, '#subbut'))
})

qual('an infinibee flies figure eights while Beeminder takes the datapoint', async (page, bee) => {
  await login(page)
  assert.ok(!await page.isVisible('#infinibee'))
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut')
  await tap(page, '#subbut')
  await calls(page, bee, 2)
  assert.ok(await page.isVisible('#infinibee'))
  await page.$eval('#infinibee image', i => i.decode()) // the artwork is there
  const a = await box(page, '#infinibee image')
  await page.waitForTimeout(250)
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

qual('the infinibee holds still for people who ask their device for less motion', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut')
  await tap(page, '#subbut')
  await calls(page, bee, 2)
  assert.ok(await page.isVisible('#infinibee'))
  const a = await box(page, '#infinibee image')
  await page.waitForTimeout(250)
  assert.deepEqual(await box(page, '#infinibee image'), a)
  open(null)
  await see(page, '#bigbut', '0')
}, { reducedMotion: 'reduce' })

// Replicata: tap 3, hit Submit, and hit Clear before Beeminder replies.
// Expectata: Clear can't be pressed till then.
// Resultata (before): the count ended up at -3, with Submit enabled.
qual('Clear is grayed out while Beeminder takes the datapoint', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, 2)
  assert.ok(await disabled(page, '#clearbut'))
  open(null)
  await see(page, '#bigbut', '0')
  assert.ok(!await disabled(page, '#clearbut'))
})

qual('the goal dropdown is grayed out while Beeminder takes the datapoint', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'POST' ? shut : null
  await tap(page, '#bigbut')
  await tap(page, '#subbut')
  await calls(page, bee, 2)
  assert.ok(await disabled(page, '#goals'))
  open(null)
  await see(page, '#bigbut', '0')
  assert.ok(!await disabled(page, '#goals'))
})

// Replicata: a refresh of the goals is under way (as when you come back to
// TallyBee) when you tap 3 and Submit, then tap 2 more before Beeminder
// answers the refresh.
// Expectata: 3 gets submitted, and the 2 stay counted.
qual('Submit sends the count from when it was tapped, even while waiting its turn', async (page, bee) => {
  await login(page)
  const [shut, open] = gate()
  bee.reply = c => c.method === 'GET' ? shut.then(() => null) : null
  await comeback(page)
  await calls(page, bee, 2)
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
  await calls(page, bee, 3)
  await w.bringToFront()
  await tap(w, '#clearbut')
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
  await calls(page, bee, 3)
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
  await calls(page, bee, 2)
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
  await tap(page, '#clearbut')
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

qual('negative counts can be submitted, like in Beedroid', async (page, bee) => {
  await login(page)
  await tap(page, '#undobut', 2)
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.deepEqual(values(bee), ['-2'])
})

// Beedroid treats non-cumulative goals like odometers: the tally starts from
// the last datapoint and what's submitted is the new total.
qual('for a non-cumulative goal the count adds to the last datapoint', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  await see(page, '#num', '120')
  await tap(page, '#bigbut', 3)
  await see(page, '#num', '123')
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  await see(page, '#num', '123')
  await tap(page, '#bigbut', 2)
  await see(page, '#num', '125')
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.deepEqual(values(bee), ['123', '125'])
})

qual('a non-cumulative goal with no datapoints starts from its current value', async page => {
  await login(page)
  await choose(page, 'newodo')
  await tap(page, '#bigbut')
  await see(page, '#num', '8')
})

qual('the footer shows what Submit will send', async page => {
  await login(page)
  await see(page, '#num', '0')
  await tap(page, '#bigbut', 2)
  await see(page, '#num', '2')
})

// Replicata: on odometer goal pages (at 120), tap 3 and Submit. Beeminder saves
// 123, but its reply is lost. Switch away and back, which refreshes the goals,
// now at 123, and Submit again.
// Expectata: the resend is 123 again, updating that datapoint in place.
// Resultata (before): 126, as if 3 more pages.
qual('resending an odometer datapoint after a lost reply sends the same value', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  bee.reply = c => {
    if (c.method !== 'POST') return null
    bee.goals[1].last_datapoint = { value: Number(c.params.value),
                                    requestid: c.params.requestid }
    bee.goals[1].safesum = 'safe for 4 days'
    return 'abort'
  }
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  await comeback(page)
  await see(page, '#safesum', 'safe for 4 days')
  await see(page, '#num', '123')
  bee.reply = () => null
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
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
  bee.reply = c => {
    if (c.method !== 'POST') return null
    bee.goals[1].last_datapoint = { value: Number(c.params.value),
                                    requestid: c.params.requestid }
    bee.goals[1].safesum = 'safe for 4 days'
    return 'abort'
  }
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await expectError(page, bee, /fetch/i)
  bee.reply = () => null
  await comeback(page)
  await see(page, '#safesum', 'safe for 4 days')
  await tap(page, '#clearbut')
  await see(page, '#bigbut', '0')
  await tap(page, '#bigbut', 2)
  await see(page, '#num', '125')
  await tap(page, '#subbut')
  await see(page, '#bigbut', '0')
  assert.deepEqual(values(bee), ['123', '125'])
  const [a, b] = posts(bee).map(p => p.params.requestid)
  assert.notEqual(a, b)
})

// Replicata: on odometer goal pages (at 120), tap 3 and Submit, which gets a
// 401 because you logged in on another device (and entered 130 there). Log in
// again here.
// Expectata: "Send 133".
// Resultata (before): "Send 123", built on the 120 that the rejected Submit
// had pinned.
qual('a submission that Beeminder rejects pins nothing', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  await tap(page, '#bigbut', 3)
  bee.tokens = ['tok456']
  bee.goals[1].last_datapoint = { value: 130 }
  await tap(page, '#subbut')
  await see(page, '#status', `Error: ${REAUTH}`)
  await expectError(page, bee, new RegExp(REAUTH))
  await login(page, 'alice', 'tok456')
  await see(page, '#num', '133')
})

// Replicata: odometer goal pages has datapoints 100 (yesterday) and 120 (today).
// Edit yesterday's (even just its comment) on Beeminder's site, which makes it
// the goal's last_datapoint in the API. Then tap 3 in TallyBee.
// Expectata: "Send 123", from the newest reading, like in Beedroid.
// Resultata (before): "Send 103".
qual("an odometer goal counts up from its newest datapoint, even after an older one's edited", async (page, bee) => {
  await login(page)
  bee.added.pages = { value: 120 }
  bee.goals[1].last_datapoint = { value: 100 }
  await choose(page, 'pages')
  await tap(page, '#bigbut', 3)
  await see(page, '#num', '123')
})

// Replicata: two windows in view side by side on odometer goal pages (at 120).
// Submit 3 in one; then tap 2 in the other.
// Expectata: the other says "Send 125".
// Resultata (before): "Send 122", from goal data older than the first
// window's datapoint.
qual("a window that stays in view sees another window's datapoint", async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  const w = await window2(page, APP + '?goal=pages')
  await see(w, '#goals', /pushups/)
  bee.reply = c => {
    if (c.method === 'POST')
      bee.goals[1].last_datapoint = { value: Number(c.params.value) }
    return null
  }
  await w.bringToFront()
  await tap(w, '#bigbut', 3)
  await tap(w, '#subbut')
  await see(w, '#bigbut', '0')
  await page.bringToFront()
  await tap(page, '#bigbut', 2)
  await see(page, '#num', '125')
})

// Replicata: on pages (at 120), tap 3 and Submit, and switch away and back
// while it's sending; Beeminder answers the refresh late, with what it had
// before the 123. Tap 2 more.
// Expectata: "Send 125".
qual('a goals refresh during a submission cannot undo the datapoint', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  const [postshut, postopen] = gate()
  const [getshut, getopen] = gate()
  // Beeminder answers each GET with what it had when the GET came in, but late
  bee.reply = c => c.method === 'POST'
    ? postshut.then(() => {
        bee.goals[1].last_datapoint = { value: 123 }
        bee.goals[1].safesum = 'safe for 4 days'
        return null
      })
    : (answer => getshut.then(() => answer))(structuredClone(defaultReply(bee, c)))
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  await calls(page, bee, 4)
  await comeback(page)
  postopen()
  await see(page, '#bigbut', '0')
  getopen()
  await see(page, '#safesum', 'safe for 4 days')
  await tap(page, '#bigbut', 2)
  await see(page, '#num', '125')
})

// Replicata: on pages (at 120), a refresh of the goals is under way when you
// tap 3 and Submit; meanwhile someone entered 130 on Beeminder's site.
// Expectata: 133 gets submitted.
qual('a submission waiting on a goals refresh uses the refreshed goal', async (page, bee) => {
  await login(page)
  await choose(page, 'pages')
  const [shut, open] = gate()
  bee.reply = c => c.method === 'GET' ? shut.then(() => null) : null
  bee.goals[1].last_datapoint = { value: 130 }
  await comeback(page)
  await calls(page, bee, 4)
  await tap(page, '#bigbut', 3)
  await tap(page, '#subbut')
  open()
  await see(page, '#bigbut', '0')
  assert.deepEqual(values(bee), ['133'])
})

// ------------------------------------------------------------------ goals

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
  await page.waitForTimeout(100) // for the page to take in the reply
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
  await runtill(page, bee, 3) // the goals again, still being updated
  assert.equal(await page.textContent('#safesum'), '+2 pushups due by 12am')
  assert.ok(await gray(), 'grayed out while Beeminder updates the goal')
  bee.goals[0].queued = false
  bee.goals[0].safesum = 'safe for 1 day'
  await runtill(page, bee, 4)
  await see(page, '#safesum', 'safe for 1 day')
  assert.ok(!await gray())
  await page.clock.runFor(60000)
  await page.waitForTimeout(100)
  assert.equal(bee.calls.length, 4, 'more calls after the goal was updated')
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
  await page.waitForTimeout(200)
  assert.equal(bee.calls.length, 2, 'asked right away') // the goals, the datapoint
  await comeback(page)
  await comeback(page)
  await calls(page, bee, 4)
  await page.waitForTimeout(200)
  for (const n of [5, 6]) {
    await page.clock.runFor(2000)
    await calls(page, bee, n)
    await page.waitForTimeout(200) // for any more that might come
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
  await runtill(page, bee, 3)
  await tap(page, '#bigbut', 2)
  await tap(page, '#clearbut')
  await see(page, '#bigbut', '0')
  await tap(page, '#bigbut', 5)
  open()
  await page.waitForTimeout(200)
  await see(page, '#bigbut', '5')
})

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

qual('goals get refreshed when you come back to the page', async (page, bee) => {
  await login(page)
  bee.goals[0].safesum = '+0 due by 11:59pm'
  await comeback(page)
  await see(page, '#safesum', '+0 due by 11:59pm')
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
  await calls(page, bee, 1)
  bee.goals = structuredClone(GOALS)
  await comeback(page)
  await see(page, '#goals', /pushups/)
  assert.equal(await page.inputValue('#goals'), 'pushups')
})

// ------------------------------------------------------------- goal links

qual('a link to a goal, like tallybee.beeminder.com/?goal=pages, selects it', async page => {
  await login(page) // which selects, and so remembers, pushups
  await page.goto(APP + '?goal=pages')
  await see(page, '#safesum', 'safe for 3 days')
  assert.equal(await page.inputValue('#goals'), 'pages')
})

qual('picking a goal puts it in the URL, for bookmarks and home-screen icons', async page => {
  await login(page)
  await choose(page, 'pages')
  assert.equal(page.url(), APP + '?goal=pages')
  // The page was loaded from that URL, so an app installed from it opens it
  assert.equal(await page.evaluate(() =>
    performance.getEntriesByType('navigation')[0].name), APP + '?goal=pages')
})

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
// other goal that a pushup count could get submitted to by mistake.
qual('a link to a goal you do not have selects no goal', async page => {
  await login(page)
  await page.goto(APP + '?goal=nosuchgoal')
  await see(page, '#goals', /pushups/)
  assert.equal(await page.inputValue('#goals'), '')
  await tap(page, '#bigbut')
  assert.ok(await disabled(page, '#subbut'))
})

// ----------------------------------------------------- icons and previews

// Chrome won't install apps in the private-browsing profiles the other quals
// use, nor from pages we serve ourselves under someone else's https URL. So
// this one serves this directory at http://localhost (which Chrome trusts like
// https) to Chrome with a throwaway ordinary profile. Desktop Chrome's check
// wants a start_url in the manifest, which TallyBee leaves out on purpose: an
// app or icon installed from a page then opens that page's URL, goal included,
// rather than the start_url. (Chrome on Android installs without one.)
test("Chrome's only complaint about TallyBee as an app is the missing start_url", async () => {
  const types = { '.html': 'text/html', '.js': 'text/javascript',
                  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
                  '.webmanifest': 'application/manifest+json' }
  const server = createServer((req, res) => {
    const path = join(fileURLToPath(new URL('.', import.meta.url)),
                      new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'))
    res.writeHead(existsSync(path) ? 200 : 404,
                  { 'content-type': types[extname(path)] ?? 'text/plain' })
    res.end(existsSync(path) ? readFileSync(path) : 'Not found')
  }).listen(0)
  const dir = mkdtempSync(join(tmpdir(), 'tallybee-quals-'))
  const context = await chromium.launchPersistentContext(dir, { channel: 'chrome' })
  try {
    const page = await context.newPage()
    await page.goto(`http://localhost:${server.address().port}/?goal=pages`)
    const cdp = await context.newCDPSession(page)
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
    assert.deepEqual(installabilityErrors.map(e => e.errorId), ['start-url-not-valid'])
  } finally {
    await context.close()
    server.close()
    rmSync(dir, { recursive: true })
  }
})

qual("the app manifest: TallyBee, standalone, black, with icons that exist", async page => {
  await page.goto(APP)
  const cdp = await page.context().newCDPSession(page)
  const { url, errors, data } = await cdp.send('Page.getAppManifest')
  assert.deepEqual(errors, [])
  const m = JSON.parse(data)
  assert.equal(m.name, 'TallyBee')
  assert.equal(m.display, 'standalone')
  assert.equal(m.start_url, undefined, 'see the qual about the missing start_url')
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

qual('every icon the page links to exists', async page => {
  await page.goto(APP)
  const hrefs = await page.$$eval(
    'link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]',
    ls => ls.map(l => l.href))
  assert.ok(hrefs.length >= 3, JSON.stringify(hrefs))
  for (const h of hrefs) assert.equal(await status(page, h), 200, h)
})

// -------------------------------------------------------------- the page

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

// Replicata: on a small phone in landscape, tap the ? button.
// Expectata: ways to close it: the ×, and tapping above the help.
// Resultata (before): the × is off the top of the screen.
qual('the credits can be closed even on a tiny screen', async page => {
  await login(page)
  const open = () => page.$eval('#info', d => d.open)
  // Open the help, and wait for it to finish sliding in
  const help = async () => {
    await tap(page, '#infobut')
    await page.$eval('#info', d => Promise.all(d.getAnimations().map(a => a.finished)))
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
qual('with text at 200% on a phone, the controls still fit', async (page, bee) => {
  bee.goals.push({ slug: 'reading-for-the-book-club', kyoom: true, curval: 0,
                   last_datapoint: null, safesum: 'safe for 9 days', queued: false })
  await login(page, 'christophermoravec')
  await tap(page, '#bigbut', 12)
  await fits(page)
}, { viewport: { width: 200, height: 433 } })

// Replicata: log in and turn a phone sideways, like a 568x320 iPhone SE or a
// 640x360 Android phone.
// Expectata: most of the screen, more than 55% of its height, still for
// tapping.
// Resultata (before): 53% at 568x320; and in a draft of the redesign, 41% at
// 568x320, 48% at 640x360, and 52% at 844x390.
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
  for (const sel of ['#undobut', '#clearbut', '#infobut', '#goals', '#subbut',
                     '#loginbut']) {
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
  await calls(page, bee, 2)
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
  await tap(page, '#bigbut', 5)
  const edge = await page.$eval('#bigbut', e => e.getBoundingClientRect().bottom)
  // The middles of the controls along the big button's bottom edge
  const xs = await page.$$eval('.footer button, .footer select', (es, edge) => es
    .map(e => e.getBoundingClientRect()).filter(r => r.top < edge + 60)
    .map(r => r.x + r.width / 2), edge)
  assert.ok(xs.length >= 3, JSON.stringify(xs))
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
})

// Replicata: tap the big blue number (README #11).
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

// Replicata: on a phone, tap UNDO.
// Expectata: UNDO looks pressed while touched, and then as it did before, not
// stuck with the lighter color it gets under a mouse (phones treat the last
// thing tapped as under the mouse).
qual('a tapped button goes back to how it looked', async page => {
  await login(page)
  await tap(page, '#bigbut', 2)
  const fill = () => page.$eval('#undobut', e => getComputedStyle(e).backgroundColor)
  const rest = await fill()
  await tap(page, '#undobut')
  await page.waitForTimeout(300) // for the fade back
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
  // How many animations Submit has each time it's grayed out or back
  await page.$eval('#subbut', b => { window.fades = []
    new MutationObserver(() => window.fades.push(b.getAnimations().length))
      .observe(b, { attributeFilter: ['disabled'] }) })
  await tap(page, '#subbut')
  await calls(page, bee, 2)
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

// Replicata: open TallyBee, tap 3, and log in (README #12).
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

// Replicata: open TallyBee without logging in (README #12).
// Expectata: all of "Send N to [dropdown] [Submit]" grayed out.
// Resultata (before): "Send N to" wasn't, so that part looked usable, and the
// empty dropdown, though it looked grayed out, could still be opened.
qual('logged out, the whole send row is grayed out', async page => {
  await page.goto(APP)
  await tap(page, '#bigbut', 3)
  assert.ok(await disabled(page, '#goals'))
  assert.ok(await disabled(page, '#subbut'))
  for (const sel of ['#num', '#goals', '#subbut'])
    assert.ok(await opacity(page, sel) < 0.5, sel)
})

// The ids of the footer's controls smaller than 44 by 44 px, the smallest that
// Apple recommends for fingers
const small = page => page.$$eval('.footer button, .footer select', es => es
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
// grayed out.
// Resultata (before): the arrow over all the buttons, which didn't change when
// hovered or pressed.
qual('with a mouse, what can be clicked looks clickable', async page => {
  await login(page)
  await tap(page, '#bigbut') // so there's something to Submit
  const fill = sel => page.$eval(sel, e => getComputedStyle(e).backgroundColor)
  const cursor = sel => page.$eval(sel, e => getComputedStyle(e).cursor)
  assert.equal(await cursor('#bigbut'), 'pointer')
  const looks = async sel => {
    assert.equal(await cursor(sel), 'pointer', sel)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200) // for the fade back
    const rest = await fill(sel)
    await page.hover(sel)
    await page.waitForTimeout(200) // for the fade in
    const hover = await fill(sel)
    assert.notEqual(hover, rest, `${sel} under the mouse`)
    await page.mouse.down()
    assert.notEqual(await fill(sel), hover, `${sel} pressed`)
    await page.mouse.move(0, 0) // so letting go doesn't click it
    await page.mouse.up()
  }
  for (const sel of ['#undobut', '#clearbut', '#infobut', '#goals', '#subbut',
                     '#loginbut']) await looks(sel)
  await tap(page, '#infobut')
  await page.$eval('#info', d => Promise.all(d.getAnimations().map(a => a.finished)))
  await looks('#info .close')
  await page.keyboard.press('Escape')
  await tap(page, '#clearbut')
  await see(page, '#bigbut', '0')
  assert.equal(await cursor('#subbut'), 'default')
}, DESK)

// Replicata: press Tab, on a computer; then open the help, with Enter on the ?.
// Expectata: a clear ring around UNDO, the first control, and then around the
// help's ×: at least 2px thick, apart from the button, with a contrast of at
// least 3:1 against what's around it (WCAG's "focus appearance").
// Resultata (before): each browser's own ring (Chrome's is of the style
// "auto", which the browser draws however it likes).
qual('the keyboard focus shows clearly', async page => {
  await login(page)
  // The ring around the focused element, and the color around the ring
  const ring = () => page.evaluate(() => {
    const e = document.activeElement, s = getComputedStyle(e)
    return { id: e.id || e.className, style: s.outlineStyle,
             width: parseFloat(s.outlineWidth), offset: parseFloat(s.outlineOffset),
             color: s.outlineColor,
             around: getComputedStyle(e.closest('.footer, .modal-header')).backgroundColor }
  })
  await page.keyboard.press('Tab')
  const undo = await ring()
  await page.focus('#infobut')
  await page.keyboard.press('Enter')
  const close = await ring()
  assert.deepEqual([undo.id, close.id], ['undobut', 'close'])
  for (const r of [undo, close]) {
    assert.equal(r.style, 'solid', JSON.stringify(r))
    assert.ok(r.width >= 2 && r.offset > 0, JSON.stringify(r))
    assert.ok(contrast(r.color, r.around) >= 3, JSON.stringify(r))
  }
}, DESK)

// Replicata: use TallyBee with a screen reader.
// Expectata: the page in English; the dropdown called "Send N to"; the ? and
// × buttons called by a word (for now in Latin: see index.html), not "question
// mark" and "times"; and the help called TallyBee.
// Resultata (before): none of that.
qual('screen readers get names for the dropdown, the ? and × buttons, and the help', async page => {
  await login(page)
  assert.equal(await page.getAttribute('html', 'lang'), 'en')
  assert.equal(await page.getByRole('combobox', { name: 'Send 0 to' }).count(), 1)
  await tap(page, '#infobut')
  assert.equal(await page.getByRole('dialog', { name: 'TallyBee' }).count(), 1)
  for (const sel of ['#infobut', '#info .close'])
    assert.match(await page.getAttribute(sel, 'aria-label') ?? '', /^\p{L}{2,}/u, sel)
})

// Replicata: open TallyBee on a slow connection, and look at it before it's
// done loading.
// Expectata: the dropdown and Submit grayed out, as they are once it has
// loaded, with nothing to submit.
// Resultata (before): Submit, yellow, looking ready to use, till script.js
// ran.
qual('the dropdown and Submit start out grayed out, before script.js runs', async page => {
  const [shut, open] = gate()
  await page.route(APP + 'script.js', r => shut.then(() => serve(r)))
  await page.goto(APP, { waitUntil: 'commit' })
  await page.waitForSelector('#subbut', { state: 'attached' })
  assert.ok(await disabled(page, '#goals'))
  assert.ok(await disabled(page, '#subbut'))
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
