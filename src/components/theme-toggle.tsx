'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

import { cn } from '@/lib/utils';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'rank-tracker-theme';

/**
 * Apply a theme by stamping the class Tailwind's `dark:` variant and the chart
 * tokens both key off.
 *
 * Exported so the blocking script in the document head and this component run
 * the same logic; two copies of "which class means dark" is how a page ends up
 * with dark tokens and light utilities at the same time.
 */
export function applyTheme(theme: Theme) {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset['theme'] = theme;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

const OPTIONS: Array<{ value: Theme; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    // localStorage throws in a locked-down browser context; the OS preference is
    // a perfectly good fallback, so a failure here is not worth a broken page.
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') setTheme(stored);
    } catch {
      /* keep 'system' */
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;

    // Follow the OS while it is what we are following.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => applyTheme('system');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [theme]);

  function choose(next: Theme) {
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* the choice still applies for this page load */
    }
  }

  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5" role="group" aria-label="Theme">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => choose(value)}
          aria-pressed={theme === value}
          title={label}
          className={cn(
            'rounded p-1',
            theme === value
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
