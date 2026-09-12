'use client';

import { useCallback, useSyncExternalStore } from 'react';
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

function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

/*
 * The stored theme is EXTERNAL state — it lives in localStorage, another tab
 * can change it, and the pre-paint script in the document head has already read
 * it before React exists. So it is subscribed to, not copied into state inside
 * an effect: reading it in an effect and calling setState renders the page once
 * with the wrong theme and again with the right one, which is the flash the
 * pre-paint script exists to prevent.
 */
function subscribe(onChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  // Another tab changing the setting fires `storage` here.
  window.addEventListener('storage', onChange);
  return () => {
    media.removeEventListener('change', onChange);
    window.removeEventListener('storage', onChange);
  };
}

function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : 'system';
  } catch {
    // A locked-down browser context. The OS preference is a fine fallback.
    return 'system';
  }
}

export function ThemeToggle() {
  /*
   * The server snapshot is 'system'. It has to be a constant: the server cannot
   * know the viewer's stored choice, and returning anything derived from the
   * browser here is a hydration mismatch.
   */
  const theme = useSyncExternalStore(subscribe, readStoredTheme, () => 'system' as Theme);

  const choose = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* the choice still applies for this page load */
    }
    applyTheme(next);
    // `storage` does not fire in the tab that wrote it, so nudge the store.
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
  }, []);

  return (
    <div
      className="flex items-center gap-0.5 rounded-md border p-0.5"
      role="group"
      aria-label="Theme"
    >
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
