import React, { useState } from 'react';
import { useAI } from '../contexts/AIContext';

/**
 * AI Auto-Reply panel — the moderator surface for the Smart
 * Auto-Responder (docs/backend/ai.md). Sections:
 *   - Master toggle + reply mode + advanced tunables
 *   - Alerts (self-healing pauses needing review)
 *   - Needs your answer (detected recurring questions → supply an answer)
 *   - Active auto-replies (answer + counts + pause/edit/delete)
 *   - Paused
 *   - Pre-seed a FAQ before the show
 *   - Recent auto-reply activity
 */
export default function AIPanel() {
  const {
    settings, pendingFaqs, activeFaqs, pausedFaqs, alerts, activity,
    updateSettings, seedFaq, approveFaq, editFaq, pauseFaq, resumeFaq, dismissFaq, dismissAlert,
  } = useAI();

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [err, setErr] = useState(null);

  const run = (fn) => async (...args) => {
    setErr(null);
    try { await fn(...args); } catch (e) { setErr(e.message); }
  };

  return (
    <div className="p-4 h-full overflow-y-auto flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--accent-color)' }}>
          AI Auto-Reply
        </h2>
        <Pill on={settings.ai_enabled} />
      </div>

      {!settings.configured && (
        <Banner tone="warn">
          AI is not configured on the server (<code>ANTHROPIC_API_KEY</code> unset). Detection and
          auto-replies are inactive.
        </Banner>
      )}
      {err && <Banner tone="error">{err}</Banner>}

      {/* Master controls */}
      <div className="rounded-lg p-3 bg-white/5 flex flex-col gap-3">
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-sm font-medium">Auto-respond to recurring questions</span>
          <Switch
            checked={settings.ai_enabled}
            onChange={(v) => run(updateSettings)({ ai_enabled: v })}
          />
        </label>

        <p className="text-[11px] opacity-50">
          Approved answers are posted to the whole room (throttled so a popular question isn't
          answered repeatedly).
        </p>

        <button
          className="text-xs opacity-60 hover:opacity-100 text-left"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          {advancedOpen ? '▾' : '▸'} Advanced
        </button>
        {advancedOpen && (
          <div className="grid grid-cols-3 gap-2">
            <NumField
              label="Match conf." step="0.05" min="0" max="1"
              value={settings.ai_match_threshold}
              onCommit={(v) => run(updateSettings)({ ai_match_threshold: clamp(v, 0, 1) })}
            />
            <NumField
              label="Cooldown s" step="5" min="0"
              value={settings.ai_cooldown_seconds}
              onCommit={(v) => run(updateSettings)({ ai_cooldown_seconds: Math.max(0, Math.round(v)) })}
            />
            <NumField
              label="Ask after" step="1" min="2"
              value={settings.ai_recurring_threshold}
              onCommit={(v) => run(updateSettings)({ ai_recurring_threshold: Math.max(2, Math.round(v)) })}
            />
          </div>
        )}
      </div>

      {/* Self-healing alerts */}
      {alerts.length > 0 && (
        <Section title="⚠ Needs review">
          {alerts.map((a) => (
            <div key={a.key} className="rounded-lg p-3 bg-amber-500/15 border border-amber-500/30">
              <p className="text-sm font-medium text-amber-300">{a.faq?.question}</p>
              <p className="text-xs mt-1 opacity-80">{a.reason}</p>
              <p className="text-[11px] mt-1 opacity-50">Auto-reply paused.</p>
              <div className="flex gap-2 mt-2">
                <Btn onClick={run(async () => { await resumeFaq(a.faq.id); dismissAlert(a.key); })}>
                  Re-activate
                </Btn>
                <Btn subtle onClick={() => dismissAlert(a.key)}>Dismiss</Btn>
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* Pending — needs an answer */}
      <Section title={`Needs your answer${pendingFaqs.length ? ` (${pendingFaqs.length})` : ''}`}>
        {pendingFaqs.length === 0 && <Empty>No recurring questions detected yet.</Empty>}
        {pendingFaqs.map((f) => (
          <PendingCard key={f.id} faq={f} onApprove={run(approveFaq)} onDismiss={run(dismissFaq)} />
        ))}
      </Section>

      {/* Active */}
      <Section title={`Auto-replying${activeFaqs.length ? ` (${activeFaqs.length})` : ''}`}>
        {activeFaqs.length === 0 && <Empty>No active auto-replies.</Empty>}
        {activeFaqs.map((f) => (
          <ActiveCard key={f.id} faq={f} onEdit={run(editFaq)} onPause={run(pauseFaq)} onDelete={run(dismissFaq)} />
        ))}
      </Section>

      {/* Paused */}
      {pausedFaqs.length > 0 && (
        <Section title={`Paused (${pausedFaqs.length})`}>
          {pausedFaqs.map((f) => (
            <div key={f.id} className="rounded-lg p-3 bg-white/5">
              <p className="text-sm font-medium">{f.question}</p>
              {f.answer && <p className="text-xs opacity-70 mt-1 break-words">{f.answer}</p>}
              {f.pauseReason && <p className="text-[11px] opacity-50 mt-1">{f.pauseReason}</p>}
              <div className="flex gap-2 mt-2">
                <Btn onClick={run(() => resumeFaq(f.id))}>Resume</Btn>
                <Btn subtle onClick={run(() => dismissFaq(f.id))}>Delete</Btn>
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* Pre-seed */}
      <Section title="Pre-seed a FAQ">
        <SeedForm onSeed={run(seedFaq)} />
      </Section>

      {/* Activity */}
      {activity.length > 0 && (
        <Section title="Recent auto-replies">
          <div className="flex flex-col gap-1">
            {activity.slice(0, 12).map((a) => (
              <div key={a.key} className="text-[11px] opacity-70 flex gap-2">
                <span>🤖</span>
                <span className="truncate">
                  {a.room ? `${a.room}: ` : ''}{a.faq?.question}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ---------- subcomponents ----------

function PendingCard({ faq, onApprove, onDismiss }) {
  const [answer, setAnswer] = useState('');
  return (
    <div className="rounded-lg p-3 bg-white/5 border border-white/10">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium break-words">{faq.question}</p>
        <span className="text-[11px] opacity-50 whitespace-nowrap">×{faq.matchCount}</span>
      </div>
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Type the answer the bot should send…"
        rows={2}
        className="w-full mt-2 text-sm rounded px-2 py-1 bg-black/30 border border-white/10 resize-y"
      />
      <div className="flex gap-2 mt-2">
        <Btn
          disabled={!answer.trim()}
          onClick={async () => { if (answer.trim()) { await onApprove(faq.id, { answer }); setAnswer(''); } }}
        >
          Approve &amp; auto-reply
        </Btn>
        <Btn subtle onClick={() => onDismiss(faq.id)}>Dismiss</Btn>
      </div>
    </div>
  );
}

function ActiveCard({ faq, onEdit, onPause, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState(faq.answer || '');
  return (
    <div className="rounded-lg p-3 bg-emerald-500/10 border border-emerald-500/20">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium break-words">{faq.question}</p>
        <span className="text-[11px] opacity-50 whitespace-nowrap">↩ {faq.autoReplyCount}</span>
      </div>
      {editing ? (
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={2}
          className="w-full mt-2 text-sm rounded px-2 py-1 bg-black/30 border border-white/10 resize-y"
        />
      ) : (
        <p className="text-xs opacity-80 mt-1 break-words">{faq.answer}</p>
      )}
      <div className="flex gap-2 mt-2">
        {editing ? (
          <>
            <Btn onClick={async () => { await onEdit(faq.id, { answer }); setEditing(false); }}>Save</Btn>
            <Btn subtle onClick={() => { setAnswer(faq.answer || ''); setEditing(false); }}>Cancel</Btn>
          </>
        ) : (
          <>
            <Btn subtle onClick={() => setEditing(true)}>Edit</Btn>
            <Btn subtle onClick={() => onPause(faq.id, 'Paused by moderator')}>Pause</Btn>
            <Btn subtle onClick={() => onDelete(faq.id)}>Delete</Btn>
          </>
        )}
      </div>
    </div>
  );
}

function SeedForm({ onSeed }) {
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  return (
    <div className="rounded-lg p-3 bg-white/5 flex flex-col gap-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Question (e.g. link to VIP session)"
        className="w-full text-sm rounded px-2 py-1 bg-black/30 border border-white/10"
      />
      <textarea
        value={a}
        onChange={(e) => setA(e.target.value)}
        placeholder="Answer the bot should send"
        rows={2}
        className="w-full text-sm rounded px-2 py-1 bg-black/30 border border-white/10 resize-y"
      />
      <Btn
        disabled={!q.trim() || !a.trim()}
        onClick={async () => { if (q.trim() && a.trim()) { await onSeed({ question: q, answer: a }); setQ(''); setA(''); } }}
      >
        Add active FAQ
      </Btn>
    </div>
  );
}

// ---------- tiny UI primitives (match the app's tailwind/theme look) ----------

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-sm font-medium mb-2 opacity-70">{title}</h3>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Empty({ children }) {
  return <p className="text-xs opacity-40 italic">{children}</p>;
}

function Btn({ children, onClick, subtle, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        subtle ? 'bg-white/10 hover:bg-white/20' : 'text-white hover:opacity-90'
      }`}
      style={subtle ? undefined : { backgroundColor: 'var(--accent-color)' }}
    >
      {children}
    </button>
  );
}

function Switch({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-6 rounded-full transition-colors ${checked ? '' : 'bg-white/20'}`}
      style={checked ? { backgroundColor: 'var(--accent-color)' } : undefined}
      aria-pressed={checked}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  );
}

function NumField({ label, value, onCommit, ...rest }) {
  const [v, setV] = useState(value);
  React.useEffect(() => setV(value), [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] opacity-50">{label}</span>
      <input
        type="number"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { const n = Number(v); if (Number.isFinite(n) && n !== value) onCommit(n); }}
        className="w-full text-sm rounded px-2 py-1 bg-black/30 border border-white/10"
        {...rest}
      />
    </label>
  );
}

function Pill({ on }) {
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
        on ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 opacity-60'
      }`}
    >
      {on ? 'ON' : 'OFF'}
    </span>
  );
}

function Banner({ tone, children }) {
  const styles = {
    warn: 'bg-amber-500/15 border-amber-500/30 text-amber-200',
    error: 'bg-red-500/15 border-red-500/30 text-red-200',
  }[tone] || 'bg-white/5';
  return <div className={`rounded-lg p-2 text-xs border ${styles}`}>{children}</div>;
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}
