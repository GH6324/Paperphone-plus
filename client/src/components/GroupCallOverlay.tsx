/**
 * Group Call Overlay
 *
 * Full-screen overlay for group voice/video calls.
 * Displays participant grid (video or avatar), controls, and incoming/ringing UI.
 */
import { useRef, useEffect } from 'react'
import { useGroupCallContext, formatDuration } from '../contexts/GroupCallContext'
import { useStore } from '../store'
import { useI18n } from '../hooks/useI18n'
import { Phone, PhoneOff, PhoneIncoming, Mic, MicOff, CameraOff, Video as VideoIcon, Users } from 'lucide-react'

export default function GroupCallOverlay() {
  const gc = useGroupCallContext()
  const { t } = useI18n()
  const friends = useStore(s => s.friends)
  const groups = useStore(s => s.groups)

  if (gc.status === 'idle') return null

  const group = groups.find(g => g.id === gc.groupId)
  const displayGroupName = gc.groupName || group?.name || gc.groupId || ''

  const peerCount = gc.peers.size

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: gc.isVideo ? '#000' : 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
      display: 'flex', flexDirection: 'column',
      color: '#fff', animation: 'fade-in .3s ease',
    }}>
      {/* ── Top info bar ── */}
      <div style={{
        padding: '16px 20px', paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))',
        display: 'flex', alignItems: 'center', gap: 12,
        background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(10px)',
        zIndex: 5,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 12,
          background: 'rgba(255,255,255,0.15)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {group?.avatar
            ? <img src={group.avatar} alt="" style={{ width: '100%', height: '100%', borderRadius: 12, objectFit: 'cover' }} />
            : <Users size={20} />}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{displayGroupName}</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            {gc.status === 'ringing' && (t('call.group_incoming') || 'Group Call Invite')}
            {gc.status === 'connecting' && (t('call.joining') || 'Joining...')}
            {gc.status === 'connected' && (
              <>{formatDuration(gc.duration)} · {peerCount + 1} {t('call.participants') || 'participants'}</>
            )}
          </div>
        </div>
      </div>

      {/* ── Ringing (incoming invite) ── */}
      {gc.status === 'ringing' && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 20,
        }}>
          <div style={{
            width: 96, height: 96, borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 40, fontWeight: 600, border: '3px solid rgba(255,255,255,0.2)',
            backdropFilter: 'blur(10px)',
          }}>
            {gc.inviterAvatar
              ? <img src={gc.inviterAvatar} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
              : (gc.inviterName?.[0] || '?')}
          </div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{gc.inviterName || '?'}</div>
          <div style={{ fontSize: 14, opacity: 0.8 }}>
            {gc.isVideo
              ? (t('call.group_video') || 'Group Video Call')
              : (t('call.group_voice') || 'Group Voice Call')}
          </div>

          {/* Accept / Reject buttons */}
          <div style={{ display: 'flex', gap: 32, marginTop: 20 }}>
            <button onClick={gc.rejectGroupCall} style={btnStyle('#ef4444')}>
              <PhoneOff size={28} />
            </button>
            <button onClick={gc.acceptGroupCall} style={btnStyle('#22c55e')}>
              <PhoneIncoming size={28} />
            </button>
          </div>
        </div>
      )}

      {/* ── Connecting / Connected ── */}
      {(gc.status === 'connecting' || gc.status === 'connected') && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          padding: 12, overflow: 'hidden',
        }}>
          {gc.isVideo ? (
            <VideoGrid gc={gc} friends={friends} />
          ) : (
            <VoiceGrid gc={gc} friends={friends} />
          )}
        </div>
      )}

      {/* ── Controls ── */}
      {(gc.status === 'connecting' || gc.status === 'connected') && (
        <div style={{
          padding: '16px 20px',
          paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
          display: 'flex', justifyContent: 'center', gap: 20,
          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(10px)',
          zIndex: 5,
        }}>
          <button onClick={gc.toggleMute} style={smallBtnStyle(gc.isMuted)}>
            {gc.isMuted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>
          {gc.isVideo && (
            <button onClick={gc.toggleCamera} style={smallBtnStyle(gc.isCameraOff)}>
              {gc.isCameraOff ? <CameraOff size={22} /> : <VideoIcon size={22} />}
            </button>
          )}
          <button onClick={gc.leaveGroupCall} style={btnStyle('#ef4444')}>
            <PhoneOff size={28} />
          </button>
        </div>
      )}
    </div>
  )
}

