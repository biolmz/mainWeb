/**
 * 📝 云端笔记系统 - Service Worker
 * 离线缓存策略：
 * - 静态资源（HTML/CSS/JS）：Cache First
 * - COS 请求：Network First，失败读缓存
 * - CDN 依赖：Network First
 */

const CACHE_NAME = 'notes-v2.0';
const STATIC_ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.json',
];

// 安装：预缓存静态资源
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// 激活：清理旧缓存
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME)
                    .map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// 请求拦截
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // COS 请求：Network First
    if (url.hostname.includes('myqcloud.com') || url.hostname.includes('cos.')) {
        event.respondWith(networkFirst(event.request));
        return;
    }

    // CDN 依赖：Network First（带超时降级）
    if (url.hostname.includes('cdn.jsdelivr.net') ||
        url.hostname.includes('unpkg.com')) {
        event.respondWith(networkFirst(event.request, 3000));
        return;
    }

    // 同源静态资源：Cache First
    if (url.origin === self.location.origin) {
        event.respondWith(cacheFirst(event.request));
        return;
    }

    // 其他：直接走网络
    event.respondWith(fetch(event.request));
});

async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
        const res = await fetch(request);
        if (res.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, res.clone());
        }
        return res;
    } catch(e) {
        // 离线 + 无缓存
        if (request.mode === 'navigate') {
            return caches.match('./index.html');
        }
        throw e;
    }
}

async function networkFirst(request, timeoutMs) {
    const fetchPromise = fetch(request);
    if (timeoutMs) {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeoutMs)
        );
        try {
            const res = await Promise.race([fetchPromise, timeoutPromise]);
            if (res.ok) {
                const cache = await caches.open(CACHE_NAME);
                cache.put(request, res.clone());
            }
            return res;
        } catch(e) {
            const cached = await caches.match(request);
            if (cached) return cached;
            throw e;
        }
    } else {
        try {
            const res = await fetchPromise;
            if (res.ok) {
                const cache = await caches.open(CACHE_NAME);
                cache.put(request, res.clone());
            }
            return res;
        } catch(e) {
            const cached = await caches.match(request);
            if (cached) return cached;
            throw e;
        }
    }
}
