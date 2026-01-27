import React from 'react';
import { useSettings } from '../contexts/SettingsContext';

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

function ChatMessage({ message }) {
  const { settings } = useSettings();
  // Use custom roomColor if provided, otherwise fall back to generated color
  const roomColor = message.roomColor || getRoomColor(message.room);

  const spacingClasses = {
    compact: 'p-2',
    comfortable: 'p-3',
    spacious: 'p-4',
  };

  return (
    <div
      className={`flex items-start gap-3 rounded-lg hover:bg-white/5 ${
        settings.animationsEnabled ? 'transition-all duration-200' : ''
      } ${spacingClasses[settings.messageSpacing] || 'p-3'}`}
      style={{
        backgroundColor: 'rgba(255,255,255,0.03)',
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
      </div>
    </div>
  );
}

export default ChatMessage;
