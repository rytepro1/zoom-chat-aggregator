import React from 'react';
import { useSettings } from '../contexts/SettingsContext';

function SettingsPanel() {
  const {
    settings,
    updateSetting,
    resetSettings,
    applyPreset,
    settingsPanelOpen,
    setSettingsPanelOpen
  } = useSettings();

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

export default SettingsPanel;
