// TallyBee's service worker, which lets TallyBee open with no connection. It
// gets TallyBee's own files from the network whenever it can, so they're as new
// as without it, and keeps a copy of each; when it can't, it answers with its
// copies. Calls to Beeminder, on another origin, pass by untouched.

const CACHE = 'tallybee'

// What TallyBee needs to open, fetched and kept as soon as this is installed,
// since it only starts answering for TallyBee the next time TallyBee opens
const FILES = ['./', 'style.css', 'script.js', 'beeminder.js', 'infinibee.svg',
               'icon-192.png', 'apple-touch-icon.png']

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))))

self.addEventListener('fetch', e => {
  if (new URL(e.request.url).origin !== location.origin) return
  // One copy of each file, under its URL less any query, so that TallyBee at
  // ?goal=pages opens from the copy of TallyBee, and so that no copy is kept
  // under a URL with an access token in it (see autoLogin)
  const url = new URL(e.request.url)
  url.search = ''
  e.respondWith(fetch(e.request).then(r => {
    // A copy of each file as it comes, but not of errors, like a 404. (The copy
    // is taken before the page starts reading r, after which it can't be.)
    const copy = r.clone()
    if (r.ok) e.waitUntil(caches.open(CACHE).then(c => c.put(url.href, copy)))
    return r
  }, () => caches.match(url.href)))
})
