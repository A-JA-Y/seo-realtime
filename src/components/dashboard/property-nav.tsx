'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function PropertyNav({ propertyId, alerts }: { propertyId: string; alerts: number }) {
  const pathname = usePathname();
  const base = `/p/${propertyId}`;

  const tabs = [
    { href: base, label: 'Overview' },
    { href: `${base}/keywords`, label: 'Keywords' },
    { href: `${base}/competitors`, label: 'Competitors' },
    { href: `${base}/alerts`, label: 'Alerts', count: alerts },
  ];

  return (
    <nav className="mx-auto max-w-7xl overflow-x-auto px-4 sm:px-6">
      <ul className="flex gap-1">
        {tabs.map((tab) => {
          const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap',
                  active
                    ? 'border-foreground text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground border-transparent',
                )}
              >
                {tab.label}
                {tab.count ? <Badge tone="critical">{tab.count}</Badge> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
