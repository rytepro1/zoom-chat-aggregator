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
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({
        behavior: settings.animationsEnabled ? 'smooth' : 'auto'
      });
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

      {/* Auto-scroll indicator */}
      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
          className="absolute bottom-4 right-4 text-white px-4 py-2 rounded-full shadow-lg transition-colors hover:opacity-90"
          style={{ backgroundColor: 'var(--accent-color)' }}
        >
          ↓ New messages
        </button>
      )}
    </div>
  );
}

export default ChatFeed;
