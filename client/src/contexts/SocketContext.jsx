import React, { createContext, useContext, useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { MeetingsProvider } from './MeetingsContext';
import { ModerationProvider } from './ModerationContext';
import { SavedProvider } from './SavedContext';
import { SessionProvider } from './SessionContext';

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

  useEffect(() => {
    const newSocket = io(SOCKET_URL, {
      transports: ['websocket', 'polling']
    });

    newSocket.on('connect', () => {
      console.log('Connected to server');
      setConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('Disconnected from server');
      setConnected(false);
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

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Filter messages by selected room
  const filteredMessages = selectedRoom
    ? messages.filter(m => m.room === selectedRoom || m.meetingId === selectedRoom)
    : messages;

  const value = {
    socket,
    connected,
    messages: filteredMessages,
    allMessages: messages,
    rooms,
    stats,
    selectedRoom,
    setSelectedRoom
  };

  return (
    <SocketContext.Provider value={value}>
      <SessionProvider socket={socket}>
        <MeetingsProvider socket={socket}>
          <ModerationProvider socket={socket}>
            <SavedProvider socket={socket}>
              {children}
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
