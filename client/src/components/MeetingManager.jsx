import React, { useState } from 'react';
import { useMeetings } from '../contexts/MeetingsContext';

// Preset color options for rooms
const ROOM_COLORS = [
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Lime', value: '#84cc16' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Cyan', value: '#06b6d4' },
  { name: 'Sky', value: '#0ea5e9' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Fuchsia', value: '#d946ef' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Rose', value: '#f43f5e' },
];

// Last-used bot name persists across sessions so operators don't
// re-type it every event. Stored under a stable localStorage key.
const BOT_NAME_STORAGE_KEY = 'zoomchat.lastBotName';

function MeetingManager() {
  const [meetingId, setMeetingId] = useState('');
  const [passcode, setPasscode] = useState('');
  const [roomName, setRoomName] = useState('');
  const [roomColor, setRoomColor] = useState(ROOM_COLORS[0].value);
  const [botName, setBotName] = useState(() => {
    try { return localStorage.getItem(BOT_NAME_STORAGE_KEY) || ''; } catch { return ''; }
  });
  // Optional show-start time. When set + >10 min away, the server tells
  // Recall to schedule the bot (dedicated instance, immune to 507s).
  // Stored as a datetime-local string (local time, no timezone) — the
  // browser converts to UTC ISO before sending. Empty = adhoc dispatch.
  const [scheduledFor, setScheduledFor] = useState('');
  // Optional pre-registered join URL for Zoom meetings that require
  // registration. Host registers the bot as an attendee, Zoom emails
  // back a URL with ?tk=<token>, operator pastes it here. When set,
  // the bot joins via that URL (passes Zoom's registration gate).
  const [meetingUrl, setMeetingUrl] = useState('');
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
    if (!botName.trim()) {
      setError('Bot Display Name is required — this is how the bot appears to meeting participants.');
      return;
    }

    setIsConnecting(true);

    try {
      // datetime-local is local time without timezone — JS Date converts
      // to UTC via toISOString(). Empty stays empty → server treats as
      // adhoc dispatch.
      const scheduledIso = scheduledFor ? new Date(scheduledFor).toISOString() : null;

      await connectToMeeting({
        meetingId: meetingId.trim().replace(/\s/g, ''),
        passcode: passcode.trim(),
        roomName: roomName.trim() || `Meeting ${meetingId}`,
        roomColor: roomColor,
        botName: botName.trim(),
        scheduledFor: scheduledIso,
        meetingUrl: meetingUrl.trim() || null,
      });

      // Remember this bot name for next session so the operator doesn't
      // have to retype it. Per-meeting changes still possible.
      try { localStorage.setItem(BOT_NAME_STORAGE_KEY, botName.trim()); } catch {}

      // Clear form on success and pick next color
      setMeetingId('');
      setPasscode('');
      setRoomName('');
      setScheduledFor('');
      setMeetingUrl('');
      // Rotate to next color for convenience
      const currentIndex = ROOM_COLORS.findIndex(c => c.value === roomColor);
      setRoomColor(ROOM_COLORS[(currentIndex + 1) % ROOM_COLORS.length].value);
    } catch (err) {
      setError(err.message || 'Failed to connect to meeting');
    } finally {
      setIsConnecting(false);
    }
  };

  // Quick read of whether the entered time will actually schedule
  // (>10 min in future) vs fall through to adhoc dispatch.
  const scheduleHint = (() => {
    if (!scheduledFor) return null;
    const t = new Date(scheduledFor).getTime();
    if (isNaN(t)) return null;
    const leadMin = (t - Date.now()) / 60000;
    if (leadMin > 10) {
      return { ok: true, text: `Bot scheduled — will join at ${new Date(scheduledFor).toLocaleString()}` };
    }
    return { ok: false, text: 'Less than 10 min away — will dispatch immediately (adhoc). Set a time >10 min ahead to use Recall\'s scheduled-bot pool.' };
  })();

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
            Registration URL <span className="opacity-60">(only for registration-required Zoom meetings)</span>
          </label>
          <input
            type="text"
            value={meetingUrl}
            onChange={(e) => setMeetingUrl(e.target.value)}
            placeholder="https://us02web.zoom.us/w/...?tk=...&pwd=..."
            className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none transition-colors text-xs"
            style={{ color: 'var(--text-color)' }}
          />
          <p className="text-xs opacity-50 mt-1">
            Host registers the bot as an attendee in Zoom → email contains a unique join URL → paste here. Bot joins via the registration-authenticated link instead of the public meeting URL.
          </p>
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

        <div>
          <label className="block text-sm mb-1 opacity-70">
            Bot Display Name *
          </label>
          <input
            type="text"
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
            placeholder="e.g., Audience Q&A, Producer Theo"
            className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none transition-colors"
            style={{ color: 'var(--text-color)' }}
          />
          <p className="text-xs opacity-50 mt-1">
            How the bot appears to meeting participants. Saved for next time.
          </p>
        </div>

        <div>
          <label className="block text-sm mb-1 opacity-70">
            Show start time <span className="opacity-60">(optional)</span>
          </label>
          <input
            type="datetime-local"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none transition-colors"
            style={{ color: 'var(--text-color)', colorScheme: 'dark' }}
          />
          {scheduleHint ? (
            <p className={`text-xs mt-1 ${scheduleHint.ok ? 'text-green-400' : 'text-amber-400'}`}>
              {scheduleHint.text}
            </p>
          ) : (
            <p className="text-xs opacity-50 mt-1">
              Set if your show starts &gt;10 min from now — Recall reserves a dedicated bot so you avoid &ldquo;adhoc pool depleted&rdquo; errors.
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm mb-1 opacity-70">
            Badge Color
          </label>
          <div className="flex flex-wrap gap-1.5">
            {ROOM_COLORS.map((color) => (
              <button
                key={color.value}
                type="button"
                onClick={() => setRoomColor(color.value)}
                className={`w-6 h-6 rounded-full transition-all ${
                  roomColor === color.value
                    ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-800 scale-110'
                    : 'hover:scale-110'
                }`}
                style={{ backgroundColor: color.value }}
                title={color.name}
              />
            ))}
          </div>
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
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: meeting.roomColor || '#ef4444' }}
                  />
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
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-xs">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        meeting.status === 'connected'
                          ? 'bg-green-400'
                          : meeting.status === 'scheduled'
                          ? 'bg-blue-400'
                          : meeting.status === 'connecting'
                          ? 'bg-yellow-400 animate-pulse'
                          : 'bg-red-400'
                      }`}
                      title={meeting.scheduledFor ? `Scheduled for ${new Date(meeting.scheduledFor).toLocaleString()}` : undefined}
                    />
                    {meeting.status === 'scheduled' && meeting.scheduledFor
                      ? `scheduled for ${new Date(meeting.scheduledFor).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                      : meeting.status}
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
