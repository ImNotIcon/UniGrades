/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'

declare let self: ServiceWorkerGlobalScope

// Precache all static assets injected by vite-plugin-pwa
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Set up App Shell-style routing, so that all navigation requests
// are fulfilled with your index.html shell.
const handler = createHandlerBoundToURL('index.html')
const navigationRoute = new NavigationRoute(handler, {
    denylist: [
        // Exclude URLs starting with /api, /_*, etc
        new RegExp('^/api/'),
    ],
})
registerRoute(navigationRoute)

// Handle push notifications
self.addEventListener('push', (event) => {
    if (!event.data) return

    const data = event.data.json()

    const options = {
        body: data.body || 'You have a new notification',
        icon: data.icon || '/pwa-192x192.png',
        badge: data.badge || '/pwa-192x192.png',
        tag: data.tag || 'default',
        vibrate: [200, 100, 200],
        data: data.data || { url: '/' },
        requireInteraction: true,
    } as NotificationOptions

    event.waitUntil(
        self.registration.showNotification(data.title || 'UniGrades', options)
    )
})

// Handle notification click - open the app
self.addEventListener('notificationclick', (event) => {
    event.notification.close()

    const urlToOpen = event.notification.data?.url || '/'

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // Focus if already open
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    return client.focus()
                }
            }
            // Otherwise open new window
            return self.clients.openWindow(urlToOpen)
        })
    )
})

// Auto-activate new SW versions
self.addEventListener('install', () => {
    self.skipWaiting()
})

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim())
})
