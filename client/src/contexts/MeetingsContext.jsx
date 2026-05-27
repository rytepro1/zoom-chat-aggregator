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
        // Match by either id or meetingId — the optimistic add and the
        // server event use the cleaned meeting ID for both, but match
        // both fields to be safe.
        const idx = prev.findIndex(m =>
          m.id === meeting.id || m.meetingId === meeting.meetingId
        );
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], ...meeting };
          return next;
        }
        return [...prev, meeting];
      });
    });

    socket.on('meetingDisconnected', ({ id }) => {
      setMeetings(prev => prev.filter(m => m.id !== id && m.meetingId !== id));
    });

    socket.on('meetingStatus', ({ id, status }) => {
      setMeetings(prev =>
        prev.map(m => (m.id === id || m.meetingId === id) ? { ...m, status } : m)
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

  const connectToMeeting = useCallback(async ({ meetingId, passcode, roomName, roomColor, botName }) => {
    const response = await fetch(`${API_URL}/api/meetings/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId, passcode, roomName, roomColor, botName })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to connect to meeting');
    }

    // Add to local state immediately. The socket `meetingConnected`
    // event can land before this HTTP response resolves, so we have to
    // dedup — otherwise we'd render the same meeting twice (one
    // "connected" from the socket, one stale "connecting" from here).
    setMeetings(prev => {
      const id = data.id || meetingId;
      const existing = prev.find(m => m.id === id || m.meetingId === meetingId);
      if (existing) {
        // Refresh fields the user typed (roomName/roomColor) but keep
        // status from the socket event if it already arrived.
        return prev.map(m =>
          (m.id === id || m.meetingId === meetingId)
            ? { ...m, roomName, roomColor, isMock: data.isMock || false }
            : m
        );
      }
      return [...prev, {
        id,
        meetingId,
        roomName,
        roomColor,
        status: 'connecting',
        isMock: data.isMock || false,
      }];
    });

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
