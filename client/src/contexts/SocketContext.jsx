import React, { createContext, useContext, useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { MeetingsProvider } from './MeetingsContext';
import { ModerationProvider } from './ModerationContext';
import { SavedProvider } from './SavedContext';
import { SessionProvider } from './SessionContext';
import { RostersProvider } from './RostersContext';

const SocketContext = createContext(null);

const SOCKET_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

export function SocketProvider({ children }) {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [stats, setStats] = useState({
    totalMessages: 0,
    activeRooms: 0
  });
  const [selectedRoom, setSelectedRoom] = useState(null);
  // Phase 3 — trial enforcement state, kept fresh via socket events.
  // Initially null; populated by `trialUpdate` (every 30s) once the
  // TrialEnforcer ticks. Components default to /me's snapshot if null.
  const [trialState, setTrialState] = useState({
    remainingMinutes: null,
    usedMinutes: null,
    quotaMinutes: null,
    warningShown: false,
    exhausted: false,
    upgradeUrl: null,
  });

  useEffect(() => {
    const newSocket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      // Send the session cookie on the WebSocket handshake so the
      // server-side auth middleware can identify the user.
      withCredentials: true,
    });

    newSocket.on('connect', () => {
      console.log('Connected to server');
      setConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('Disconnected from server');
      setConnected(false);
    });

    // Server rejected the auth handshake (cookie missing/expired). Send
    // the user back to sign in — sticky disconnects with this reason
    // mean their session is gone.
    newSocket.on('connect_error', (err) => {
      console.warn('[socket] connect_error:', err.message);
      if (/sign|session/i.test(err.message || '')) {
        window.location.href = '/signin';
      }
    });

    // Receive initial state
    newSocket.on('initialState', (data) => {
      console.log('Received initial state:', data);
      setMessages(data.messages || []);
      setRooms(data.rooms || []);
      setStats(data.stats || { totalMessages: 0, activeRooms: 0 });
    });

    // New message received
    newSocket.on('newMessage', (message) => {
      setMessages(prev => [...prev, message].slice(-500));
      setStats(prev => ({
        ...prev,
        totalMessages: prev.totalMessages + 1
      }));
    });

    // Room updates
    newSocket.on('roomAdded', (room) => {
      setRooms(prev => [...prev, room]);
      setStats(prev => ({
        ...prev,
        activeRooms: prev.activeRooms + 1
      }));
    });

    newSocket.on('roomRemoved', ({ id }) => {
      setRooms(prev => prev.filter(r => r.id !== id));
      setStats(prev => ({
        ...prev,
        activeRooms: Math.max(0, prev.activeRooms - 1)
      }));
    });

    // Stats update
    newSocket.on('stats', (data) => {
      setStats(data.stats);
    });

    // Phase 3 — trial enforcement events. TrialEnforcer emits these to
    // the org's room; we keep local state so the UI banner/modal can
    // react without an extra round-trip.
    newSocket.on('trialUpdate', ({ remainingMinutes, usedMinutes, quotaMinutes }) => {
      setTrialState(prev => ({ ...prev, remainingMinutes, usedMinutes, quotaMinutes }));
    });
    newSocket.on('trialWarning', () => {
      setTrialState(prev => ({ ...prev, warningShown: true }));
    });
    newSocket.on('trialExhausted', ({ upgradeUrl }) => {
      setTrialState(prev => ({ ...prev, exhausted: true, upgradeUrl }));
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Filter messages by selected room
  const filteredMessages = selectedRoom
    ? messages.filter(m => m.room === selectedRoom || m.meetingId === selectedRoom)
    : messages;

  const dismissTrialWarning = () => setTrialState(prev => ({ ...prev, warningShown: false }));

  const value = {
    socket,
    connected,
    messages: filteredMessages,
    allMessages: messages,
    rooms,
    stats,
    selectedRoom,
    setSelectedRoom,
    trialState,
    dismissTrialWarning,
  };

  return (
    <SocketContext.Provider value={value}>
      <SessionProvider socket={socket}>
        <MeetingsProvider socket={socket}>
          <ModerationProvider socket={socket}>
            <SavedProvider socket={socket}>
              <RostersProvider>
                {children}
              </RostersProvider>
            </SavedProvider>
          </ModerationProvider>
        </MeetingsProvider>
      </SessionProvider>
    </SocketContext.Provider>
  );
}

export function useSocketContext() {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocketContext must be used within a SocketProvider');
  }
  return context;
}
