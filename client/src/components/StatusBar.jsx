import React from 'react';

function StatusBar({ connected, stats }) {
  return (
    <div className="flex items-center gap-4">
      {/* Connection status */}
      <div className="flex items-center gap-2">
        <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span
          className="text-sm"
          style={{ color: 'var(--secondary-text-color)' }}
        >
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {/* Stats */}
      <div
        className="flex items-center gap-4 text-sm"
        style={{ color: 'var(--secondary-text-color)' }}
      >
        <span>
          <strong style={{ color: 'var(--text-color)' }}>{stats.activeRooms || 0}</strong> rooms
        </span>
        <span>
          <strong style={{ color: 'var(--text-color)' }}>{stats.totalMessages || 0}</strong> messages
        </span>
      </div>
    </div>
  );
}

export default StatusBar;
