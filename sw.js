const CACHE='cargorun-shell-v1';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/manifest.webmanifest','/icon-192.png','/icon-512.png'])).catch(()=>{}));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim());});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.pathname.startsWith('/api/')||url.pathname.startsWith('/.auth/'))return;event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)));});
