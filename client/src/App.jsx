import React, { useState } from 'react';
import { useSocketContext } from './contexts/SocketContext';
import { useSettings } from './contexts/SettingsContext';
import ChatFeed from './components/ChatFeed';
import StatusBar from './components/StatusBar';
import RoomFilter from './components/RoomFilter';
import SettingsPanel from './components/SettingsPanel';
import MeetingManager from './components/MeetingManager';

function App() {
  const {
    messages,
    rooms,
    stats,
    connected,
    selectedRoom,
    setSelectedRoom
  } = useSocketContext();

  const [showMeetingPanel, setShowMeetingPanel] = useState(true);

  const { settings, setSettingsPanelOpen } = useSettings();

  return (
    <div
      className="h-screen flex flex-col overflow-hidden transition-colors duration-300"
      style={{
        backgroundColor: 'var(--bg-color)',
        color: 'var(--text-color)',
        fontFamily: 'var(--font-family)',
        fontSize: 'var(--base-font-size)',
      }}
    >
      {/* Header */}
      {settings.headerVisible && (
        <header
          className="border-b border-white/10 px-6 py-4 transition-colors duration-300"
          style={{ backgroundColor: 'var(--header-color)' }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {settings.logoUrl && (
                <img
                  src={settings.logoUrl}
                  alt="Logo"
                  className="h-10 w-auto"
                />
              )}
              <div>
                <h1
                  className="text-2xl font-bold"
                  style={{ color: 'var(--accent-color)' }}
                >
                  {settings.appTitle}
                </h1>
                <p
                  className="text-sm mt-1"
                  style={{ color: 'var(--secondary-text-color)' }}
                >
                  {settings.appSubtitle}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <StatusBar connected={connected} stats={stats} />
              <button
                onClick={() => setSettingsPanelOpen(true)}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                title="Settings"
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </button>
            </div>
          </div>
        </header>
      )}

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Sidebar - Meeting Manager & Room Filter */}
        {settings.sidebarVisible && (
          <aside
            className="w-80 border-r border-white/10 overflow-y-auto transition-colors duration-300 flex flex-col"
            style={{ backgroundColor: 'var(--header-color)' }}
          >
            {/* Tab Buttons */}
            <div className="flex border-b border-white/10">
              <button
                onClick={() => setShowMeetingPanel(true)}
                className={`flex-1 py-3 px-4 text-sm font-medium transition-colors ${
                  showMeetingPanel
                    ? 'border-b-2 opacity-100'
                    : 'opacity-60 hover:opacity-80'
                }`}
                style={{
                  borderColor: showMeetingPanel ? 'var(--accent-color)' : 'transparent',
                  color: showMeetingPanel ? 'var(--accent-color)' : 'inherit'
                }}
              >
                Connect
              </button>
              <button
                onClick={() => setShowMeetingPanel(false)}
                className={`flex-1 py-3 px-4 text-sm font-medium transition-colors ${
                  !showMeetingPanel
                    ? 'border-b-2 opacity-100'
                    : 'opacity-60 hover:opacity-80'
                }`}
                style={{
                  borderColor: !showMeetingPanel ? 'var(--accent-color)' : 'transparent',
                  color: !showMeetingPanel ? 'var(--accent-color)' : 'inherit'
                }}
              >
                Rooms ({rooms.length})
              </button>
            </div>

            {/* Panel Content */}
            <div className="flex-1 overflow-y-auto">
              {showMeetingPanel ? (
                <MeetingManager />
              ) : (
                <div className="p-4">
                  <RoomFilter
                    rooms={rooms}
                    selectedRoom={selectedRoom}
                    onSelectRoom={setSelectedRoom}
                  />
                </div>
              )}
            </div>
          </aside>
        )}

        {/* Chat Feed */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          <ChatFeed
            messages={messages}
            selectedRoom={selectedRoom}
          />

          {/* Floating settings button when header is hidden */}
          {!settings.headerVisible && (
            <button
              onClick={() => setSettingsPanelOpen(true)}
              className="absolute top-4 right-4 p-3 rounded-full shadow-lg hover:scale-110 transition-transform"
              style={{ backgroundColor: 'var(--accent-color)' }}
              title="Settings"
            >
              <svg
                className="w-5 h-5 text-white"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </button>
          )}
        </div>
      </main>

      {/* Settings Panel */}
      <SettingsPanel />
    </div>
  );
}

export default App;
