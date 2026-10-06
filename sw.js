// PWABuilder 서비스 워커 오프라인 지원 스크립트 (안전성 강화 버전)
const CACHE_NAME = 'doolimoa-v2';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './doolimoa_app_icon_512x512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // 개별 파일 개별 추가 (특정 파일이 없어도 SW 설치가 중단되지 않도록 방어)
            return Promise.allSettled(
                ASSETS.map((asset) =>
                    cache.add(asset).catch((err) => {
                        console.warn(`[SW] 개별 캐시 실패 무시됨 (${asset}):`, err);
                    })
                )
            );
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // GET 요청 및 http/https 프로토콜만 처리 (Firebase 실시간 통신, POST, 크롬 확장프로그램 오류 완전 차단)
    if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // 정상 수신 시 캐시 업데이트 후 반환
                if (response && response.status === 200 && response.type === 'basic') {
                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return response;
            })
            .catch(() => {
                // 오프라인 상태이거나 네트워크 실패 시 캐시된 자원 제공
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // HTML 요청일 경우 index.html 폴백
                    if (event.request.headers.get('accept')?.includes('text/html')) {
                        return caches.match('./index.html');
                    }
                });
            })
    );
});