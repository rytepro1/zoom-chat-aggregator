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
  // Start true so the cursor is visible when the operator first opens
  // the presenter window — otherwise they can't find it to drag the
  // (borderless) window to the secondary display. Idle-hides after 3s.
  const [showControls, setShowControls] = useState(true);
  const containerRef = useRef(null);
  const hideControlsTimeout = useRef(null);
  const scrollIntervalRef = useRef(null);
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

  // Always auto-scroll on new messages - no pause capability
  useEffect(() => {
    if (containerRef.current) {
      // Use requestAnimationFrame for smoother scrolling
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTo({
            top: containerRef.current.scrollHeight,
            behavior: 'smooth'
          });
        }
      });
    }
  }, [messages]);

  // Backup: periodic scroll check to ensure we stay at bottom
  useEffect(() => {
    scrollIntervalRef.current = setInterval(() => {
      if (containerRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;

        // If not near bottom, scroll down
        if (!isNearBottom) {
          containerRef.current.scrollTo({
            top: containerRef.current.scrollHeight,
            behavior: 'smooth'
          });
        }
      }
    }, 2000); // Check every 2 seconds

    return () => {
      if (scrollIntervalRef.current) {
        clearInterval(scrollIntervalRef.current);
      }
    };
  }, []);

  // Show cursor + controls on mouse move, hide both after delay so
  // the on-air presenter view is clean during a show but the operator
  // can still find the cursor when setting up the window.
  const handleMouseMove = () => {
    setShowControls(true);
    if (hideControlsTimeout.current) {
      clearTimeout(hideControlsTimeout.current);
    }
    hideControlsTimeout.current = setTimeout(() => {
      setShowControls(false);
    }, 3000);
  };

  return (
    <div
      className="h-screen w-screen overflow-hidden"
      style={{
        backgroundColor: 'var(--bg-color)',
        color: 'var(--text-color)',
        fontFamily: 'var(--font-family)',
        fontSize: 'var(--base-font-size)',
        // Cursor stays visible — operator needs it to drag the
        // borderless window into position, and a tiny arrow in the
        // corner during a live event is unobtrusive enough that the
        // on-air host won't be distracted.
        cursor: 'default',
      }}
      onMouseMove={handleMouseMove}
    >
      {/* Featured Message - Floating at top */}
      {featuredMessage && (
        <div className="fixed top-0 left-0 right-0 z-50 p-6">
          <div
            className="max-w-5xl mx-auto p-8 rounded-2xl shadow-2xl backdrop-blur-md border"
            style={{
              backgroundColor: `${featuredMessage.roomColor || 'var(--accent-color)'}25`,
              borderColor: `${featuredMessage.roomColor || 'var(--accent-color)'}50`,
              boxShadow: `0 25px 50px -12px ${featuredMessage.roomColor || 'var(--accent-color)'}33`
            }}
          >
            <div className="flex items-start gap-5">
              <div
                className="flex-shrink-0 w-14 h-14 rounded-full flex items-center justify-center"
                style={{
                  backgroundColor: `${featuredMessage.roomColor || 'var(--accent-color)'}40`
                }}
              >
                <span
                  className="text-2xl font-bold"
                  style={{ color: featuredMessage.roomColor || 'var(--accent-color)' }}
                >
                  {featuredMessage.sender?.charAt(0)?.toUpperCase() || '?'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-lg font-medium mb-2" style={{ color: 'var(--text-color)', opacity: 0.7 }}>
                  {featuredMessage.sender}
                  <span className="mx-2" style={{ opacity: 0.4 }}>•</span>
                  <span
                    className="text-sm px-2 py-0.5 rounded"
                    style={{
                      backgroundColor: `${featuredMessage.roomColor || 'var(--accent-color)'}40`,
                      color: featuredMessage.roomColor || 'var(--accent-color)',
                    }}
                  >
                    {featuredMessage.room}
                  </span>
                </p>
                <p
                  className="text-3xl font-semibold leading-relaxed break-words"
                  style={{ color: 'var(--text-color)' }}
                >
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

      {/* Minimal status indicator - only visible on mouse move */}
      <div
        className={`fixed bottom-6 right-6 flex items-center gap-3 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ cursor: 'default' }}
      >
        {/* Connection indicator */}
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/50 backdrop-blur-sm">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
          <span className="text-white/70 text-sm">
            {connected ? 'Live' : 'Disconnected'}
          </span>
          <span className="text-white/50 text-sm">
            • {messages.length} messages
          </span>
        </div>
      </div>
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
