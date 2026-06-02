import React, { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import ChatMessage from '../components/ChatMessage';
import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { ModerationProvider, useModeration } from '../contexts/ModerationContext';
import { PresenterNotesProvider, usePresenterNotes } from '../contexts/PresenterNotesContext';
import PresenterNotesOverlay, { getPresenterNotesHeight } from '../components/PresenterNotesOverlay';

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
  const { notes: presenterNotes } = usePresenterNotes();
  const notesHeight = getPresenterNotesHeight(presenterNotes.length);

  useEffect(() => {
    if (!socket) return;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('initialState', (data) => {
      setMessages(data.messages || []);
    });

    // Server ships messages as batches every 100ms (high-volume rooms).
    // One setState per batch — keeps the presenter view smooth even
    // when a single 100ms window has 40+ messages.
    socket.on('newMessageBatch', (batch) => {
      if (!Array.isArray(batch) || batch.length === 0) return;
      setMessages(prev => [...prev, ...batch].slice(-500));
    });
    // Legacy single-message event — resilience for stale-server case.
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
      {/* Presenter notes (production team → on-air talent) — sit ABOVE
          the featured chat bubble and bump everything else down. */}
      <PresenterNotesOverlay />

      {/* Featured Message - Floating at top.
          Background: near-solid dark with a hint of the room color so
          the chat feed behind it can't bleed through. Border picks up
          the room color at high opacity to keep the visual association.
          Body text is pure white for max contrast over the dark fill.
          `top` shifts down when presenter notes are visible. */}
      {featuredMessage && (
        <div className="fixed left-0 right-0 z-50 p-6" style={{ top: `${notesHeight}px` }}>
          <div
            className="max-w-5xl mx-auto p-8 rounded-2xl shadow-2xl border-2"
            style={{
              // Layer the room-color tint over a near-opaque dark base
              // so the text isn't competing with whatever's scrolling
              // behind it.
              backgroundColor: 'rgba(15, 23, 42, 0.96)',
              backgroundImage: `linear-gradient(135deg, ${featuredMessage.roomColor || 'var(--accent-color)'}22 0%, transparent 60%)`,
              borderColor: featuredMessage.roomColor || 'var(--accent-color)',
              boxShadow: `0 25px 50px -12px ${featuredMessage.roomColor || 'var(--accent-color)'}66, 0 0 0 1px rgba(0,0,0,0.4)`,
            }}
          >
            <div className="flex items-start gap-5">
              <div
                className="flex-shrink-0 w-14 h-14 rounded-full flex items-center justify-center"
                style={{
                  backgroundColor: featuredMessage.roomColor || 'var(--accent-color)',
                }}
              >
                <span
                  className="text-2xl font-bold"
                  style={{ color: '#ffffff' }}
                >
                  {featuredMessage.sender?.charAt(0)?.toUpperCase() || '?'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-lg font-semibold mb-2" style={{ color: '#e2e8f0' }}>
                  {featuredMessage.sender}
                  <span className="mx-2" style={{ color: '#475569' }}>•</span>
                  <span
                    className="text-sm px-2 py-0.5 rounded"
                    style={{
                      backgroundColor: featuredMessage.roomColor || 'var(--accent-color)',
                      color: '#ffffff',
                    }}
                  >
                    {featuredMessage.room}
                  </span>
                </p>
                <p
                  className="text-3xl font-semibold leading-relaxed break-words"
                  style={{ color: '#ffffff' }}
                >
                  {featuredMessage.content}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Full-screen chat feed — padded down past notes + featured. */}
      <div
        ref={containerRef}
        className="h-full w-full overflow-y-auto px-8 py-6"
        style={{
          paddingTop: `${notesHeight + (featuredMessage ? 200 : 24)}px`,
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
      transports: ['websocket', 'polling'],
      withCredentials: true,
    });
    newSocket.on('connect_error', (err) => {
      console.warn('[display socket] connect_error:', err.message);
      if (/sign|session/i.test(err.message || '')) {
        window.location.href = '/signin';
      }
    });
    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  return (
    <SettingsProvider>
      <ModerationProvider socket={socket}>
        <PresenterNotesProvider socket={socket}>
          <DisplayViewContent socket={socket} />
        </PresenterNotesProvider>
      </ModerationProvider>
    </SettingsProvider>
  );
}

export default DisplayView;
