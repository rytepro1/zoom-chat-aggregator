import React, { forwardRef } from 'react';

/**
 * Branded 1080x1080 PNG-ready quote card used by SavedPanel's "Export
 * PNG" action. Rendered into a hidden DOM slot, snapshotted with
 * html-to-image, and downloaded by the operator for social/marketing use.
 *
 * Font sizes adapt to quote length so a 12-character zinger and a
 * 400-character anecdote both look intentional.
 *
 * Styling is fully inline (no Tailwind / CSS variables) so the
 * rendered output is self-contained — html-to-image doesn't always
 * resolve external CSS reliably.
 */
const QuoteCard = forwardRef(({ message }, ref) => {
  const content = message.content || '';
  const sender = message.sender || 'Unknown';
  // Room color stays as a visual cue (left edge + quote mark) even
  // though the room *name* is no longer printed on the card.
  const accent = message.roomColor || '#3b82f6';

  // Adaptive quote font size by content length. Tuned for ~1080px width
  // with ~80px side padding (effective text width ~920px).
  const fontSize = (() => {
    const len = content.length;
    if (len <= 60)  return 88;
    if (len <= 140) return 64;
    if (len <= 240) return 48;
    if (len <= 400) return 36;
    return 30;
  })();

  return (
    <div
      ref={ref}
      style={{
        width: 1080,
        height: 1080,
        backgroundColor: '#0f0f23',
        color: '#ffffff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
        padding: '90px 90px 80px 90px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        position: 'relative',
        borderLeft: `14px solid ${accent}`,
        overflow: 'hidden',
      }}
    >
      {/* Big opening quote mark */}
      <div
        style={{
          fontSize: 220,
          lineHeight: 0.8,
          color: accent,
          opacity: 0.45,
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontWeight: 700,
          marginBottom: 24,
          marginLeft: -10,
        }}
      >
        “
      </div>

      {/* Quote text */}
      <div
        style={{
          fontSize,
          fontWeight: 500,
          lineHeight: 1.3,
          marginBottom: 56,
          color: '#ffffff',
        }}
      >
        {content}
      </div>

      {/* Attribution — sender only. Room pill and brand footer were
          removed per operator request; we can wire them back as
          opt-in settings if customers ask. */}
      <div
        style={{
          borderTop: '1px solid rgba(255,255,255,0.18)',
          paddingTop: 28,
        }}
      >
        <div style={{ fontSize: 36, fontWeight: 700, color: '#ffffff' }}>
          {sender}
        </div>
      </div>
    </div>
  );
});

QuoteCard.displayName = 'QuoteCard';

export default QuoteCard;
