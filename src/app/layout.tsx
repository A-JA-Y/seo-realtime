import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Rank Tracker',
  description: 'Near-realtime Google rank tracking with Search Console reconciliation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
