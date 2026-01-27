import React from 'react';
import { useSettings } from '../contexts/SettingsContext';

function RoomFilter({ rooms, selectedRoom, onSelectRoom }) {
  const { settings } = useSettings();

  return (
    <div>
      <h2
        className="text-lg font-semibold mb-4"
        style={{ color: 'var(--text-color)' }}
      >
        Rooms
      </h2>

      {/* All rooms option */}
      <button
        onClick={() => onSelectRoom(null)}
        className={`w-full text-left px-3 py-2 rounded-lg mb-2 transition-colors`}
        style={{
          backgroundColor: selectedRoom === null ? 'var(--accent-color)' : 'rgba(255,255,255,0.1)',
          color: 'var(--text-color)',
        }}
      >
        All Rooms
      </button>

      {/* Individual rooms */}
      {rooms.length === 0 ? (
        <p
          className="text-sm px-3"
          style={{ color: 'var(--secondary-text-color)' }}
        >
          No active rooms yet
        </p>
      ) : (
        <div className="space-y-1">
          {rooms.map((room) => (
            <button
              key={room.id}
              onClick={() => onSelectRoom(room.name)}
              className="w-full text-left px-3 py-2 rounded-lg transition-colors hover:bg-white/10"
              style={{
                backgroundColor: selectedRoom === room.name ? 'var(--accent-color)' : 'rgba(255,255,255,0.1)',
                color: 'var(--text-color)',
              }}
            >
              <div className="font-medium truncate">{room.name}</div>
              <div
                className="text-xs opacity-75"
                style={{ color: 'var(--secondary-text-color)' }}
              >
                {room.messageCount || 0} messages
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default RoomFilter;