// ── Video grid ──
function VideoGrid({ gc, friends }: { gc: ReturnType<typeof useGroupCallContext>; friends: any[] }) {
  const peerEntries = Array.from(gc.peers.values())
  const total = peerEntries.length + 1 // +1 for local

  const cols = total <= 2 ? 1 : total <= 4 ? 2 : 3
  const rows = Math.ceil(total / cols)

  return (
    <div style={{
      flex: 1, display: 'grid',
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gridTemplateRows: `repeat(${rows}, 1fr)`,
      gap: 4, borderRadius: 12, overflow: 'hidden',
    }}>
      {/* Local video */}
      <LocalVideoTile gc={gc} />

      {/* Remote videos */}
      {peerEntries.map(peer => (
        <RemoteVideoTile key={peer.peerId} peer={peer} friends={friends} />
      ))}
    </div>
  )
}

function LocalVideoTile({ gc }: { gc: ReturnType<typeof useGroupCallContext> }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const user = useStore(s => s.user)

  useEffect(() => {
    if (videoRef.current && gc.localStream) {
      videoRef.current.srcObject = gc.localStream
    }
  }, [gc.localStream])

  return (
    <div style={{
      position: 'relative', background: '#111', borderRadius: 8, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <video ref={videoRef} autoPlay playsInline muted
        style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      <div style={{
        position: 'absolute', bottom: 6, left: 8,
        fontSize: 12, fontWeight: 600, color: '#fff',
        background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: 6,
      }}>
        {user?.nickname || 'Me'}
      </div>
    </div>
  )
}

function RemoteVideoTile({ peer, friends }: { peer: any; friends: any[] }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const friend = friends.find(f => f.id === peer.peerId)
  const name = peer.nickname || friend?.nickname || peer.peerId?.slice(0, 6) || '?'

  useEffect(() => {
    if (videoRef.current && peer.stream) {
      videoRef.current.srcObject = peer.stream
    }
  }, [peer.stream])

  return (
    <div style={{
      position: 'relative', background: '#111', borderRadius: 8, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <video ref={videoRef} autoPlay playsInline
        style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      <div style={{
        position: 'absolute', bottom: 6, left: 8,
        fontSize: 12, fontWeight: 600, color: '#fff',
        background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: 6,
      }}>
        {name}
      </div>
    </div>
  )
}

// ── Voice grid (avatar-based) ──
function VoiceGrid({ gc, friends }: { gc: ReturnType<typeof useGroupCallContext>; friends: any[] }) {
  const user = useStore(s => s.user)
  const peerEntries = Array.from(gc.peers.values())

  return (
    <div style={{
      flex: 1, display: 'flex', flexWrap: 'wrap',
      alignItems: 'center', justifyContent: 'center',
      gap: 20, padding: 20,
    }}>
      {/* Local participant */}
      <VoiceAvatar
        name={user?.nickname || 'Me'}
        avatar={user?.avatar}
        isLocal
        isMuted={gc.isMuted}
      />

      {/* Remote participants */}
      {peerEntries.map(peer => {
        const friend = friends.find(f => f.id === peer.peerId)
        return (
          <VoiceAvatar
            key={peer.peerId}
            name={peer.nickname || friend?.nickname || peer.peerId?.slice(0, 6) || '?'}
            avatar={peer.avatar || friend?.avatar}
          />
        )
      })}
    </div>
  )
}

function VoiceAvatar({ name, avatar, isLocal, isMuted }: {
  name: string; avatar?: string; isLocal?: boolean; isMuted?: boolean
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      minWidth: 80,
    }}>
      <div style={{
        position: 'relative',
        width: 72, height: 72, borderRadius: '50%',
        background: 'rgba(255,255,255,0.15)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 28, fontWeight: 600,
        border: '3px solid rgba(255,255,255,0.2)',
        backdropFilter: 'blur(10px)',
        animation: isLocal ? undefined : 'pulse-ring 2s infinite',
      }}>
        {avatar
          ? <img src={avatar} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
          : (name?.[0] || '?')}
        {isMuted && (
          <div style={{
            position: 'absolute', bottom: -2, right: -2,
            width: 22, height: 22, borderRadius: '50%',
            background: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '2px solid rgba(0,0,0,0.5)',
          }}>
            <MicOff size={12} />
          </div>
        )}
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, opacity: 0.9, textAlign: 'center' }}>
        {name}
      </div>
    </div>
  )
}

// ── Shared button styles ──
function btnStyle(bg: string): React.CSSProperties {
  return {
    width: 64, height: 64, borderRadius: '50%', border: 'none',
    background: bg, color: '#fff', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: bg.startsWith('rgba') ? 'none' : `0 4px 20px ${bg}66`,
  }
}

function smallBtnStyle(active: boolean): React.CSSProperties {
  return {
    width: 52, height: 52, borderRadius: '50%', border: 'none',
    background: active ? '#ef4444' : 'rgba(255,255,255,0.2)',
    color: '#fff', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backdropFilter: 'blur(10px)',
  }
}
