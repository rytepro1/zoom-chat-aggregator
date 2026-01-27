import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const MeetingsContext = createContext(null);

// API base URL
const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

export function MeetingsProvider({ children, socket }) {
  const [meetings, setMeetings] = useState([]);

  // Load connected meetings on mount
  useEffect(() => {
    fetchConnectedMeetings();
  }, []);

  // Listen for meeting connection updates from socket
  useEffect(() => {
    if (!socket) return;

    socket.on('meetingConnected', (meeting) => {
      setMeetings(prev => {
        const exists = prev.find(m => m.id === meeting.id);
        if (exists) {
          return prev.map(m => m.id === meeting.id ? { ...m, ...meeting } : m);
        }
        return [...prev, meeting];
      });
    });

    socket.on('meetingDisconnected', ({ id }) => {
      setMeetings(prev => prev.filter(m => m.id !== id));
    });

    socket.on('meetingStatus', ({ id, status }) => {
      setMeetings(prev =>
        prev.map(m => m.id === id ? { ...m, status } : m)
      );
    });

    return () => {
      socket.off('meetingConnected');
      socket.off('meetingDisconnected');
      socket.off('meetingStatus');
    };
  }, [socket]);

  const fetchConnectedMeetings = async () => {
    try {
      const response = await fetch(`${API_URL}/api/meetings`);
      if (response.ok) {
        const data = await response.json();
        setMeetings(data.meetings || []);
      }
    } catch (error) {
      console.error('Failed to fetch connected meetings:', error);
    }
  };

  const connectToMeeting = useCallback(async ({ meetingId, passcode, roomName }) => {
    const response = await fetch(`${API_URL}/api/meetings/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId, passcode, roomName })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to connect to meeting');
    }

    // Add to local state immediately
    setMeetings(prev => [...prev, {
      id: data.id || meetingId,
      meetingId,
      roomName,
      status: 'connecting',
      isMock: data.isMock || false
    }]);

    return data;
  }, []);

  const disconnectFromMeeting = useCallback(async (id) => {
    const response = await fetch(`${API_URL}/api/meetings/${id}/disconnect`, {
      method: 'POST'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to disconnect from meeting');
    }

    // Remove from local state
    setMeetings(prev => prev.filter(m => m.id !== id && m.meetingId !== id));

    return data;
  }, []);

  const value = {
    meetings,
    connectToMeeting,
    disconnectFromMeeting,
    refreshMeetings: fetchConnectedMeetings
  };

  return (
    <MeetingsContext.Provider value={value}>
      {children}
    </MeetingsContext.Provider>
  );
}

export function useMeetings() {
  const context = useContext(MeetingsContext);
  if (!context) {
    throw new Error('useMeetings must be used within a MeetingsProvider');
  }
  return context;
}
