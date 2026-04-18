/**
 * Group Call Hook – Mesh WebRTC topology
 *
 * Each participant creates a direct P2P RTCPeerConnection with every other
 * participant. Signaling goes through the existing WebSocket server which
 * broadcasts group_call_* events to group members.
 *
 * Flow:
 *   1. Initiator sends `group_call_invite` → server broadcasts to group
 *   2. Acceptor sends `group_call_join`    → server broadcasts to group
 *   3. Existing participants send `call_offer` to new joiner (point-to-point)
 *   4. Normal ICE candidate / answer exchange per-peer
 *   5. `group_call_leave` when someone leaves
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { sendWs, onWs } from '../api/socket'
import { get } from '../api/http'
import { playCallRingtone, stopRingtone, showBrowserNotification } from '../utils/notification'

export type GroupCallStatus = 'idle' | 'ringing' | 'connecting' | 'connected'

export interface PeerInfo {
  peerId: string
  nickname?: string
  avatar?: string
  stream: MediaStream | null
  pc: RTCPeerConnection | null
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

export function useGroupCall(userId: string | undefined) {
  const [status, setStatus] = useState<GroupCallStatus>('idle')
  const [callId, setCallId] = useState<string | null>(null)
  const [groupId, setGroupId] = useState<string | null>(null)
  const [isVideo, setIsVideo] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  const [duration, setDuration] = useState(0)
  const [peers, setPeers] = useState<Map<string, PeerInfo>>(new Map())
  const [inviterName, setInviterName] = useState('')
  const [inviterAvatar, setInviterAvatar] = useState('')
  const [groupName, setGroupName] = useState('')

  const localStreamRef = useRef<MediaStream | null>(null)
  const peersRef = useRef<Map<string, PeerInfo>>(new Map())
  const durationTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const statusRef = useRef<GroupCallStatus>('idle')
  const callIdRef = useRef<string | null>(null)
  const groupIdRef = useRef<string | null>(null)
  const isVideoRef = useRef(false)
  const iceCandidateQueues = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())

  statusRef.current = status
  callIdRef.current = callId
  groupIdRef.current = groupId
  isVideoRef.current = isVideo

  // ── Fetch TURN credentials ──
  const getIceServers = async (): Promise<RTCIceServer[]> => {
    try {
      const res = await get<{ iceServers: any }>('/api/calls/turn-credentials')
      const raw = res.iceServers
      if (Array.isArray(raw) && raw.length > 0) {
        const servers = raw.map((s: any) => ({
          urls: s.urls || s.url || '',
          ...(s.username ? { username: s.username } : {}),
          ...(s.credential ? { credential: s.credential } : {}),
        })).filter((s: any) => s.urls)
        if (servers.length > 0) return servers
      }
      return DEFAULT_ICE_SERVERS
    } catch {
      return DEFAULT_ICE_SERVERS
    }
  }

  // ── Get local media ──
  const getLocalMedia = async (video: boolean): Promise<MediaStream | null> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
      })
      localStreamRef.current = stream
      return stream
    } catch (err) {
      console.error('[GroupCall] getUserMedia failed:', err)
      return null
    }
  }

  // ── Create peer connection for a specific peer ──
  const createPeerConnection = async (peerId: string): Promise<RTCPeerConnection> => {
    const iceServers = await getIceServers()
    const pc = new RTCPeerConnection({ iceServers })

    const remoteStream = new MediaStream()

    pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach(track => {
        remoteStream.addTrack(track)
      })
      updatePeer(peerId, { stream: remoteStream })
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendWs({
          type: 'ice_candidate',
          to: peerId,
          call_id: callIdRef.current,
          group_id: groupIdRef.current,
          candidate: e.candidate.toJSON(),
        })
      }
    }

    pc.onconnectionstatechange = () => {
      console.log(`[GroupCall] Peer ${peerId} connection: ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        if (statusRef.current === 'connecting') {
          setStatus('connected')
          startDurationTimer()
        }
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        removePeer(peerId)
      }
    }

    // Add local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!)
      })
    }

    const info: PeerInfo = { peerId, stream: remoteStream, pc }
    peersRef.current.set(peerId, info)
    setPeers(new Map(peersRef.current))

    return pc
  }

  const updatePeer = (peerId: string, updates: Partial<PeerInfo>) => {
    const existing = peersRef.current.get(peerId)
    if (existing) {
      const updated = { ...existing, ...updates }
      peersRef.current.set(peerId, updated)
      setPeers(new Map(peersRef.current))
    }
  }

  const removePeer = (peerId: string) => {
    const peer = peersRef.current.get(peerId)
    if (peer?.pc) {
      peer.pc.close()
    }
    peersRef.current.delete(peerId)
    iceCandidateQueues.current.delete(peerId)
    setPeers(new Map(peersRef.current))

    // If no peers left and we're in a call, end it
    if (peersRef.current.size === 0 && statusRef.current === 'connected') {
      cleanup()
    }
  }

  const startDurationTimer = () => {
    if (durationTimer.current) clearInterval(durationTimer.current)
    setDuration(0)
    durationTimer.current = setInterval(() => {
      setDuration(d => d + 1)
    }, 1000)
  }

  // ── Cleanup ──
  const cleanup = useCallback(() => {
    stopRingtone()

    peersRef.current.forEach((peer) => {
      peer.pc?.close()
    })
    peersRef.current.clear()
    iceCandidateQueues.current.clear()
    setPeers(new Map())

    localStreamRef.current?.getTracks().forEach(t => t.stop())
    localStreamRef.current = null

    if (durationTimer.current) clearInterval(durationTimer.current)
    durationTimer.current = null

    setStatus('idle')
    setCallId(null)
    setGroupId(null)
    setIsVideo(false)
    setIsMuted(false)
    setIsCameraOff(false)
    setDuration(0)
    setInviterName('')
    setInviterAvatar('')
    setGroupName('')
  }, [])

  // ── Start group call (initiator) ──
  const startGroupCall = useCallback(async (gid: string, video: boolean, gname?: string) => {
    if (statusRef.current !== 'idle') return

    const cid = `gc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    setCallId(cid)
    setGroupId(gid)
    setIsVideo(video)
    setGroupName(gname || '')
    setStatus('connecting')

    const stream = await getLocalMedia(video)
    if (!stream) {
      cleanup()
      return
    }

    sendWs({
      type: 'group_call_invite',
      group_id: gid,
      call_id: cid,
      is_video: video,
    })
  }, [cleanup])

  // ── Accept group call (responder) ──
  const acceptGroupCall = useCallback(async () => {
    if (statusRef.current !== 'ringing') return

    stopRingtone()
    setStatus('connecting')

    const stream = await getLocalMedia(isVideoRef.current)
    if (!stream) {
      cleanup()
      return
    }

    // Notify group that we're joining
    sendWs({
      type: 'group_call_join',
      group_id: groupIdRef.current,
      call_id: callIdRef.current,
      is_video: isVideoRef.current,
    })
  }, [cleanup])

  // ── Reject / Leave ──
  const rejectGroupCall = useCallback(() => {
    cleanup()
  }, [cleanup])

  const leaveGroupCall = useCallback(() => {
    if (groupIdRef.current && callIdRef.current) {
      sendWs({
        type: 'group_call_leave',
        group_id: groupIdRef.current,
        call_id: callIdRef.current,
      })
    }
    cleanup()
  }, [cleanup])

  // ── Toggle mute / camera ──
  const toggleMute = useCallback(() => {
    localStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = !t.enabled })
    setIsMuted(m => !m)
  }, [])

  const toggleCamera = useCallback(() => {
    localStreamRef.current?.getVideoTracks().forEach(t => { t.enabled = !t.enabled })
    setIsCameraOff(c => !c)
  }, [])

  // ── WebSocket signaling listeners ──
  useEffect(() => {
    // Incoming group call invite
    const unsubInvite = onWs('group_call_invite', (data) => {
      if (data.from === userId) return
      if (statusRef.current !== 'idle') return

      setCallId(data.call_id)
      setGroupId(data.group_id)
      setIsVideo(data.is_video || false)
      setInviterName(data.from_nickname || data.from || '')
      setInviterAvatar(data.from_avatar || '')
      setGroupName(data.group_name || '')
      setStatus('ringing')

      playCallRingtone()
      const callType = data.is_video ? 'Group Video Call' : 'Group Voice Call'
      showBrowserNotification('PaperPhone', `${callType}`, () => window.focus())
    })

    // Someone joined the group call → send them an offer if we're in the call
    const unsubJoin = onWs('group_call_join', async (data) => {
      if (data.from === userId) return
      if (!callIdRef.current || data.call_id !== callIdRef.current) return
      if (statusRef.current !== 'connecting' && statusRef.current !== 'connected') return

      console.log(`[GroupCall] ${data.from} joined, creating offer`)
      try {
        const pc = await createPeerConnection(data.from)
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        sendWs({
          type: 'call_offer',
          to: data.from,
          call_id: callIdRef.current,
          group_id: groupIdRef.current,
          is_video: isVideoRef.current,
          sdp: offer.sdp,
          sdp_type: offer.type,
        })
      } catch (err) {
        console.error('[GroupCall] Failed to create offer for joiner:', err)
      }
    })

    // Receive an offer from an existing participant
    const unsubOffer = onWs('call_offer', async (data) => {
      if (data.from === userId) return
      // Only handle if it's a group call offer (has call_id matching ours)
      if (!data.call_id || !callIdRef.current || data.call_id !== callIdRef.current) return
      if (!data.group_id) return

      console.log(`[GroupCall] Received offer from ${data.from}`)
      try {
        const pc = await createPeerConnection(data.from)

        if (data.sdp && data.sdp_type) {
          await pc.setRemoteDescription(new RTCSessionDescription({
            type: data.sdp_type,
            sdp: data.sdp,
          }))
        }

        // Flush queued ICE candidates
        const queued = iceCandidateQueues.current.get(data.from) || []
        for (const c of queued) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
        }
        iceCandidateQueues.current.delete(data.from)

        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        sendWs({
          type: 'call_answer',
          to: data.from,
          call_id: callIdRef.current,
          group_id: groupIdRef.current,
          sdp: answer.sdp,
          sdp_type: answer.type,
        })

        if (statusRef.current === 'connecting') {
          setStatus('connected')
          startDurationTimer()
        }
      } catch (err) {
        console.error('[GroupCall] Failed to handle offer:', err)
      }
    })

    // Receive answer
    const unsubAnswer = onWs('call_answer', async (data) => {
      if (data.from === userId) return
      if (!data.call_id || !callIdRef.current || data.call_id !== callIdRef.current) return

      const peer = peersRef.current.get(data.from)
      if (!peer?.pc) return

      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription({
          type: data.sdp_type || 'answer',
          sdp: data.sdp,
        }))

        // Flush queued ICE candidates
        const queued = iceCandidateQueues.current.get(data.from) || []
        for (const c of queued) {
          await peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
        }
        iceCandidateQueues.current.delete(data.from)

        if (statusRef.current === 'connecting') {
          setStatus('connected')
          startDurationTimer()
        }
      } catch (err) {
        console.error('[GroupCall] Failed to handle answer:', err)
      }
    })

    // ICE candidates (for group calls with call_id)
    const unsubIce = onWs('ice_candidate', async (data) => {
      if (data.from === userId) return
      if (!data.call_id || !callIdRef.current || data.call_id !== callIdRef.current) return

      const peer = peersRef.current.get(data.from)
      if (data.candidate) {
        if (peer?.pc && peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {})
        } else {
          // Queue it
          if (!iceCandidateQueues.current.has(data.from)) {
            iceCandidateQueues.current.set(data.from, [])
          }
          iceCandidateQueues.current.get(data.from)!.push(data.candidate)
        }
      }
    })

    // Someone left the group call
    const unsubLeave = onWs('group_call_leave', (data) => {
      if (data.from === userId) return
      if (!data.call_id || !callIdRef.current || data.call_id !== callIdRef.current) return

      console.log(`[GroupCall] ${data.from} left`)
      removePeer(data.from)
    })

    return () => {
      unsubInvite()
      unsubJoin()
      unsubOffer()
      unsubAnswer()
      unsubIce()
      unsubLeave()
    }
  }, [userId, cleanup])

  // Cleanup on unmount
  useEffect(() => {
    return () => { cleanup() }
  }, [cleanup])

  return {
    status,
    callId,
    groupId,
    isVideo,
    isMuted,
    isCameraOff,
    duration,
    peers,
    localStream: localStreamRef.current,
    inviterName,
    inviterAvatar,
    groupName,
    startGroupCall,
    acceptGroupCall,
    rejectGroupCall,
    leaveGroupCall,
    toggleMute,
    toggleCamera,
    cleanup,
  }
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
