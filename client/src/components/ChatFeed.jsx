import React, { useEffect, useRef } from 'react';
import ChatMessage from './ChatMessage';
import { useSettings } from '../contexts/SettingsContext';

function ChatFeed({ messages, selectedRoom }) {
  const { settings } = useSettings();
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = React.useState(true);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      const container = containerRef.current;
      if (settings.animationsEnabled) {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: 'smooth'
        });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [messages, autoScroll, settings.animationsEnabled]);

  // Detect if user has scrolled up
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    setAutoScroll(isAtBottom);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="px-4 py-2 border-b border-white/10 flex items-center justify-between"
        style={{ backgroundColor: 'var(--header-color)' }}
      >
        <span style={{ color: 'var(--text-color)' }}>
          {selectedRoom ? `Filtering: ${selectedRoom}` : 'All Rooms'}
        </span>
        <span
          className="text-sm"
          style={{ color: 'var(--secondary-text-color)' }}
        >
          {messages.length} messages
        </span>
      </div>

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4"
      >
        {messages.length === 0 ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: 'var(--secondary-text-color)' }}
          >
            <div className="text-center">
              <p className="text-xl mb-2">No messages yet</p>
              <p className="text-sm">
                Messages from Zoom meetings will appear here in real-time
              </p>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <ChatMessage key={message.id} message={message} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Auto-scroll controls */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2">
        {/* Pause/Play button */}
        <button
          onClick={() => {
            if (autoScroll) {
              setAutoScroll(false);
            } else {
              setAutoScroll(true);
              if (containerRef.current) {
                containerRef.current.scrollTo({
                  top: containerRef.current.scrollHeight,
                  behavior: 'smooth'
                });
              }
            }
          }}
          className="text-white p-3 rounded-full shadow-lg transition-all hover:scale-105"
          style={{ backgroundColor: autoScroll ? 'var(--accent-color)' : '#ef4444' }}
          title={autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
        >
          {autoScroll ? (
            // Pause icon
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
            </svg>
          ) : (
            // Play icon
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* New messages indicator when paused */}
        {!autoScroll && (
          <button
            onClick={() => {
              setAutoScroll(true);
              if (containerRef.current) {
                containerRef.current.scrollTo({
                  top: containerRef.current.scrollHeight,
                  behavior: 'smooth'
                });
              }
            }}
            className="text-white px-4 py-2 rounded-full shadow-lg transition-colors hover:opacity-90"
            style={{ backgroundColor: 'var(--accent-color)' }}
          >
            ↓ New messages
          </button>
        )}
      </div>
    </div>
  );
}

export default ChatFeed;
