import React, { useState } from 'react';
import { useModeration } from '../contexts/ModerationContext';
import PresenterNoteComposer from './PresenterNoteComposer';

function ModerationPanel() {
  const {
    queue,
    featuredMessage,
    removeFromQueue,
    featureMessage,
    clearFeatured,
    featureNext,
    reorderQueue
  } = useModeration();

  // Collapsible footer sections — collapsed by default so the queue
  // stack (the thing you work during a show) gets the vertical space.
  const [noteOpen, setNoteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const moveUp = (index) => {
    if (index > 0) {
      reorderQueue(index, index - 1);
    }
  };

  const moveDown = (index) => {
    if (index < queue.length - 1) {
      reorderQueue(index, index + 1);
    }
  };

  return (
    <div className="p-4 h-full flex flex-col">
      <h2
        className="text-lg font-semibold mb-4"
        style={{ color: 'var(--accent-color)' }}
      >
        Moderation Queue
      </h2>

      {/* Currently Featured */}
      <div className="mb-3">
        <h3 className="text-sm font-medium mb-2 opacity-70 flex items-center gap-2">
          <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
          </svg>
          Now Featuring
        </h3>
        {featuredMessage ? (
          <div className="p-3 rounded-lg bg-green-500/20 border border-green-500/30">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-green-400 text-sm">
                  {featuredMessage.sender}
                </p>
                <p className="text-sm mt-1 break-words">
                  {featuredMessage.content}
                </p>
              </div>
              <button
                onClick={clearFeatured}
                className="p-1.5 rounded hover:bg-white/10 text-red-400 flex-shrink-0"
                title="Clear featured"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm opacity-50 italic p-3 bg-white/5 rounded-lg">
            No message featured. Click "Feature" on a queued item or select from the chat feed.
          </p>
        )}
      </div>

      {/* Queue Controls */}
      {queue.length > 0 && (
        <div className="mb-3">
          <button
            onClick={featureNext}
            className="w-full py-2 px-4 rounded-lg font-medium transition-all hover:opacity-90 flex items-center justify-center gap-2"
            style={{ backgroundColor: 'var(--accent-color)', color: 'white' }}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Feature Next in Queue
          </button>
        </div>
      )}

      {/* Queue List */}
      <div className="flex-1 overflow-y-auto">
        <h3 className="text-sm font-medium mb-2 opacity-70 flex items-center gap-2">
          <svg className="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z"/>
          </svg>
          Queue ({queue.length})
        </h3>

        {queue.length === 0 ? (
          <p className="text-sm opacity-50 italic">
            Click on messages in the chat feed to add them to the queue.
          </p>
        ) : (
          <div className="space-y-2">
            {queue.map((message, index) => (
              <div
                key={message.id}
                className="p-3 rounded-lg bg-white/5 border border-white/10 group"
              >
                <div className="flex items-start gap-2">
                  {/* Position number */}
                  <span className="w-6 h-6 rounded-full bg-blue-500/30 text-blue-400 flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {index + 1}
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{ backgroundColor: message.roomColor || '#ef4444', color: 'white' }}
                      >
                        {message.room}
                      </span>
                      <span className="text-xs opacity-50">
                        {message.sender}
                      </span>
                    </div>
                    <p className="text-sm mt-1 break-words line-clamp-2">
                      {message.content}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/10">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => moveUp(index)}
                      disabled={index === 0}
                      className="p-1 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move up"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                      </svg>
                    </button>
                    <button
                      onClick={() => moveDown(index)}
                      disabled={index === queue.length - 1}
                      className="p-1 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move down"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => featureMessage(message)}
                      className="px-2 py-1 rounded text-xs bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors"
                    >
                      Feature
                    </button>
                    <button
                      onClick={() => removeFromQueue(message.id)}
                      className="p-1 rounded hover:bg-white/10 text-red-400"
                      title="Remove"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Collapsible footer — kept out of the way so the queue stays
          visible. Note composer + help expand on demand. */}
      <div className="mt-3 pt-3 border-t border-white/10 space-y-2 flex-shrink-0">
        {/* Note to presenter */}
        <div>
          <button
            onClick={() => setNoteOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 transition-colors"
          >
            <span className="text-sm font-semibold text-amber-300 flex items-center gap-2">
              📺 Note to presenter
            </span>
            <span className="text-xs opacity-60 flex items-center gap-2">
              presenter pop-out only
              <span>{noteOpen ? '▾' : '▸'}</span>
            </span>
          </button>
          {noteOpen && (
            <div className="mt-2">
              <PresenterNoteComposer hideHeader />
            </div>
          )}
        </div>

        {/* How to moderate */}
        <div>
          <button
            onClick={() => setHelpOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 transition-colors"
          >
            <span className="text-sm font-medium text-blue-400 flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              How to moderate
            </span>
            <span className="text-xs opacity-60">{helpOpen ? '▾' : '▸'}</span>
          </button>
          {helpOpen && (
            <ul className="mt-2 px-3 space-y-1 text-xs opacity-80">
              <li>• Click any message to see moderation options</li>
              <li>• <span className="text-yellow-400">★</span> Highlight marks important messages</li>
              <li>• <span className="text-blue-400">☰</span> Queue adds to this list</li>
              <li>• <span className="text-green-400">✓</span> Feature shows on display</li>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default ModerationPanel;
