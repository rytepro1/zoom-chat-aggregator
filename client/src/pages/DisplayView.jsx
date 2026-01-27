import React, { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import ChatMessage from '../components/ChatMessage';
import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { ModerationProvider, useModeration } from '../contexts/ModerationContext';

const SOCKET_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

function DisplayViewContent({ socket }) {
  const [messages, setMessages] = useState([]);
  const [connected, setConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showControls, setShowControls] = useState(false);
  const containerRef = useRef(null);
  const hideControlsTimeout = useRef(null);
  const { settings } = useSettings();
  const { featuredMessage } = useModeration();

  useEffect(() => {
    if (!socket) return;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('initialState', (data) => {
      setMessages(data.messages || []);
    });

    socket.on('newMessage', (message) => {
      setMessages(prev => [...prev, message].slice(-500));
    });

    if (socket.connected) setConnected(true);
  }, [socket]);

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

  // Show controls on mouse move, hide after delay
  const handleMouseMove = () => {
    setShowControls(true);
    if (hideControlsTimeout.current) {
      clearTimeout(hideControlsTimeout.current);
    }
    hideControlsTimeout.current = setTimeout(() => {
      setShowControls(false);
    }, 3000);
  };

  // Keyboard shortcut: Space to toggle pause
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        setAutoScroll(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div
      className="h-screen w-screen overflow-hidden cursor-none"
      style={{
        backgroundColor: 'var(--bg-color)',
        color: 'var(--text-color)',
        fontFamily: 'var(--font-family)',
        fontSize: 'var(--base-font-size)',
      }}
      onMouseMove={handleMouseMove}
    >
      {/* Featured Message - Floating at top */}
      {featuredMessage && (
        <div className="fixed top-0 left-0 right-0 z-50 p-6">
          <div
            className="max-w-5xl mx-auto p-8 rounded-2xl shadow-2xl backdrop-blur-sm"
            style={{
              backgroundColor: featuredMessage.roomColor || 'var(--accent-color)',
              boxShadow: `0 25px 50px -12px ${featuredMessage.roomColor || 'var(--accent-color)'}66`
            }}
          >
            <div className="flex items-start gap-5">
              <div className="flex-shrink-0 w-14 h-14 rounded-full bg-white/20 flex items-center justify-center">
                <span className="text-white text-2xl font-bold">
                  {featuredMessage.sender?.charAt(0)?.toUpperCase() || '?'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white/70 text-lg font-medium mb-2">
                  {featuredMessage.sender}
                  <span className="mx-2 text-white/40">•</span>
                  <span className="text-white/50">{featuredMessage.room}</span>
                </p>
                <p className="text-white text-3xl font-semibold leading-relaxed break-words">
                  {featuredMessage.content}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Full-screen chat feed */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full w-full overflow-y-auto px-8 py-6"
        style={{
          paddingTop: featuredMessage ? '200px' : '24px'
        }}
      >
        {messages.length === 0 ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: 'var(--secondary-text-color)' }}
          >
            <div className="text-center opacity-50">
              <div className="w-16 h-16 mx-auto mb-6 rounded-full border-4 border-current border-t-transparent animate-spin" />
              <p className="text-2xl">Waiting for messages...</p>
            </div>
          </div>
        ) : (
          <div className="max-w-5xl mx-auto space-y-1">
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} displayMode />
            ))}
          </div>
        )}
      </div>

      {/* Minimal controls - only visible on mouse move */}
      <div
        className={`fixed bottom-6 right-6 flex items-center gap-3 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ cursor: 'default' }}
      >
        {/* Connection indicator */}
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/50 backdrop-blur-sm">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
          <span className="text-white/70 text-sm">
            {connected ? 'Live' : 'Disconnected'}
          </span>
        </div>

        {/* Pause/Play */}
        <button
          onClick={() => {
            setAutoScroll(prev => {
              if (!prev && containerRef.current) {
                containerRef.current.scrollTo({
                  top: containerRef.current.scrollHeight,
                  behavior: 'smooth'
                });
              }
              return !prev;
            });
          }}
          className="w-12 h-12 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white hover:bg-black/70 transition-colors"
          title={autoScroll ? 'Pause (Space)' : 'Play (Space)'}
          style={{ cursor: 'pointer' }}
        >
          {autoScroll ? (
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
      </div>

      {/* Paused indicator - center of screen */}
      {!autoScroll && (
        <div className="fixed inset-0 pointer-events-none flex items-center justify-center">
          <div className="bg-black/60 backdrop-blur-sm px-8 py-4 rounded-2xl">
            <span className="text-white text-xl font-medium">⏸ Paused</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Wrap with providers for standalone use
function DisplayView() {
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    const newSocket = io(SOCKET_URL, {
      transports: ['websocket', 'polling']
    });
    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  return (
    <SettingsProvider>
      <ModerationProvider socket={socket}>
        <DisplayViewContent socket={socket} />
      </ModerationProvider>
    </SettingsProvider>
  );
}

export default DisplayView;
