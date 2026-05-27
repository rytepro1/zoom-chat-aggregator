import React, { useState, useContext, useCallback } from 'react';
import { useSettings } from '../contexts/SettingsContext';

// Create a fallback context for when ModerationProvider isn't available
const ModerationContext = React.createContext(null);

// Safe hook that won't throw if context is missing
function useModerationSafe() {
  return useContext(ModerationContext);
}

// Re-export so ModerationContext.jsx can use it
export { ModerationContext };

// Safe access to SavedContext — ChatMessage is also used inside
// DisplayView, which has its own React root and doesn't currently wrap
// a SavedProvider. We probe the context module's exported context
// directly so we can return null instead of throwing when there's no
// provider above us.
// eslint-disable-next-line no-restricted-syntax
import * as SavedModule from '../contexts/SavedContext';
function useSavedSafe() {
  try {
    return SavedModule.useSaved();
  } catch {
    return null;
  }
}

// Generate consistent color for each room
function getRoomColor(roomName) {
  const colors = [
    '#3b82f6', // blue
    '#22c55e', // green
    '#a855f7', // purple
    '#f97316', // orange
    '#ec4899', // pink
    '#14b8a6', // teal
    '#6366f1', // indigo
    '#ef4444', // red
    '#eab308', // yellow
    '#06b6d4', // cyan
  ];

  let hash = 0;
  for (let i = 0; i < roomName.length; i++) {
    hash = roomName.charCodeAt(i) + ((hash << 5) - hash);
  }

  return colors[Math.abs(hash) % colors.length];
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

function ChatMessage({ message, showActions = true, onFeature, moderation: moderationProp, displayMode = false }) {
  const { settings } = useSettings();
  const moderationFromContext = useModerationSafe();
  const moderation = moderationProp || moderationFromContext;
  const saved = useSavedSafe();
  const isSaved = saved ? saved.isSaved(message.id) || message.saved : false;

  // Reply state — collapsed input that expands inline when the Reply
  // button is clicked. The reply goes to the bot in the message's
  // originating meeting (not a broadcast).
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState('');

  const handleToggleSave = useCallback(() => {
    if (!saved) return;
    const fn = isSaved ? saved.unsaveMessage : saved.saveMessage;
    fn(message.id).catch((err) => {
      console.error('Save toggle failed:', err);
    });
  }, [saved, isSaved, message.id]);

  const sendReply = useCallback(async () => {
    const text = replyText.trim();
    if (!text || !message.meetingId) return;
    setReplySending(true);
    setReplyError('');
    try {
      const res = await fetch(
        `${API_URL}/api/meetings/${encodeURIComponent(message.meetingId)}/reply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setReplyText('');
      setReplyOpen(false);
    } catch (err) {
      setReplyError(err.message);
    } finally {
      setReplySending(false);
    }
  }, [message.meetingId, replyText]);

  // Use custom roomColor if provided, otherwise fall back to generated color
  const roomColor = message.roomColor || getRoomColor(message.room);

  const isHighlighted = moderation?.isHighlighted(message.id);
  const isQueued = moderation?.isQueued(message.id);

  const spacingClasses = {
    compact: 'p-2',
    comfortable: 'p-3',
    spacious: 'p-4',
  };

  // Display mode: cleaner, larger text for video walls. Font sizes are
  // driven by the operator's typography settings (--message-font-size)
  // multiplied by --display-scale, so the slider in the main window
  // changes the display window's text size in real time (storage event
  // sync from SettingsContext keeps both windows in lockstep).
  if (displayMode) {
    return (
      <div
        className={`flex items-start gap-4 py-4 px-2 ${isHighlighted ? 'bg-yellow-400/20' : ''}`}
        style={{
          borderLeft: `4px solid ${isHighlighted ? '#facc15' : roomColor}`,
          marginBottom: '8px',
          boxShadow: isHighlighted ? '0 0 20px rgba(250, 204, 21, 0.3)' : 'none',
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3 mb-1">
            <span
              className="font-bold"
              style={{
                color: 'var(--text-color)',
                fontSize: 'calc(var(--message-font-size, 16px) * var(--display-scale, 1.5))',
              }}
            >
              {message.sender}
            </span>
            <span
              className="px-2 py-0.5 rounded"
              style={{
                backgroundColor: roomColor,
                color: 'white',
                fontSize: 'calc(var(--message-font-size, 16px) * var(--display-scale, 1.5) * 0.7)',
              }}
            >
              {message.room}
            </span>
            {isHighlighted && (
              <span className="text-yellow-400 animate-pulse">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                </svg>
              </span>
            )}
          </div>
          <p
            className="leading-relaxed"
            style={{
              color: 'var(--text-color)',
              opacity: 0.95,
              fontSize: 'calc(var(--message-font-size, 16px) * var(--display-scale, 1.5))',
            }}
          >
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  // Outgoing messages (operator-sent replies + broadcasts) get a
  // distinct visual treatment so the operator can easily spot what
  // they sent in the unified feed.
  const isOutgoing = message.type === 'reply' || message.type === 'broadcast';
  const outgoingLabel = message.type === 'reply' ? '↩ Reply' : message.type === 'broadcast' ? '📢 Broadcast' : null;

  return (
    <div
      className={`flex items-start gap-3 rounded-lg relative group ${
        settings.animationsEnabled ? 'transition-all duration-200' : ''
      } ${spacingClasses[settings.messageSpacing] || 'p-3'} ${
        isHighlighted ? 'ring-2 ring-yellow-400 bg-yellow-400/10' : ''
      }`}
      style={{
        backgroundColor: isHighlighted
          ? 'rgba(250, 204, 21, 0.1)'
          : isOutgoing
            ? 'rgba(59, 130, 246, 0.10)'   // subtle accent tint for outgoing
            : 'rgba(255,255,255,0.03)',
        borderLeft: isOutgoing ? '3px solid var(--accent-color)' : undefined,
        marginBottom: 'var(--message-spacing)',
      }}
    >
      {/* Room badge */}
      {settings.showRoomBadges && (
        <span
          className="text-white text-xs px-2 py-1 rounded font-medium whitespace-nowrap"
          style={{
            backgroundColor: roomColor,
            fontSize: settings.messageFontSize === 'xlarge' ? '14px' : '12px',
          }}
        >
          {message.room.length > 15 ? message.room.substring(0, 15) + '...' : message.room}
        </span>
      )}

      {/* Message content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          {outgoingLabel && (
            <span
              className="text-xs px-1.5 py-0.5 rounded font-medium"
              style={{
                backgroundColor: 'var(--accent-color)',
                color: 'white',
              }}
              title={message.type === 'reply' ? 'Sent by an operator as a reply to this room' : 'Sent by an operator as a broadcast to all rooms'}
            >
              {outgoingLabel}
            </span>
          )}
          {settings.showSenderNames && (
            <span
              className="font-semibold"
              style={{
                color: 'var(--text-color)',
                fontSize: 'var(--message-font-size)',
              }}
            >
              {message.sender}
            </span>
          )}
          {settings.showTimestamps && (
            <span
              className="text-xs"
              style={{ color: 'var(--secondary-text-color)' }}
            >
              {formatTime(message.timestamp)}
            </span>
          )}
        </div>
        <p
          className="mt-1 break-words"
          style={{
            color: 'var(--text-color)',
            opacity: 0.9,
            fontSize: 'var(--message-font-size)',
            lineHeight: 1.5,
          }}
        >
          {message.content}
        </p>

        {/* Inline reply form — expands when the operator clicks Reply.
            Goes to this message's originating meeting only (not a
            broadcast). */}
        {replyOpen && (
          <div className="mt-2 flex flex-col gap-1.5">
            <textarea
              autoFocus
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  sendReply();
                } else if (e.key === 'Escape') {
                  setReplyOpen(false);
                  setReplyText('');
                  setReplyError('');
                }
              }}
              rows={2}
              placeholder={`Reply to ${message.room || 'this room'}…  (⌘↩ to send, esc to cancel)`}
              className="w-full px-3 py-2 rounded bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none text-sm resize-none"
              style={{ color: 'var(--text-color)' }}
            />
            {replyError && (
              <div className="text-xs text-red-400">{replyError}</div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setReplyOpen(false); setReplyText(''); setReplyError(''); }}
                disabled={replySending}
                className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50"
                style={{ color: 'var(--text-color)' }}
              >
                Cancel
              </button>
              <button
                onClick={sendReply}
                disabled={replySending || !replyText.trim()}
                className="text-xs px-3 py-1 rounded disabled:opacity-50 hover:opacity-90"
                style={{ backgroundColor: 'var(--accent-color)', color: 'white' }}
              >
                {replySending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Action buttons - always visible on moderator view */}
      {showActions && moderation && (
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Reply button — only when message has a meetingId we can
              route the reply through (real Recall bots, not test
              messages or RTMS mock). */}
          {message.meetingId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setReplyOpen(o => !o);
              }}
              className={`p-3 rounded-lg transition-colors ${
                replyOpen
                  ? 'bg-blue-500 text-white'
                  : 'text-gray-400 hover:text-blue-400 hover:bg-blue-400/20'
              }`}
              title={replyOpen ? 'Close reply' : 'Reply to this room'}
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/>
              </svg>
            </button>
          )}

          {/* Save (bookmark) button — only renders when SavedProvider is in scope */}
          {saved && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleToggleSave();
              }}
              className={`p-3 rounded-lg transition-colors ${
                isSaved
                  ? 'bg-purple-500 text-white'
                  : 'text-gray-400 hover:text-purple-400 hover:bg-purple-400/20'
              }`}
              title={isSaved ? 'Remove from Saved' : 'Save for export'}
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
              </svg>
            </button>
          )}

          {/* Highlight button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              moderation.toggleHighlight(message);
            }}
            className={`p-3 rounded-lg transition-colors ${
              isHighlighted
                ? 'bg-yellow-400 text-gray-900'
                : 'text-gray-400 hover:text-yellow-400 hover:bg-yellow-400/20'
            }`}
            title={isHighlighted ? 'Remove Highlight' : 'Highlight'}
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
          </button>

          {/* Queue button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (isQueued) {
                moderation.removeFromQueue(message.id);
              } else {
                moderation.addToQueue(message);
              }
            }}
            className={`p-3 rounded-lg transition-colors ${
              isQueued
                ? 'bg-blue-500 text-white'
                : 'text-gray-400 hover:text-blue-400 hover:bg-blue-400/20'
            }`}
            title={isQueued ? 'Remove from Queue' : 'Add to Queue'}
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z"/>
            </svg>
          </button>

          {/* Feature Now button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              moderation.featureMessage(message);
            }}
            className="p-3 rounded-lg text-gray-400 hover:text-green-400 hover:bg-green-400/20 transition-colors"
            title="Feature Now"
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

export default ChatMessage;
