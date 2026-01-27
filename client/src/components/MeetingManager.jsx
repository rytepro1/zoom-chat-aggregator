import React, { useState } from 'react';
import { useMeetings } from '../contexts/MeetingsContext';

function MeetingManager() {
  const [meetingId, setMeetingId] = useState('');
  const [passcode, setPasscode] = useState('');
  const [roomName, setRoomName] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState('');

  const { meetings, connectToMeeting, disconnectFromMeeting } = useMeetings();

  const handleConnect = async (e) => {
    e.preventDefault();
    setError('');

    if (!meetingId.trim()) {
      setError('Meeting ID is required');
      return;
    }

    setIsConnecting(true);

    try {
      await connectToMeeting({
        meetingId: meetingId.trim().replace(/\s/g, ''),
        passcode: passcode.trim(),
        roomName: roomName.trim() || `Meeting ${meetingId}`
      });

      // Clear form on success
      setMeetingId('');
      setPasscode('');
      setRoomName('');
    } catch (err) {
      setError(err.message || 'Failed to connect to meeting');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async (id) => {
    try {
      await disconnectFromMeeting(id);
    } catch (err) {
      setError(err.message || 'Failed to disconnect from meeting');
    }
  };

  return (
    <div className="p-4">
      <h2
        className="text-lg font-semibold mb-4"
        style={{ color: 'var(--accent-color)' }}
      >
        Connect to Meetings
      </h2>

      {/* Connection Form */}
      <form onSubmit={handleConnect} className="space-y-3 mb-6">
        <div>
          <label className="block text-sm mb-1 opacity-70">
            Meeting ID *
          </label>
          <input
            type="text"
            value={meetingId}
            onChange={(e) => setMeetingId(e.target.value)}
            placeholder="123 456 7890"
            className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none transition-colors"
            style={{ color: 'var(--text-color)' }}
          />
        </div>

        <div>
          <label className="block text-sm mb-1 opacity-70">
            Passcode (if required)
          </label>
          <input
            type="text"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="Optional"
            className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none transition-colors"
            style={{ color: 'var(--text-color)' }}
          />
        </div>

        <div>
          <label className="block text-sm mb-1 opacity-70">
            Display Name
          </label>
          <input
            type="text"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder="e.g., Main Stage, Breakout Room 1"
            className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none transition-colors"
            style={{ color: 'var(--text-color)' }}
          />
        </div>

        {error && (
          <div className="text-red-400 text-sm py-2 px-3 bg-red-500/10 rounded-lg">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={isConnecting}
          className="w-full py-2 px-4 rounded-lg font-medium transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: 'var(--accent-color)', color: 'white' }}
        >
          {isConnecting ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Connecting...
            </span>
          ) : (
            'Connect to Meeting'
          )}
        </button>
      </form>

      {/* Connected Meetings List */}
      <div>
        <h3 className="text-sm font-medium mb-2 opacity-70">
          Connected Meetings ({meetings.length})
        </h3>

        {meetings.length === 0 ? (
          <p className="text-sm opacity-50 italic">
            No meetings connected. Enter a Meeting ID above to start receiving chat messages.
          </p>
        ) : (
          <div className="space-y-2">
            {meetings.map((meeting) => (
              <div
                key={meeting.id}
                className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/10"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {meeting.roomName}
                  </div>
                  <div className="text-xs opacity-50">
                    ID: {meeting.meetingId}
                    {meeting.isMock && (
                      <span className="ml-2 px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded text-[10px]">
                        MOCK
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-xs">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        meeting.status === 'connected'
                          ? 'bg-green-400'
                          : meeting.status === 'connecting'
                          ? 'bg-yellow-400 animate-pulse'
                          : 'bg-red-400'
                      }`}
                    />
                    {meeting.status}
                  </span>
                  <button
                    onClick={() => handleDisconnect(meeting.id)}
                    className="p-1.5 rounded hover:bg-white/10 transition-colors text-red-400"
                    title="Disconnect"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info Box */}
      <div className="mt-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-sm">
        <div className="flex gap-2">
          <svg
            className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div className="opacity-80">
            <p className="font-medium text-blue-400">How it works:</p>
            <p className="mt-1">
              Enter the Zoom Meeting ID from your meeting URL or invite.
              Once connected, chat messages from that meeting will appear
              in the main feed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MeetingManager;
