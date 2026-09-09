/**
 * ILAI FITNESS - Service Worker
 *
 * ה-manifest הכריז על אפליקציה ניתנת להתקנה, אבל בלי service worker
 * מתאמן שפתח את האפליקציה בלי רשת קיבל מסך שגיאה של הדפדפן.
 *
 * אסטרטגיה:
 *   - קליפת האפליקציה (HTML/אייקונים): network-first עם נפילה למטמון,
 *     כך שדיפלוימנט חדש ב-Vercel נתפס מיד ואין הגשה של גרסה ישנה.
 *   - נכסי CDN (גופנים, ספריות): stale-while-revalidate.
 *   - Firestore ו-Google APIs: לעולם לא נכנסים למטמון. ל-Firestore יש
 *     שכבת התמדה משלו, ומטמון היה מגיש נתוני מתאמנים ישנים.
 */

const VERSION = 'ilaico-v1';
const SHELL = VERSION + '-shell';
const ASSETS = VERSION + '-assets';

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './favicon.png',
  './logo.png',
  './logo-light.png',
];

// דומיינים שלעולם לא נשמרים במטמון
const NEVER_CACHE = [
  'firestore.googleapis.com',
  'firebase',
  'googleapis.com/identitytoolkit',
  'generativelanguage.googleapis.com',
  'api.telegram.org',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      // addAll נכשל כולו אם קובץ אחד חסר; מוסיפים אחד-אחד
      .then(cache => Promise.allSettled(SHELL_URLS.map(u => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (NEVER_CACHE.some(d => url.hostname.includes(d) || url.href.includes(d))) return;

  const isShell = url.origin === self.location.origin;

  if (isShell) {
    // network-first: תמיד מנסים רשת, נופלים למטמון רק כשאין
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // נכסי צד שלישי: מגישים מהמטמון ומרעננים ברקע
  event.respondWith(
    caches.match(req).then(hit => {
      const network = fetch(req)
        .then(res => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(ASSETS).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
