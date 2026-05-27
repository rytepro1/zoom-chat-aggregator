import React, { useState, useRef } from 'react';
import { toPng } from 'html-to-image';
import { useSaved } from '../contexts/SavedContext';
import QuoteCard from './QuoteCard';

const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001'
  : window.location.origin;

/**
 * Lists messages the operator has bookmarked during the current session
 * and exposes export actions (copy as text per-message, download all as
 * CSV). Reads from SavedContext, which is kept in sync via socket
 * events from the server.
 */
function SavedPanel() {
  const { savedMessages, unsaveMessage } = useSaved();
  const [copiedId, setCopiedId] = useState(null);
  // PNG export: render the QuoteCard into a hidden DOM slot for the
  // message we're currently exporting, capture it, throw it away.
  const [exportingMessage, setExportingMessage] = useState(null);
  const [pngBusyId, setPngBusyId] = useState(null);
  const cardRef = useRef(null);

  const copyAsText = (m) => {
    const text = `"${m.content}" — ${m.sender} (${m.room})${m.timestamp ? `, ${formatTime(m.timestamp)}` : ''}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(m.id);
      setTimeout(() => setCopiedId(prev => (prev === m.id ? null : prev)), 1500);
    });
  };

  const exportAsPng = async (m) => {
    setPngBusyId(m.id);
    setExportingMessage(m);
    // Two RAFs to make sure the card has rendered with its full styles
    // before we snapshot it (one tick to commit the React render, a
    // second to let the browser lay out the new DOM).
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      if (!cardRef.current) throw new Error('card ref missing');
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,           // crisp on retina; final PNG is 2160x2160
        cacheBust: true,
        backgroundColor: '#0f0f23',
      });
      const safeSender = (m.sender || 'quote').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 32);
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `zoomchat-${safeSender}-${m.id.slice(0, 8)}.png`;
      a.click();
    } catch (err) {
      console.error('PNG export failed:', err);
      alert('PNG export failed: ' + (err.message || 'unknown error'));
    } finally {
      setExportingMessage(null);
      setPngBusyId(null);
    }
  };

  const downloadCsv = () => {
    // Hit the server endpoint, which already formats the CSV consistently
    // with the rest of the API (single source of truth).
    window.location.href = `${API_URL}/api/saved/export.csv`;
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(savedMessages, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zoomchat-saved.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--accent-color)' }}>
          Saved Messages
        </h2>
        <span className="text-xs opacity-60">{savedMessages.length}</span>
      </div>

      {savedMessages.length === 0 ? (
        <p className="text-sm opacity-50 italic">
          Click the bookmark icon on a message in the main feed to save it here.
          Saved messages persist across sessions and can be exported.
        </p>
      ) : (
        <>
          {/* Bulk export bar */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={downloadCsv}
              className="flex-1 py-2 px-3 rounded text-sm font-medium transition-colors"
              style={{ backgroundColor: 'var(--accent-color)', color: 'white' }}
              title="Download all saved messages as CSV"
            >
              Export CSV
            </button>
            <button
              onClick={downloadJson}
              className="py-2 px-3 rounded text-sm transition-colors bg-white/10 hover:bg-white/20"
              style={{ color: 'var(--text-color)' }}
              title="Download all saved messages as JSON"
            >
              JSON
            </button>
          </div>

          {/* Message list */}
          <div className="space-y-2">
            {savedMessages.map((m) => (
              <div
                key={m.id}
                className="p-3 rounded-lg bg-white/5 border border-white/10"
                style={{ borderLeft: `4px solid ${m.roomColor || '#ef4444'}` }}
              >
                <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                  <span
                    className="text-xs px-1.5 py-0.5 rounded font-medium"
                    style={{ backgroundColor: m.roomColor || '#ef4444', color: 'white' }}
                  >
                    {m.room}
                  </span>
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-color)' }}>
                    {m.sender}
                  </span>
                  <span className="text-xs opacity-50">{formatTime(m.timestamp)}</span>
                </div>
                <p className="text-sm mb-2 break-words" style={{ color: 'var(--text-color)' }}>
                  {m.content}
                </p>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => copyAsText(m)}
                    className="flex-1 text-xs py-1.5 px-2 rounded transition-colors bg-white/10 hover:bg-white/20"
                    style={{ color: 'var(--text-color)' }}
                    title="Copy as plain text with attribution"
                  >
                    {copiedId === m.id ? 'Copied!' : 'Copy text'}
                  </button>
                  <button
                    onClick={() => exportAsPng(m)}
                    disabled={pngBusyId === m.id}
                    className="text-xs py-1.5 px-2 rounded transition-colors bg-white/10 hover:bg-white/20 disabled:opacity-50"
                    style={{ color: 'var(--text-color)' }}
                    title="Download as a 1080×1080 branded quote card (PNG)"
                  >
                    {pngBusyId === m.id ? '…' : 'PNG'}
                  </button>
                  <button
                    onClick={() => unsaveMessage(m.id).catch(console.error)}
                    className="text-xs py-1.5 px-2 rounded transition-colors text-red-400 hover:bg-red-500/20"
                    title="Remove from saved"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Off-screen render target for PNG export. Positioned far off the
          visible viewport with pointer-events disabled so it never
          interferes with the actual SavedPanel UI. html-to-image walks
          this DOM subtree to produce the downloadable PNG. */}
      {exportingMessage && (
        <div
          style={{
            position: 'fixed',
            left: -20000,
            top: 0,
            pointerEvents: 'none',
            zIndex: -1,
          }}
          aria-hidden="true"
        >
          <QuoteCard ref={cardRef} message={exportingMessage} />
        </div>
      )}
    </div>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export default SavedPanel;
