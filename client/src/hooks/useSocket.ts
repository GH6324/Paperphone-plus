import { useEffect } from 'react'
import { useStore } from '../store'
import { connectWs, disconnectWs, onWs } from '../api/socket'

export function useSocket() {
  const token = useStore(s => s.token)

  useEffect(() => {
    if (!token) return

    connectWs()

    // Listen for incoming messages and route to store
    const unsubMsg = onWs('message', (data) => {
      const chatId = data.group_id || (data.from === useStore.getState().user?.id ? data.to : data.from)
      if (chatId) {
        useStore.getState().addMessage(chatId, data)
        // If not on that chat page, increment unread
        if (!window.location.pathname.includes(chatId)) {
          useStore.getState().incrementUnread(chatId)
        }
      }
    })

    // Listen for ack: add sent message to local store for real-time display
    const unsubAck = onWs('ack', (data) => {
      const pending = (window as any).__pendingMsg
      if (pending && data.msg_id) {
        const chatId = pending.group_id || pending.to
        if (chatId) {
          useStore.getState().addMessage(chatId, {
            ...pending,
            id: data.msg_id,
            ts: data.ts || Date.now(),
          })
        }
        ;(window as any).__pendingMsg = null
      }
    })

    // Listen for read receipts
    const unsubRead = onWs('msg_read', (data) => {
      if (data.msg_ids && data.ts) {
        useStore.getState().markMessagesRead(data.msg_ids, data.ts)
      }
    })

    // Listen for online/offline status
    const unsubOnline = onWs('online', (data) => {
      if (data.user_id) {
        useStore.getState().updateFriendOnline(data.user_id, true)
      }
    })

    const unsubOffline = onWs('offline', (data) => {
      if (data.user_id) {
        useStore.getState().updateFriendOnline(data.user_id, false)
      }
    })

    return () => {
      unsubMsg()
      unsubAck()
      unsubRead()
      unsubOnline()
      unsubOffline()
      disconnectWs()
    }
  }, [token])
}
