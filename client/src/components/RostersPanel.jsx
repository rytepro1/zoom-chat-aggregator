import React, { useState } from 'react';
import { useRosters } from '../contexts/RostersContext';

const ROOM_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e',
];

const BOT_NAME_STORAGE_KEY = 'zoomchat.lastBotName';

function emptyEntry() {
  let lastBotName = '';
  try { lastBotName = localStorage.getItem(BOT_NAME_STORAGE_KEY) || ''; } catch {}
  return {
    meeting_id: '',
    passcode: '',
    room_name: '',
    room_color: ROOM_COLORS[0],
    bot_name: lastBotName,
  };
}

/**
 * Pre-build a list of meetings and deploy them all at once. Replaces
 * the "connect each meeting one-by-one" workflow for events with
 * predetermined meeting IDs (which is most professional events).
 *
 * UX shape:
 *   * List of saved rosters at top, each with a Deploy / Edit / Delete row.
 *   * "+ New Roster" button below opens the editor inline at the bottom.
 *   * Editor has name + N entry rows, each row is the same fields as
 *     the single-meeting Connect form.
 *   * Deploy shows per-room success/failure after running.
 */
function RostersPanel() {
  const { rosters, loading, refresh, fetchOne, createRoster, updateRoster, deleteRoster, deployRoster } = useRosters();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [draftEntries, setDraftEntries] = useState([emptyEntry()]);
  // datetime-local input value (local time, no timezone). Empty = adhoc.
  const [draftScheduled, setDraftScheduled] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deployingId, setDeployingId] = useState(null);
  const [deployResult, setDeployResult] = useState(null); // { rosterId, total, succeeded, failed, results }

  const openNew = () => {
    setEditingId(null);
    setDraftName('');
    setDraftEntries([emptyEntry()]);
    setDraftScheduled('');
    setError('');
    setEditorOpen(true);
  };

  const openEdit = async (rosterId) => {
    setError('');
    try {
      const full = await fetchOne(rosterId);
      setEditingId(rosterId);
      setDraftName(full.name);
      setDraftEntries(full.entries.length ? full.entries : [emptyEntry()]);
      setDraftScheduled(toDatetimeLocal(full.scheduled_for));
      setEditorOpen(true);
    } catch (err) {
      setError(err.message);
    }
  };

  const cancelEdit = () => {
    setEditorOpen(false);
    setEditingId(null);
    setDraftName('');
    setDraftEntries([emptyEntry()]);
    setDraftScheduled('');
    setError('');
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const scheduledIso = draftScheduled ? new Date(draftScheduled).toISOString() : null;
      if (editingId) {
        await updateRoster(editingId, { name: draftName, entries: draftEntries, scheduledFor: scheduledIso });
      } else {
        await createRoster({ name: draftName, entries: draftEntries, scheduledFor: scheduledIso });
      }
      cancelEdit();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Compute the schedule-hint for the editor: ok if >10 min ahead, warning otherwise.
  const draftScheduleHint = (() => {
    if (!draftScheduled) return null;
    const t = new Date(draftScheduled).getTime();
    if (isNaN(t)) return null;
    const leadMin = (t - Date.now()) / 60000;
    if (leadMin > 10) {
      return { ok: true, text: `All bots scheduled — they'll join at ${new Date(draftScheduled).toLocaleString()}` };
    }
    return { ok: false, text: 'Less than 10 min away — bots will dispatch immediately (adhoc, risks 507s). Set >10 min ahead to use scheduled bots.' };
  })();

  const handleDeploy = async (rosterId) => {
    setDeployingId(rosterId);
    setDeployResult(null);
    try {
      const result = await deployRoster(rosterId);
      setDeployResult({ rosterId, ...result });
    } catch (err) {
      setDeployResult({ rosterId, error: err.message });
    } finally {
      setDeployingId(null);
    }
  };

  const handleDelete = async (rosterId, name) => {
    if (!window.confirm(`Delete roster "${name}"? This can't be undone.`)) return;
    try {
      await deleteRoster(rosterId);
    } catch (err) {
      setError(err.message);
    }
  };

  const updateEntry = (idx, patch) => {
    setDraftEntries(prev => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };

  const addEntry = () => setDraftEntries(prev => [...prev, emptyEntry()]);
  const removeEntry = (idx) => setDraftEntries(prev => prev.filter((_, i) => i !== idx));

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--accent-color)' }}>
          Rosters
        </h2>
        {!editorOpen && (
          <button
            onClick={openNew}
            className="text-xs font-medium py-1.5 px-3 rounded-lg hover:opacity-90"
            style={{ backgroundColor: 'var(--accent-color)', color: 'white' }}
          >
            + New Roster
          </button>
        )}
      </div>

      {error && (
        <div className="text-red-400 text-sm py-2 px-3 bg-red-500/10 rounded-lg mb-3">
          {error}
        </div>
      )}

      {/* Saved roster list */}
      {!editorOpen && (
        <>
          {loading ? (
            <p className="text-sm opacity-50 italic">Loading…</p>
          ) : rosters.length === 0 ? (
            <p className="text-sm opacity-50 italic">
              No saved rosters yet. Click <strong>New Roster</strong> to pre-build a list of
              meetings you can deploy in one click — great for recurring shows
              or as a quick-recovery shortcut if you quit the app mid-event.
            </p>
          ) : (
            <div className="space-y-2">
              {rosters.map((r) => (
                <RosterRow
                  key={r.id}
                  roster={r}
                  deploying={deployingId === r.id}
                  result={deployResult?.rosterId === r.id ? deployResult : null}
                  onDeploy={() => handleDeploy(r.id)}
                  onEdit={() => openEdit(r.id)}
                  onDelete={() => handleDelete(r.id, r.name)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Editor */}
      {editorOpen && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-color)' }}>
            {editingId ? 'Edit Roster' : 'New Roster'}
          </h3>

          <div>
            <label className="block text-sm mb-1 opacity-70">Roster Name *</label>
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="e.g. Acme Q3 Kickoff, Weekly All-Hands"
              className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none"
              style={{ color: 'var(--text-color)' }}
            />
          </div>

          <div>
            <label className="block text-sm mb-1 opacity-70">
              Show start time <span className="opacity-60">(optional)</span>
            </label>
            <input
              type="datetime-local"
              value={draftScheduled}
              onChange={(e) => setDraftScheduled(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none"
              style={{ color: 'var(--text-color)', colorScheme: 'dark' }}
            />
            {draftScheduleHint ? (
              <p className={`text-xs mt-1 ${draftScheduleHint.ok ? 'text-green-400' : 'text-amber-400'}`}>
                {draftScheduleHint.text}
              </p>
            ) : (
              <p className="text-xs opacity-50 mt-1">
                When set + &gt;10 min away, deploys schedule a dedicated bot for each meeting (no 507 errors). Leave blank for adhoc.
              </p>
            )}
          </div>

          <div className="space-y-3">
            {draftEntries.map((entry, idx) => (
              <EntryEditor
                key={idx}
                index={idx}
                entry={entry}
                canRemove={draftEntries.length > 1}
                onChange={(patch) => updateEntry(idx, patch)}
                onRemove={() => removeEntry(idx)}
              />
            ))}
          </div>

          <button
            onClick={addEntry}
            className="w-full py-2 rounded-lg border border-dashed border-white/20 text-sm hover:bg-white/5"
            style={{ color: 'var(--secondary-text-color)' }}
          >
            + Add Meeting
          </button>

          <div className="flex gap-2 justify-end pt-2 border-t border-white/10">
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="px-3 py-2 text-sm rounded bg-white/10 hover:bg-white/20 disabled:opacity-50"
              style={{ color: 'var(--text-color)' }}
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !draftName.trim()}
              className="px-3 py-2 text-sm font-medium rounded hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent-color)', color: 'white' }}
            >
              {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Roster'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RosterRow({ roster, deploying, result, onDeploy, onEdit, onDelete }) {
  const scheduled = roster.scheduled_for ? new Date(roster.scheduled_for) : null;
  const scheduledLabel = scheduled
    ? scheduled.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  return (
    <div className="p-3 rounded-lg bg-white/5 border border-white/10">
      <div className="flex items-center justify-between mb-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate" style={{ color: 'var(--text-color)' }}>
            {roster.name}
          </div>
          <div className="text-xs opacity-50">
            {roster.entry_count} {roster.entry_count === 1 ? 'meeting' : 'meetings'}
            {scheduledLabel && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 text-[10px]">
                ⏰ {scheduledLabel}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          <button
            onClick={onDeploy}
            disabled={deploying || roster.entry_count === 0}
            className="text-xs px-3 py-1.5 rounded font-medium hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: 'var(--accent-color)', color: 'white' }}
            title="Connect bots to every meeting in this roster"
          >
            {deploying ? '…' : 'Deploy'}
          </button>
          <button
            onClick={onEdit}
            className="text-xs px-2 py-1.5 rounded bg-white/10 hover:bg-white/20"
            style={{ color: 'var(--text-color)' }}
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="text-xs px-2 py-1.5 rounded text-red-400 hover:bg-red-500/20"
            title="Delete roster"
          >
            ✕
          </button>
        </div>
      </div>

      {result && (
        <div className="text-xs mt-2 px-2 py-1.5 rounded bg-white/5 border border-white/10">
          {result.error ? (
            <span className="text-red-400">Deploy failed: {result.error}</span>
          ) : (
            <>
              <div style={{ color: 'var(--text-color)' }}>
                Deployed {result.succeeded} of {result.total} rooms
                {result.failed > 0 ? `, ${result.failed} failed` : ''}.
              </div>
              {result.failed > 0 && (
                <ul className="mt-1 opacity-70 list-disc list-inside space-y-0.5">
                  {result.results.filter(r => !r.ok).map(r => (
                    <li key={r.meetingId}>{r.roomName}: {r.error}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EntryEditor({ index, entry, canRemove, onChange, onRemove }) {
  return (
    <div className="p-3 rounded-lg bg-white/5 border border-white/10 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide opacity-50">
          Meeting {index + 1}
        </span>
        {canRemove && (
          <button
            onClick={onRemove}
            className="text-xs text-red-400 hover:bg-red-500/20 rounded px-1.5 py-0.5"
            title="Remove this meeting from the roster"
          >
            Remove
          </button>
        )}
      </div>

      <input
        type="text"
        value={entry.meeting_id}
        onChange={(e) => onChange({ meeting_id: e.target.value })}
        placeholder="Meeting ID (e.g. 123 456 7890)"
        className="w-full px-2 py-1.5 text-sm rounded bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none"
        style={{ color: 'var(--text-color)' }}
      />
      <input
        type="text"
        value={entry.passcode || ''}
        onChange={(e) => onChange({ passcode: e.target.value })}
        placeholder="Passcode (optional)"
        className="w-full px-2 py-1.5 text-sm rounded bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none"
        style={{ color: 'var(--text-color)' }}
      />
      <input
        type="text"
        value={entry.meeting_url || ''}
        onChange={(e) => onChange({ meeting_url: e.target.value })}
        placeholder="Registration URL (only if Zoom registration required)"
        className="w-full px-2 py-1.5 text-xs rounded bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none font-mono"
        style={{ color: 'var(--text-color)' }}
        title="For meetings that require registration: paste the unique join URL Zoom emails after registering the bot as an attendee (contains ?tk=...)"
      />
      <input
        type="text"
        value={entry.room_name}
        onChange={(e) => onChange({ room_name: e.target.value })}
        placeholder="Room display name (e.g. Main Stage)"
        className="w-full px-2 py-1.5 text-sm rounded bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none"
        style={{ color: 'var(--text-color)' }}
      />
      <input
        type="text"
        value={entry.bot_name}
        onChange={(e) => onChange({ bot_name: e.target.value })}
        placeholder="Bot display name (e.g. Audience Q&A)"
        className="w-full px-2 py-1.5 text-sm rounded bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none"
        style={{ color: 'var(--text-color)' }}
      />

      <div>
        <label className="block text-xs opacity-50 mb-1">Badge Color</label>
        <div className="flex flex-wrap gap-1.5">
          {ROOM_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => onChange({ room_color: color })}
              className={`w-5 h-5 rounded-full transition-all ${
                entry.room_color === color
                  ? 'ring-2 ring-white ring-offset-1 ring-offset-gray-800 scale-110'
                  : 'hover:scale-110'
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Convert a server timestamp (ISO string) → datetime-local input value.
 * datetime-local wants "YYYY-MM-DDTHH:MM" in *local* time, no timezone.
 */
function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' +
    pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes())
  );
}

export default RostersPanel;
