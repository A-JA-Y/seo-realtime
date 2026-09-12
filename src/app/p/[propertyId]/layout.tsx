import Link from 'next/link';

import { currentPrincipal } from '@/server/auth/config';
import { pageScope } from '@/server/dashboard/page-scope';
import { unreadAlertCount } from '@/server/dashboard/queries';
import { PropertyNav } from '@/components/dashboard/property-nav';
import { ThemeToggle } from '@/components/theme-toggle';

export const dynamic = 'force-dynamic';

export default async function PropertyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const { property } = await pageScope(propertyId);
  const principal = await currentPrincipal();
  const alerts = await unreadAlertCount(propertyId);

  return (
    <div className="min-h-dvh">
      <header className="bg-card sticky top-0 z-20 border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/" className="text-muted-foreground shrink-0 text-xs hover:underline">
            All properties
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold tracking-tight">{property.name}</h1>
            <p className="text-muted-foreground truncate text-xs">
              {property.domain} · times in {property.timezone}
            </p>
          </div>
          <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
            {principal?.email}
          </span>
          <ThemeToggle />
        </div>
        <PropertyNav propertyId={propertyId} alerts={alerts} />
      </header>
      {children}
    </div>
  );
}
