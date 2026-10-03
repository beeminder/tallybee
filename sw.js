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
// since it only starts answering for TallyBee the next time TallyBee opens
const FILES = ['./', 'style.css', 'script.js', 'beeminder.js', 'infinibee.svg',
               'icon-192.png', 'apple-touch-icon.png']

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
    // Errors, like a 404, as they come, with no copy kept
    if (!r.ok) return r
    // A copy of each file as it comes. (The copy is taken before the page
    // starts reading r, after which it can't be.)
    const copy = r.clone()
    e.waitUntil(caches.open(CACHE).then(c => c.put(url.href, copy)))
    return unkept(r)
  }, () => caches.match(url.href)))
})
