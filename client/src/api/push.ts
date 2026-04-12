/**
 * Push notification helpers: service worker registration + subscription management
 */
import { post, del, get } from './http'

/** Register service worker on app startup */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    return reg
  } catch {
    return null
  }
}

/** Check if push notifications are supported */
export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** Check if already subscribed */
export async function isPushSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    return sub !== null
  } catch {
    return false
  }
}

/**
 * Subscribe to push notifications:
 * 1. Request notification permission
 * 2. Get VAPID public key from server
 * 3. Subscribe via PushManager
 * 4. Send subscription to server
 */
export async function subscribePush(): Promise<boolean> {
  if (!isPushSupported()) return false

  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return false

    // Get VAPID public key
    const config = await get<{ vapid_public_key?: string }>('/api/push/vapid-key')
    if (!config.vapid_public_key) {
      console.warn('VAPID not configured on server')
      return false
    }

    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapid_public_key),
    })

    const subJson = sub.toJSON()
    await post('/api/push/subscribe', {
      endpoint: subJson.endpoint,
      keys: {
        p256dh: subJson.keys?.p256dh,
        auth: subJson.keys?.auth,
      },
    })

    return true
  } catch (err) {
    console.error('Push subscribe failed:', err)
    return false
  }
}

/** Unsubscribe from push notifications */
export async function unsubscribePush(): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return true

    await sub.unsubscribe()
    await del('/api/push/unsubscribe', { endpoint: sub.endpoint })
    return true
  } catch {
    return false
  }
}

/** Convert VAPID key from base64 string to Uint8Array */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
