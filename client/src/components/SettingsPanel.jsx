import React, { useState, useEffect } from 'react';
import { useSettings } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import TeamPanel from './TeamPanel';

const API_URL = import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin;

function SettingsPanel() {
  const {
    settings,
    updateSetting,
    resetSettings,
    applyPreset,
    settingsPanelOpen,
    setSettingsPanelOpen
  } = useSettings();
  const { user } = useAuth();

  if (!settingsPanelOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => setSettingsPanelOpen(false)}
      />

      {/* Panel */}
      <div
        className="absolute right-0 top-0 h-full w-96 max-w-full overflow-y-auto shadow-2xl"
        style={{ backgroundColor: 'var(--header-color)' }}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-white/10" style={{ backgroundColor: 'var(--header-color)' }}>
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-color)' }}>Settings</h2>
          <button
            onClick={() => setSettingsPanelOpen(false)}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors"
            style={{ color: 'var(--text-color)' }}
          >
            ✕
          </button>
        </div>

        <div className="p-4 space-y-6">
          {/* Theme Presets */}
          <Section title="Theme Presets">
            <div className="grid grid-cols-3 gap-2">
              {['dark', 'light', 'midnight', 'forest', 'sunset', 'corporate'].map((preset) => (
                <button
                  key={preset}
                  onClick={() => applyPreset(preset)}
                  className="px-3 py-2 rounded-lg text-sm font-medium capitalize transition-all hover:scale-105"
                  style={{
                    backgroundColor: settings.theme === preset ? 'var(--accent-color)' : 'rgba(255,255,255,0.1)',
                    color: 'var(--text-color)',
                  }}
                >
                  {preset}
                </button>
              ))}
            </div>
          </Section>

          {/* Custom Colors */}
          <Section title="Custom Colors">
            <ColorPicker
              label="Background"
              value={settings.backgroundColor}
              onChange={(v) => updateSetting('backgroundColor', v)}
            />
            <ColorPicker
              label="Header"
              value={settings.headerColor}
              onChange={(v) => updateSetting('headerColor', v)}
            />
            <ColorPicker
              label="Accent"
              value={settings.accentColor}
              onChange={(v) => updateSetting('accentColor', v)}
            />
            <ColorPicker
              label="Text"
              value={settings.textColor}
              onChange={(v) => updateSetting('textColor', v)}
            />
            <ColorPicker
              label="Secondary Text"
              value={settings.secondaryTextColor}
              onChange={(v) => updateSetting('secondaryTextColor', v)}
            />
          </Section>

          {/* Typography */}
          <Section title="Typography">
            <SelectOption
              label="Font Family"
              value={settings.fontFamily}
              options={[
                { value: 'system', label: 'System Default' },
                { value: 'inter', label: 'Inter' },
                { value: 'roboto', label: 'Roboto' },
                { value: 'poppins', label: 'Poppins' },
              ]}
              onChange={(v) => updateSetting('fontFamily', v)}
            />
            <SelectOption
              label="Message Size"
              value={settings.messageFontSize}
              options={[
                { value: 'small', label: 'Small' },
                { value: 'medium', label: 'Medium' },
                { value: 'large', label: 'Large' },
                { value: 'xlarge', label: 'Extra Large' },
              ]}
              onChange={(v) => updateSetting('messageFontSize', v)}
            />
            <SliderOption
              label="Base Font Size"
              value={settings.baseFontSize}
              min={12}
              max={24}
              onChange={(v) => updateSetting('baseFontSize', v)}
            />
            <SelectOption
              label="Display View Scale"
              value={String(settings.displayScale ?? 1.5)}
              options={[
                { value: '1',    label: '1× (Same as main)' },
                { value: '1.25', label: '1.25×' },
                { value: '1.5',  label: '1.5× (Default)' },
                { value: '2',    label: '2×' },
                { value: '2.5',  label: '2.5×' },
                { value: '3',    label: '3× (TV across studio)' },
              ]}
              onChange={(v) => updateSetting('displayScale', Number(v))}
            />
            <SelectOption
              label="Production note auto-clear"
              value={String(settings.presenterNoteAutoDismissSeconds ?? 60)}
              options={[
                { value: '15',  label: '15 seconds' },
                { value: '30',  label: '30 seconds' },
                { value: '60',  label: '1 minute (default)' },
                { value: '120', label: '2 minutes' },
                { value: '300', label: '5 minutes' },
                { value: '0',   label: 'Manual clear only' },
              ]}
              onChange={(v) => updateSetting('presenterNoteAutoDismissSeconds', Number(v))}
            />
          </Section>

          {/* Display Options */}
          <Section title="Display Options">
            <SelectOption
              label="Message Spacing"
              value={settings.messageSpacing}
              options={[
                { value: 'compact', label: 'Compact' },
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'spacious', label: 'Spacious' },
              ]}
              onChange={(v) => updateSetting('messageSpacing', v)}
            />
            <ToggleOption
              label="Show Timestamps"
              value={settings.showTimestamps}
              onChange={(v) => updateSetting('showTimestamps', v)}
            />
            <ToggleOption
              label="Show Room Badges"
              value={settings.showRoomBadges}
              onChange={(v) => updateSetting('showRoomBadges', v)}
            />
            <ToggleOption
              label="Show Sender Names"
              value={settings.showSenderNames}
              onChange={(v) => updateSetting('showSenderNames', v)}
            />
            <ToggleOption
              label="Enable Animations"
              value={settings.animationsEnabled}
              onChange={(v) => updateSetting('animationsEnabled', v)}
            />
          </Section>

          {/* Layout */}
          <Section title="Layout">
            <ToggleOption
              label="Show Sidebar"
              value={settings.sidebarVisible}
              onChange={(v) => updateSetting('sidebarVisible', v)}
            />
            <ToggleOption
              label="Show Header"
              value={settings.headerVisible}
              onChange={(v) => updateSetting('headerVisible', v)}
            />
            <ToggleOption
              label="Full Screen Mode"
              value={settings.fullScreenMode}
              onChange={(v) => {
                updateSetting('fullScreenMode', v);
                if (v) {
                  document.documentElement.requestFullscreen?.();
                } else {
                  document.exitFullscreen?.();
                }
              }}
            />
          </Section>

          {/* Branding */}
          <Section title="Branding">
            <TextInput
              label="App Title"
              value={settings.appTitle}
              onChange={(v) => updateSetting('appTitle', v)}
            />
            <TextInput
              label="Subtitle"
              value={settings.appSubtitle}
              onChange={(v) => updateSetting('appSubtitle', v)}
            />
            <TextInput
              label="Logo URL"
              value={settings.logoUrl}
              onChange={(v) => updateSetting('logoUrl', v)}
              placeholder="https://example.com/logo.png"
            />
            <TextInput
              label="Brand mark (PNG exports)"
              value={settings.brandMark}
              onChange={(v) => updateSetting('brandMark', v)}
              placeholder="e.g. RYTE PRODUCTIONS"
            />
          </Section>

          {/* Team — admin-only. Hidden for operators and unsigned-in. */}
          {user?.role === 'admin' && (
            <Section title="Team">
              <TeamPanel />
            </Section>
          )}

          {/* Zoom Integration — admin-only. Per-org S2S OAuth creds for
              auto-registering bots as webinar panelists. */}
          {user?.role === 'admin' && (
            <Section title="Zoom Integration">
              <ZoomIntegrationSection />
            </Section>
          )}

          {/* Chat filters — admin-only org behavior. */}
          {user?.role === 'admin' && (
            <Section title="Chat Filters">
              <NotetakerFilterToggle />
            </Section>
          )}

          {/* Reset */}
          <div className="pt-4 border-t border-white/10">
            <button
              onClick={resetSettings}
              className="w-full py-3 rounded-lg font-medium transition-colors bg-red-600 hover:bg-red-700"
              style={{ color: '#ffffff' }}
            >
              Reset to Defaults
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Sub-components

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--secondary-text-color)' }}>
        {title}
      </h3>
      <div className="space-y-3">
        {children}
      </div>
    </div>
  );
}

