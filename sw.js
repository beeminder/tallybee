// TallyBee's service worker, which lets TallyBee open with no connection. It
// gets TallyBee's own files from the network whenever it can, so they're as new
// as without it, and keeps a copy of each; when it can't, it answers with its
// copies. Calls to Beeminder, on another origin, pass by untouched.
// "From the network" means from the server, every time: not from the copy the
// browser can keep of each file on its own (for 10 minutes, as GitHub Pages
// says to), since files kept that way can be from different versions of
// TallyBee, like an old page with a new script.js that looks in vain for what
// the new page has. Asking the server costs little when the file hasn't
// changed: it just says so.

const CACHE = 'tallybee'

// What TallyBee needs to open, fetched and kept as soon as this is installed,
// since it only starts answering for TallyBee the next time TallyBee opens:
// 404.html too, for a goal's page (see NOTFOUND)
const FILES = ['./', '404.html', 'style.css', 'script.js', 'beeminder.js', 'journal.js', 'tally.js',
               'infinibee.svg', 'icon-192.png', 'apple-touch-icon.png']

// What GitHub Pages answers with, under a 404, for a URL it has no file for,
// like a goal's page, /alice/pushups/ (see goalurl in script.js): its 404.html,
// which is TallyBee itself (see index.html). The copy of what came with a 404
// is kept as 404.html's.
const NOTFOUND = new URL('404.html', location).href

// Response r as it came from the server, but saying that the page mustn't use
// it again without asking, so that each time TallyBee loads, each of its
// files comes from here, all from the same version of TallyBee. (Otherwise
// Chrome, at least, uses a file it has already loaded for as long as the
// server said it could, 10 minutes for GitHub Pages, without even asking this
// service worker, which can make for an old script.js on a new page.)
function unkept(r) {
  const headers = new Headers(r.headers)
  headers.set('cache-control', 'no-cache')
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers })
}

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))))

self.addEventListener('fetch', e => {
  if (new URL(e.request.url).origin !== location.origin) return
  // One copy of each file, under its URL less any query, so that TallyBee at
  // ?goal=pages opens from the copy of TallyBee, and so that no copy is kept
  // under a URL with an access token in it (see autoLogin)
  const url = new URL(e.request.url)
  url.search = ''
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    // Errors other than a 404, like a 500, as they come, with no copy kept
    if (!r.ok && r.status !== 404) return r
    // A copy of each file as it comes, and of a 404, as 404.html's (see
    // NOTFOUND), rather than as that of the file it came for, which may be
    // there after all, as when a 404 comes for a script while TallyBee is being
    // published. (The copy is taken before the page starts reading r, after
    // which it can't be.)
    const copy = r.clone()
    e.waitUntil(caches.open(CACHE).then(c => c.put(r.ok ? url.href : NOTFOUND, copy)))
    return unkept(r)
  // With no connection, the copy of the file, or, for a URL of no file, like a
  // goal's page, the copy of 404.html, as GitHub Pages answers then
  }, () => caches.match(url.href).then(c => c ?? caches.match(NOTFOUND))))
})
