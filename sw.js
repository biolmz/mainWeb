// sw.js - Service Worker 缓存策略
const CACHE_NAME = 'download-center-v1';
const OFFLINE_URL = '/offline.html';

// 需要缓存的资源
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/download.html',
    '/manifest.json',
    '/favicon.ico'
];

// 安装时缓存静态资源
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('📦 缓存静态资源');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// 激活时清理旧缓存
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

// 拦截请求 - 缓存优先策略
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // 只缓存同源请求
    if (url.origin !== self.location.origin) {
        return;
    }

    // 对 files.json 使用网络优先策略
    if (url.pathname.includes('files.json')) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, clone);
                    });
                    return response;
                })
                .catch(() => {
                    return caches.match(event.request);
                })
        );
        return;
    }

    // 其他资源使用缓存优先策略
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response;
                }
                return fetch(event.request).catch(() => {
                    if (event.request.mode === 'navigate') {
                        return caches.match(OFFLINE_URL);
                    }
                });
            })
    );
});