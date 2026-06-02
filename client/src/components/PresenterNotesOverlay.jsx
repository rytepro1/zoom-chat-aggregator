import React from 'react';
import { usePresenterNotes } from '../contexts/PresenterNotesContext';

/**
 * Renders active presenter notes at the top of the DisplayView,
 * above the featured chat message. Stack newest-first, up to 3
 * visible. Distinct amber styling so the on-air presenter never
 * confuses a production note with an audience chat.
 *
 * Returns null when there are no active notes — DisplayView's
 * layout still works (the featured chat slides up to fill the gap).
 */
export default function PresenterNotesOverlay() {
  const { notes } = usePresenterNotes();
  if (notes.length === 0) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] p-4 pointer-events-none">
      <div className="max-w-5xl mx-auto flex flex-col gap-2 pointer-events-auto">
        {notes.slice(0, 3).map((note, idx) => (
          <div
            key={note.id}
            className="p-4 rounded-xl shadow-2xl border-2"
            style={{
              backgroundColor: 'rgba(120, 53, 15, 0.97)',     // dark amber bg
              borderColor: '#fcd34d',
              boxShadow: '0 20px 40px -10px rgba(252, 211, 77, 0.5)',
              opacity: idx === 0 ? 1 : 0.85 - idx * 0.15,    // fade older notes
            }}
          >
            <div className="flex items-baseline gap-3 mb-1">
              <span className="text-xs font-bold tracking-widest text-amber-200">
                ⚡ FROM PRODUCTION
              </span>
              <span className="text-xs text-amber-300/80">
                {note.senderDisplay}
              </span>
              <span className="text-xs text-amber-300/50">
                · {formatTime(note.sentAt)}
              </span>
            </div>
            <div
              className="text-2xl font-semibold leading-snug break-words"
              style={{ color: '#fffbeb' }}
            >
              {note.body}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Approximate height of the notes overlay so DisplayView can push
 * the featured message + chat feed down without overlapping. Returns
 * 0 when no notes are visible.
 */
export function getPresenterNotesHeight(notesCount) {
  if (notesCount === 0) return 0;
  const visible = Math.min(notesCount, 3);
  // ~100px per note (heading + 2-line body + padding) + 16px gap + 16px outer padding × 2
  return visible * 100 + (visible - 1) * 8 + 32;
}
