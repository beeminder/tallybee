// TallyBee's service worker, which lets TallyBee open with no connection. It
// gets TallyBee's own files from the network whenever it can, so they're always
// the newest, and keeps a copy of each; when it can't, it answers with its
// copies. Calls to Beeminder, on another origin, pass by untouched.

const CACHE = 'tallybee'

// What TallyBee needs to open, fetched and kept as soon as this is installed,
// since it only starts answering for TallyBee the next time TallyBee opens
const FILES = ['./', 'style.css', 'script.js', 'beeminder.js', 'infinibee.svg',
               'icon-192.png', 'apple-touch-icon.png', 'manifest.webmanifest']

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))))

self.addEventListener('fetch', e => {
  if (new URL(e.request.url).origin !== location.origin) return
  e.respondWith(fetch(e.request).then(r => {
    // A copy of each file as it comes, but not of errors, like a 404
    if (r.ok) e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, r.clone())))
    return r
  // With no connection, the copy of what was asked for, with the URL's query
  // ignored, so that TallyBee at ?goal=pages opens from the copy of TallyBee
  }, () => caches.match(e.request, { ignoreSearch: true })))
})
