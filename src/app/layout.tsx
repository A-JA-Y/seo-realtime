import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Rank Tracker',
  description: 'Near-realtime Google rank tracking with Search Console reconciliation',
};

/*
 * Stamp the theme class BEFORE first paint.
 *
 * Deciding this in React means the page renders light, hydrates, then flips —
 * a white flash on every navigation for anyone using dark mode. The dark
 * palette is a selected set of steps, not an automatic inversion, so it has to
 * be in place before anything is painted.
 *
 * Kept in sync with `applyTheme` in components/theme-toggle.tsx by hand; it is
 * three lines, and importing a module here would defeat the point of running
 * before the bundle loads.
 */
const THEME_SCRIPT = [
  '(function(){try{',
  "var t=localStorage.getItem('rank-tracker-theme')||'system';",
  "var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);",
  "document.documentElement.classList.toggle('dark',d);",
  'document.documentElement.dataset.theme=t;',
  "document.documentElement.style.colorScheme=d?'dark':'light';",
  '}catch(e){}})()',
].join('');

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