function ColorPicker({ label, value, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm" style={{ color: 'var(--text-color)' }}>{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-8 h-8 rounded cursor-pointer border-0"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-20 px-2 py-1 rounded text-xs font-mono"
          style={{
            backgroundColor: 'rgba(255,255,255,0.1)',
            color: 'var(--text-color)',
            border: '1px solid rgba(255,255,255,0.2)'
          }}
        />
      </div>
    </div>
  );
}

function SelectOption({ label, value, options, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm" style={{ color: 'var(--text-color)' }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="px-3 py-1.5 rounded text-sm cursor-pointer"
        style={{
          backgroundColor: 'rgba(255,255,255,0.1)',
          color: 'var(--text-color)',
          border: '1px solid rgba(255,255,255,0.2)'
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} style={{ backgroundColor: '#1f2937' }}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleOption({ label, value, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm" style={{ color: 'var(--text-color)' }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        className={`relative w-12 h-6 rounded-full transition-colors ${value ? '' : 'bg-gray-600'}`}
        style={{ backgroundColor: value ? 'var(--accent-color)' : undefined }}
      >
        <div
          className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
            value ? 'translate-x-7' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

function SliderOption({ label, value, min, max, onChange }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm" style={{ color: 'var(--text-color)' }}>{label}</span>
        <span className="text-sm font-mono" style={{ color: 'var(--secondary-text-color)' }}>{value}px</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-2 rounded-lg appearance-none cursor-pointer"
        style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
      />
    </div>
  );
}

function TextInput({ label, value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-sm mb-1" style={{ color: 'var(--text-color)' }}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded text-sm"
        style={{
          backgroundColor: 'rgba(255,255,255,0.1)',
          color: 'var(--text-color)',
          border: '1px solid rgba(255,255,255,0.2)'
        }}
      />
    </div>
  );
}

/**
 * Zoom Integration — enter the customer's Server-to-Server OAuth creds
 * (account_id / client_id / client_secret) once, so the app can register
 * bots as webinar panelists. The secret is write-only: once saved the
 * server only reports that it's configured, never the value.
 */
function ZoomIntegrationSection() {
  const [status, setStatus] = useState(null); // { configured, accountId, clientId, hasSecret, updatedAt }
  const [accountId, setAccountId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [emailBase, setEmailBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [testWebinarId, setTestWebinarId] = useState('');
  const [msg, setMsg] = useState(null); // { kind: 'ok'|'err', text }

  const loadStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/api/zoom/credentials`);
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data);
      if (data.configured) {
        setAccountId(data.accountId || '');
        setClientId(data.clientId || '');
      }
      setEmailBase(data.panelistEmailBase || '');
    } catch { /* ignore */ }
  };

  useEffect(() => { loadStatus(); }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body = { accountId, clientId, panelistEmailBase: emailBase.trim() };
      if (clientSecret.trim()) body.clientSecret = clientSecret.trim();
      const res = await fetch(`${API_URL}/api/zoom/credentials`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(data);
      setClientSecret('');
      setMsg({ kind: 'ok', text: 'Saved.' });
    } catch (err) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_URL}/api/zoom/credentials/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testWebinarId.trim() ? { webinarId: testWebinarId.trim() } : {}),
      });
      const data = await res.json();
      if (data.ok) {
        setMsg({
          kind: 'ok',
          text: data.webinarAccessOk
            ? 'Connected — token + webinar access OK.'
            : 'Token OK. Add a webinar ID above to also verify scopes + Webinar add-on.',
        });
      } else {
        setMsg({ kind: 'err', text: data.error || 'Test failed.' });
      }
    } catch (err) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: 'var(--secondary-text-color)' }}>
        Create a Server-to-Server OAuth app in the Zoom Marketplace with the
        <span className="font-mono"> webinar:read:admin</span> +
        <span className="font-mono"> webinar:write:admin</span> scopes, on an
        account that has the Webinar add-on. Then paste its credentials here.
        {status?.configured && (
          <span className="block mt-1 text-green-400">
            ✓ Connected{status.updatedAt ? ` · updated ${new Date(status.updatedAt).toLocaleDateString()}` : ''}
          </span>
        )}
      </p>

      <TextInput label="Account ID" value={accountId} onChange={setAccountId} placeholder="e.g. abCdEf12Gh…" />
      <TextInput label="Client ID" value={clientId} onChange={setClientId} placeholder="Client ID" />
      <div>
        <label className="block text-sm mb-1" style={{ color: 'var(--text-color)' }}>Client Secret</label>
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={status?.hasSecret ? '•••••• (saved — leave blank to keep)' : 'Client Secret'}
          className="w-full px-3 py-2 rounded text-sm"
          style={{ backgroundColor: 'rgba(255,255,255,0.1)', color: 'var(--text-color)', border: '1px solid rgba(255,255,255,0.2)' }}
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={busy || !accountId.trim() || !clientId.trim() || (!clientSecret.trim() && !status?.hasSecret)}
          className="flex-1 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
          style={{ backgroundColor: 'var(--accent-color)', color: '#fff' }}
        >
          {busy ? '…' : 'Save'}
        </button>
        <button
          onClick={test}
          disabled={busy || !status?.configured}
          className="flex-1 py-2 rounded-lg font-medium transition-colors bg-white/10 hover:bg-white/20 disabled:opacity-50"
          style={{ color: 'var(--text-color)' }}
          title="Verify the saved credentials against Zoom"
        >
          Test connection
        </button>
      </div>

      <div className="pt-1 border-t border-white/10">
        <TextInput
          label="Bot panelist email (base)"
          value={emailBase}
          onChange={setEmailBase}
          placeholder="e.g. chatbot@yourdomain.com"
        />
        <p className="text-[11px] mt-1" style={{ color: 'var(--secondary-text-color)' }}>
          Optional override. Leave blank to use the shared default
          {status?.systemEmailBase ? (
            <span className="font-mono"> ({status.systemEmailBase})</span>
          ) : ''}. The app auto-creates a unique alias per webinar
          (e.g. <span className="font-mono">+zoom5</span>) when you tick "auto-register"
          on a roster entry — no per-room typing. Set this only to use your own domain. Saved with Save above.
        </p>
      </div>

      <TextInput
        label="Test webinar ID (optional)"
        value={testWebinarId}
        onChange={setTestWebinarId}
        placeholder="verifies scopes + add-on"
      />

      {msg && (
        <p className={`text-xs ${msg.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/**
 * Org-level toggle for the notetaker-bot filter. Server-side behavior
 * (MessageAggregator drops matching chat), so it reads/writes
 * /api/org/settings rather than the local SettingsContext.
 */
function NotetakerFilterToggle() {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/org/settings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setEnabled(d.notetakerFilterEnabled !== false); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const toggle = async (next) => {
    setEnabled(next); // optimistic
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/org/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notetakerFilterEnabled: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEnabled(data.notetakerFilterEnabled !== false);
    } catch {
      setEnabled(!next); // revert on failure
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <ToggleOption
        label="Hide notetaker bots"
        value={enabled}
        onChange={(v) => !busy && loaded && toggle(v)}
      />
      <p className="text-[11px]" style={{ color: 'var(--secondary-text-color)' }}>
        Drops chat from third-party notetakers (Otter, Fireflies, Fathom, …) —
        both their own messages and the "upgrade to Pro" notices that post under
        an attendee's name. Doesn't remove the bots from Zoom; just keeps their
        chatter out of your feed. On for everyone by default.
      </p>
    </div>
  );
}

export default SettingsPanel;
