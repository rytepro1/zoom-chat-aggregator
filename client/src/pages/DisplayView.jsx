import React, { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import ChatMessage from '../components/ChatMessage';
import { SettingsProvider, useSettings } from '../contexts/SettingsContext';

const SOCKET_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

function DisplayViewContent() {
  const [messages, setMessages] = useState([]);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState({ totalMessages: 0, activeRooms: 0 });
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef(null);
  const { settings } = useSettings();

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling']
    });

    socket.on('connect', () => {
      setConnected(true);
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    socket.on('initialState', (data) => {
      setMessages(data.messages || []);
      setStats(data.stats || { totalMessages: 0, activeRooms: 0 });
    });

    socket.on('newMessage', (message) => {
      setMessages(prev => [...prev, message].slice(-500));
      setStats(prev => ({
        ...prev,
        totalMessages: prev.totalMessages + 1
      }));
    });

    socket.on('stats', (data) => {
      setStats(data.stats);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: settings.animationsEnabled ? 'smooth' : 'auto'
      });
    }
  }, [messages, autoScroll, settings.animationsEnabled]);

  // Detect manual scroll
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    }
  };

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--bg-color)',
        color: 'var(--text-color)',
        fontFamily: 'var(--font-family)',
        fontSize: 'var(--base-font-size)',
      }}
    >
      {/* Minimal header */}
      <div
        className="flex items-center justify-between px-6 py-3 border-b border-white/10"
        style={{ backgroundColor: 'var(--header-color)' }}
      >
        <div className="flex items-center gap-3">
          {settings.logoUrl && (
            <img src={settings.logoUrl} alt="Logo" className="h-8 w-auto" />
          )}
          <h1
            className="text-xl font-bold"
            style={{ color: 'var(--accent-color)' }}
          >
            {settings.appTitle}
          </h1>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
            {connected ? 'Live' : 'Disconnected'}
          </span>
          <span style={{ color: 'var(--secondary-text-color)' }}>
            {stats.activeRooms} rooms • {messages.length} messages
          </span>
        </div>
      </div>

      {/* Full-screen chat feed */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-6 relative"
      >
        {messages.length === 0 ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: 'var(--secondary-text-color)' }}
          >
            <div className="text-center">
              <p className="text-2xl mb-2">Waiting for messages...</p>
              <p className="text-sm">
                Connect to meetings in the main window to see chat here
              </p>
            </div>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto">
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
          </div>
        )}

        {/* Auto-scroll controls */}
        <div className="fixed bottom-6 right-6 flex items-center gap-2">
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
            className="text-white p-4 rounded-full shadow-lg transition-all hover:scale-105"
            style={{ backgroundColor: autoScroll ? 'var(--accent-color)' : '#ef4444' }}
            title={autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
          >
            {autoScroll ? (
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

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
              className="text-white px-4 py-3 rounded-full shadow-lg transition-colors hover:opacity-90"
              style={{ backgroundColor: 'var(--accent-color)' }}
            >
              ↓ New messages
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Wrap with SettingsProvider for standalone use
function DisplayView() {
  return (
    <SettingsProvider>
      <DisplayViewContent />
    </SettingsProvider>
  );
}

export default DisplayView;
