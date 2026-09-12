import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card, CardContent } from '@/components/ui/card';
import { currentPrincipal } from '@/server/auth/config';
import { accessibleProperties } from '@/server/db/scoped';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const principal = await currentPrincipal();
  if (!principal) redirect('/login');

  const properties = await accessibleProperties(principal);

  // One property is the common case for a client login; skip the picker.
  if (properties.length === 1 && properties[0]) {
    redirect(`/p/${properties[0].id}`);
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Properties</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Signed in as {principal.email} · {principal.role.replace('_', ' ')}
      </p>

      {properties.length === 0 ? (
        <Card className="mt-8">
          <CardContent className="text-muted-foreground text-sm leading-relaxed">
            No properties are shared with this account yet. An agency admin adds
            them — nothing is wrong on your side.
          </CardContent>
        </Card>
      ) : (
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {properties.map((property) => (
            <li key={property.id}>
              <Link href={`/p/${property.id}`} className="block">
                <Card className="hover:border-foreground/25 transition-colors">
                  <CardContent>
                    <p className="font-medium">{property.name}</p>
                    <p className="text-muted-foreground mt-1 truncate text-xs">
                      {property.domain}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
