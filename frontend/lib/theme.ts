'use client';

import { useCallback, useEffect, useState } from 'react';
import { THEME_STORAGE_KEY } from './theme-script';

/**
 * The person's theme choice. 'system' follows the operating system; 'light'
 * and 'dark' override it.
 *
 * Stored per browser in localStorage: it is a display preference, not account
 * data, so it does not need the server, and a missing or blocked store simply
 * means System.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Reflects the choice on <html>, where globals.css reads it. */
function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
}

export function useTheme(): {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
} {
  // 'system' on the server and the first client render, so hydration matches;
  // the stored value is read straight after mount. The page colours are
  // already right by then: THEME_INIT_SCRIPT (lib/theme-script.ts) ran before
  // the first paint.
  const [preference, setState] = useState<ThemePreference>('system');

  useEffect(() => {
    setState(readPreference());

    // Keep several open tabs in step.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = readPreference();
      applyPreference(next);
      setState(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      if (next === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice still applies for this page view.
    }
    applyPreference(next);
    setState(next);
  }, []);

  return { preference, setPreference };
}
