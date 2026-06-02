import React, { createContext, useContext, useState, useEffect } from 'react';

const defaultSettings = {
  // Theme
  theme: 'dark', // 'dark', 'light', 'custom'
  backgroundColor: '#111827', // gray-900
  headerColor: '#1f2937', // gray-800
  accentColor: '#3b82f6', // blue-500
  textColor: '#ffffff',
  secondaryTextColor: '#9ca3af', // gray-400

  // Typography
  fontFamily: 'system', // 'system', 'inter', 'roboto', 'poppins'
  baseFontSize: 16, // px
  messageFontSize: 'medium', // 'small', 'medium', 'large', 'xlarge'

  // Display
  messageSpacing: 'comfortable', // 'compact', 'comfortable', 'spacious'
  showTimestamps: true,
  showRoomBadges: true,
  showSenderNames: true,
  showAvatars: false,

  // Layout
  sidebarVisible: true,
  headerVisible: true,
  fullScreenMode: false,
  // Multiplier applied to font sizes in the pop-out display view (the
  // on-air host's confidence monitor). 1.5x is a good default for a TV
  // viewed from a few feet away.
  displayScale: 1.5,

  // Branding
  appTitle: 'Zoom Chat Aggregator',
  appSubtitle: 'Real-time unified chat from all meeting rooms',
  logoUrl: '',
  // Operator-chosen brand mark printed in the bottom-right of PNG quote
  // card exports. Empty = no footer (the current default).
  brandMark: '',

  // Production-note auto-dismiss (presenter pop-out only). Seconds.
  // 0 = manual clear only — note stays on screen until cleared.
  presenterNoteAutoDismissSeconds: 60,

  // Behavior
  autoScroll: true,
  soundEnabled: false,
  animationsEnabled: true,
};

const SettingsContext = createContext();

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => {
    // Load from localStorage on init
    const saved = localStorage.getItem('chatAggregatorSettings');
    if (saved) {
      try {
        return { ...defaultSettings, ...JSON.parse(saved) };
      } catch (e) {
        return defaultSettings;
      }
    }
    return defaultSettings;
  });

  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);

  // Save to localStorage whenever settings change
  useEffect(() => {
    localStorage.setItem('chatAggregatorSettings', JSON.stringify(settings));
  }, [settings]);

  // Apply CSS variables for theming
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--bg-color', settings.backgroundColor);
    root.style.setProperty('--header-color', settings.headerColor);
    root.style.setProperty('--accent-color', settings.accentColor);
    root.style.setProperty('--text-color', settings.textColor);
    root.style.setProperty('--secondary-text-color', settings.secondaryTextColor);
    root.style.setProperty('--base-font-size', `${settings.baseFontSize}px`);

    // Font family
    const fontFamilies = {
      system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      inter: '"Inter", sans-serif',
      roboto: '"Roboto", sans-serif',
      poppins: '"Poppins", sans-serif',
    };
    root.style.setProperty('--font-family', fontFamilies[settings.fontFamily] || fontFamilies.system);

    // Message font size
    const fontSizes = {
      small: '14px',
      medium: '16px',
      large: '20px',
      xlarge: '24px',
    };
    root.style.setProperty('--message-font-size', fontSizes[settings.messageFontSize] || '16px');

    // Message spacing
    const spacings = {
      compact: '4px',
      comfortable: '8px',
      spacious: '16px',
    };
    root.style.setProperty('--message-spacing', spacings[settings.messageSpacing] || '8px');

    // Display-view font multiplier (consumed by ChatMessage displayMode).
    root.style.setProperty('--display-scale', String(settings.displayScale ?? 1.5));
  }, [settings]);

  // Cross-window settings sync. The `storage` event fires in OTHER windows
  // of the same origin when one window writes to localStorage. This lets
  // settings changes in the main control panel propagate to the pop-out
  // display view (which lives in a separate window with its own context).
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'chatAggregatorSettings' || !e.newValue) return;
      try {
        const incoming = JSON.parse(e.newValue);
        setSettings(prev => {
          // Avoid setting if structurally identical (prevents re-render loops).
          if (JSON.stringify(prev) === e.newValue) return prev;
          return { ...defaultSettings, ...incoming };
        });
      } catch {
        // ignore malformed payloads
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const updateSettings = (newSettings) => {
    setSettings(prev => ({ ...prev, ...newSettings }));
  };

  const resetSettings = () => {
    setSettings(defaultSettings);
  };

  const applyPreset = (preset) => {
    const presets = {
      dark: {
        theme: 'dark',
        backgroundColor: '#111827',
        headerColor: '#1f2937',
        accentColor: '#3b82f6',
        textColor: '#ffffff',
        secondaryTextColor: '#9ca3af',
      },
      light: {
        theme: 'light',
        backgroundColor: '#f3f4f6',
        headerColor: '#ffffff',
        accentColor: '#2563eb',
        textColor: '#111827',
        secondaryTextColor: '#6b7280',
      },
      midnight: {
        theme: 'custom',
        backgroundColor: '#0f0f23',
        headerColor: '#1a1a2e',
        accentColor: '#00d9ff',
        textColor: '#ffffff',
        secondaryTextColor: '#64748b',
      },
      forest: {
        theme: 'custom',
        backgroundColor: '#1a2e1a',
        headerColor: '#243524',
        accentColor: '#22c55e',
        textColor: '#ffffff',
        secondaryTextColor: '#86efac',
      },
      sunset: {
        theme: 'custom',
        backgroundColor: '#1f1520',
        headerColor: '#2d1f2d',
        accentColor: '#f97316',
        textColor: '#ffffff',
        secondaryTextColor: '#fdba74',
      },
      corporate: {
        theme: 'custom',
        backgroundColor: '#1e293b',
        headerColor: '#334155',
        accentColor: '#0ea5e9',
        textColor: '#f8fafc',
        secondaryTextColor: '#94a3b8',
      },
    };

    if (presets[preset]) {
      updateSettings(presets[preset]);
    }
  };

  return (
    <SettingsContext.Provider value={{
      settings,
      updateSetting,
      updateSettings,
      resetSettings,
      applyPreset,
      settingsPanelOpen,
      setSettingsPanelOpen,
    }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
