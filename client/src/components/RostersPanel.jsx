import React, { useState, useEffect } from 'react';
import { useRosters } from '../contexts/RostersContext';
import { useMeetings } from '../contexts/MeetingsContext';

const API_URL = import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin;

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
    panelist_email: '',
    register_panelist: false,
  };
}

// Mirror of the server's panelistSlug/panelistToken/derivePanelistAlias
// (src/server/index.js) so the editor preview matches exactly what gets
// registered. Keep these in sync with the server.
function pSlug(s, max = 16) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, max);
}
function pToken(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).slice(0, 4).padStart(4, '0');
}

/**
 * Preview the auto-derived panelist alias for a room: base + org + room
 * + webinar-id token → "zoomchat+ugenticai-zoom5-7f3a@ryteproductions.com".
 * Returns null if base is missing/invalid.
 */
function aliasPreview(base, orgSlug, roomName, meetingId) {
  const at = String(base || '').indexOf('@');
  if (at <= 0) return null;
  const local = base.slice(0, at);
  const domain = base.slice(at + 1);
  if (!domain.includes('.')) return null;
  const room = pSlug(roomName) || pSlug(meetingId) || 'room';
  const suffix = [orgSlug, room, pToken(meetingId)].filter(Boolean).join('-');
  return `${local}+${suffix}@${domain}`.toLowerCase();
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
  // Org's base panelist email (Settings → Zoom Integration), used to
  // preview the auto-derived alias in the entry editor.
  const [panelistEmailBase, setPanelistEmailBase] = useState('');
  const [orgSlug, setOrgSlug] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/api/zoom/credentials`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setPanelistEmailBase(d.effectiveEmailBase || d.panelistEmailBase || '');
        setOrgSlug(d.orgSlug || '');
      })
      .catch(() => {});
  }, []);

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
                  fetchOne={fetchOne}
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
                panelistEmailBase={panelistEmailBase}
                orgSlug={orgSlug}
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

function RosterRow({ roster, deploying, result, onDeploy, onEdit, onDelete, fetchOne }) {
  const { registerPanelists } = useRosters();
  const [registering, setRegistering] = useState(false);
  const [registerResult, setRegisterResult] = useState(null);

  const handleRegister = async () => {
    setRegistering(true);
    setRegisterResult(null);
    try {
      setRegisterResult(await registerPanelists(roster.id));
    } catch (err) {
      setRegisterResult({ error: err.message });
    } finally {
      setRegistering(false);
    }
  };

  const scheduled = roster.scheduled_for ? new Date(roster.scheduled_for) : null;
  const scheduledLabel = scheduled
    ? scheduled.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  // Entries are lazy-loaded on first expand. List endpoint only returns
  // roster metadata so we save the round-trip for collapsed rows.
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState(null);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [entriesError, setEntriesError] = useState(null);

  const toggleExpanded = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (entries) return; // already loaded
    setLoadingEntries(true);
    setEntriesError(null);
    try {
      const full = await fetchOne(roster.id);
      setEntries(full?.entries || []);
    } catch (err) {
      setEntriesError(err.message);
    } finally {
      setLoadingEntries(false);
    }
  };

  return (
    <div className="p-3 rounded-lg bg-white/5 border border-white/10">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={toggleExpanded}
          className="min-w-0 flex-1 text-left"
          title={expanded ? 'Hide meetings' : 'Show meetings'}
        >
          <div className="font-medium truncate flex items-center gap-1.5" style={{ color: 'var(--text-color)' }}>
            <span className="text-xs opacity-60">{expanded ? '▾' : '▸'}</span>
            {roster.name}
          </div>
          <div className="text-xs opacity-50 ml-4">
            {roster.entry_count} {roster.entry_count === 1 ? 'meeting' : 'meetings'}
            {scheduledLabel && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 text-[10px]">
                ⏰ {scheduledLabel}
              </span>
            )}
          </div>
        </button>
        <div className="flex gap-1.5 flex-shrink-0">
          <button
            onClick={handleRegister}
            disabled={registering || roster.entry_count === 0}
            className="text-xs px-2 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50"
            style={{ color: 'var(--text-color)' }}
            title="Register bot emails as Zoom webinar panelists and capture their join URLs (webinar entries only)"
          >
            {registering ? '…' : 'Register'}
          </button>
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

      {/* Expanded: per-entry list with per-entry Relaunch buttons.
          Lets the operator re-dispatch a single bot (e.g., one that
          dropped mid-event) without redeploying the whole roster. */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-white/10">
          {loadingEntries && <div className="text-xs opacity-50">Loading meetings…</div>}
          {entriesError && <div className="text-xs text-red-400">{entriesError}</div>}
          {entries && entries.length === 0 && (
            <div className="text-xs opacity-50 italic">No meetings in this roster yet — use Edit to add some.</div>
          )}
          {entries && entries.length > 0 && (
            <div className="space-y-1.5">
              {entries.map((entry) => (
                <EntryRelaunchRow
                  key={entry.id}
                  entry={entry}
                  scheduledFor={roster.scheduled_for}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {registerResult && (
        <div className="text-xs mt-2 px-2 py-1.5 rounded bg-white/5 border border-white/10">
          {registerResult.error ? (
            <span className="text-red-400">Register failed: {registerResult.error}</span>
          ) : (
            <>
              <div style={{ color: 'var(--text-color)' }}>
                Registered {registerResult.registered} of {registerResult.total} panelist(s)
                {registerResult.failed > 0 ? `, ${registerResult.failed} failed` : ''}
                {registerResult.skipped > 0 ? ` · ${registerResult.skipped} skipped (no email)` : ''}.
              </div>
              {registerResult.failed > 0 && (
                <ul className="mt-1 opacity-70 list-disc list-inside space-y-0.5">
                  {registerResult.results.filter(r => !r.ok).map(r => (
                    <li key={r.meetingId}>{r.roomName}: {r.error}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

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

/**
 * Single-row per-entry dispatcher inside an expanded roster row.
 * Calls the same /api/meetings/connect endpoint Deploy uses, just
 * with one entry. Operator hits this when a single bot drops and
 * they want to re-add only that meeting (vs redeploying the whole
 * roster which would no-op on still-connected meetings via dedup).
 */
function EntryRelaunchRow({ entry, scheduledFor }) {
  const { connectToMeeting, meetings } = useMeetings();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null); // 'ok' | 'err'
  const [error, setError] = useState('');

  // Is this entry already connected? (Quick lookup against live meetings.)
  const live = meetings.find(m => m.meetingId === entry.meeting_id || m.id === entry.meeting_id);

  const relaunch = async () => {
    setBusy(true);
    setStatus(null);
    setError('');
    try {
      await connectToMeeting({
        meetingId: entry.meeting_id,
        passcode: entry.passcode || '',
        roomName: entry.room_name,
        roomColor: entry.room_color,
        botName: entry.bot_name,
        scheduledFor: scheduledFor || null,
        meetingUrl: entry.meeting_url || null,
      });
      setStatus('ok');
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus('err');
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 p-2 rounded bg-white/5 border border-white/10">
      <span
        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: entry.room_color || '#ef4444' }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate" style={{ color: 'var(--text-color)' }}>
          {entry.room_name}
        </div>
        <div className="text-[10px] opacity-50 truncate">
          {entry.meeting_id} · {entry.bot_name}
          {entry.meeting_url && <span className="ml-1 text-amber-400">· registered</span>}
        </div>
        {status === 'err' && (
          <div className="text-[10px] text-red-400 mt-0.5 truncate" title={error}>
            {error}
          </div>
        )}
        {status === 'ok' && (
          <div className="text-[10px] text-green-400 mt-0.5">
            Dispatched ✓
          </div>
        )}
      </div>
      {live ? (
        <span className="text-[10px] px-2 py-0.5 rounded bg-green-500/20 text-green-400 flex-shrink-0">
          live
        </span>
      ) : (
        <button
          onClick={relaunch}
          disabled={busy}
          className="text-xs px-2.5 py-1 rounded font-medium hover:opacity-90 disabled:opacity-50 flex-shrink-0"
          style={{ backgroundColor: 'var(--accent-color)', color: 'white' }}
          title="Re-dispatch this bot only"
        >
          {busy ? '…' : 'Relaunch'}
        </button>
      )}
    </div>
  );
}

function EntryEditor({ index, entry, canRemove, panelistEmailBase, orgSlug, onChange, onRemove }) {
  const explicit = (entry.panelist_email || '').trim();
  const preview = aliasPreview(panelistEmailBase, orgSlug, entry.room_name, entry.meeting_id);
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
        title="For meetings that require registration: paste the unique join URL Zoom emails after registering the bot as an attendee (contains ?tk=...). Auto-filled when you use Register panelists."
      />
      <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-color)' }}>
        <input
          type="checkbox"
          checked={!!entry.register_panelist}
          onChange={(e) => onChange({ register_panelist: e.target.checked })}
        />
        Webinar — auto-register bot as panelist
      </label>
      {entry.register_panelist && (
        <div className="pl-5 space-y-1">
          <input
            type="email"
            value={entry.panelist_email || ''}
            onChange={(e) => onChange({ panelist_email: e.target.value })}
            placeholder={preview ? `auto: ${preview}` : 'panelist email (or set a base in Settings)'}
            className="w-full px-2 py-1.5 text-xs rounded bg-white/10 border border-white/20 focus:border-white/40 focus:outline-none"
            style={{ color: 'var(--text-color)' }}
            title="Leave blank to auto-derive an alias from your Settings base email. Fill in to override with a specific address."
          />
          <p className="text-[10px] opacity-60">
            {explicit
              ? `Will register: ${explicit}`
              : preview
                ? `Will auto-register: ${preview}`
                : 'Set a base email in Settings → Zoom Integration, or type one here.'}
          </p>
        </div>
      )}
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
