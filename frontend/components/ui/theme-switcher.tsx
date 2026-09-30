'use client';

import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useTheme, type ThemePreference } from '@/lib/theme';

const OPTIONS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/**
 * Light, Dark or System, as a three-way segmented control. The selected
 * option sits on the raised surface; the others stay quiet.
 */
export function ThemeSwitcher({ className = '' }: { className?: string }) {
  const { preference, setPreference } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={`grid grid-cols-3 gap-0.5 rounded-control bg-surface-overlay/70 p-0.5 ${className}`}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={value === 'system' ? 'Follow the system setting' : `${label} mode`}
            onClick={() => setPreference(value)}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-caption font-medium transition-colors ${
              selected
                ? 'bg-surface-raised text-content ring-1 ring-surface-border'
                : 'text-content-subtle hover:text-content'
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
