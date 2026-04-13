import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useStore } from './store'
import { useSocket } from './hooks/useSocket'
import { loadFromIndexedDB } from './crypto/keystore'
import Login from './pages/Login'
import Chats from './pages/Chats'
import Chat from './pages/Chat'
import Contacts from './pages/Contacts'
import Discover from './pages/Discover'
import Profile from './pages/Profile'
import UserProfile from './pages/UserProfile'
import GroupInfo from './pages/GroupInfo'
import Moments from './pages/Moments'
import Timeline from './pages/Timeline'
import TabBar from './components/TabBar'
import { CallProvider } from './contexts/CallContext'
import CallOverlay from './components/CallOverlay'
import { subscribePush, isPushSubscribed } from './api/push'
import { post } from './api/http'

function ProtectedLayout() {
  useSocket()

  // Auto-subscribe to push notifications when authenticated
  useEffect(() => {
    // ── Web Push (VAPID) ──
    ;(async () => {
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          const alreadySub = await isPushSubscribed()
          if (!alreadySub) {
            const ok = await subscribePush()
            if (ok) console.log('[Push] Web Push subscribed successfully')
          }
        }
      } catch (e) {
        console.warn('[Push] Web Push subscription failed:', e)
      }
    })()

    // ── OneSignal registration (Median.co native wrapper) ──
    // The Median.co WebView bridge injects window.median asynchronously,
    // so we poll for it with a retry mechanism.
    let attempt = 0
    const maxAttempts = 20 // ~10 seconds
    const tryRegisterMedian = () => {
      const w = window as any
      if (w.median?.onesignal?.onesignalInfo) {
        console.log('[OneSignal] Median.co bridge detected, requesting player info...')
        w.median.onesignal.onesignalInfo((info: any) => {
          console.log('[OneSignal] Got info:', JSON.stringify(info))
          if (info?.oneSignalUserId) {
            console.log('[OneSignal] Registering player_id:', info.oneSignalUserId)
            post('/api/push/onesignal', {
              player_id: info.oneSignalUserId,
              platform: info.platform || 'android',
            }).then(() => {
              console.log('[OneSignal] ✅ Player ID registered on server')
            }).catch((e: any) => {
              console.error('[OneSignal] Failed to register player_id:', e)
            })
          } else {
            console.warn('[OneSignal] No oneSignalUserId in info')
          }
        })
      } else if (w.gonative?.onesignal?.onesignalInfo) {
        // Legacy GoNative bridge (older Median.co versions)
        console.log('[OneSignal] GoNative bridge detected')
        w.gonative.onesignal.onesignalInfo((info: any) => {
          if (info?.oneSignalUserId) {
            post('/api/push/onesignal', {
              player_id: info.oneSignalUserId,
              platform: info.platform || 'android',
            }).catch(() => {})
          }
        })
      } else {
        attempt++
        if (attempt < maxAttempts) {
          setTimeout(tryRegisterMedian, 500)
        }
      }
    }
    tryRegisterMedian()

    // ── OneSignal Web SDK (if loaded globally) ──
    ;(async () => {
      try {
        const w = window as any
        if (w.OneSignal) {
          const playerId = await w.OneSignal.getUserId?.()
          if (playerId) {
            console.log('[OneSignal] Web SDK player_id:', playerId)
            await post('/api/push/onesignal', {
              player_id: playerId,
              platform: 'web',
            })
          }
        }
      } catch {}
    })()
  }, [])

  return (
    <CallProvider>
      <Routes>
        <Route path="/chats" element={<Chats />} />
        <Route path="/chat/:id" element={<Chat />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/discover" element={<Discover />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/user/:id" element={<UserProfile />} />
        <Route path="/group/:id" element={<GroupInfo />} />
        <Route path="/moments" element={<Moments />} />
        <Route path="/timeline" element={<Timeline />} />
        <Route path="*" element={<Navigate to="/chats" replace />} />
      </Routes>
      <TabBar />
      <CallOverlay />
    </CallProvider>
  )
}

export default function App() {
  const token = useStore(s => s.token)
  const theme = useStore(s => s.theme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Hydrate crypto keys from IndexedDB (tier 4 of 4-tier key persistence)
  useEffect(() => {
    loadFromIndexedDB().catch(() => {})
  }, [])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={token ? <Navigate to="/chats" replace /> : <Login />} />
        <Route path="/*" element={token ? <ProtectedLayout /> : <Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
