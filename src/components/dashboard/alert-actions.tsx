'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Check, CheckCheck, Undo2 } from 'lucide-react';

import { cn } from '@/lib/utils';

type Action = 'read' | 'unread' | 'resolve';

const LABEL: Record<Action, string> = {
  read: 'Mark read',
  unread: 'Mark unread',
  resolve: 'Resolve',
};

const ICON = { read: Check, unread: Undo2, resolve: CheckCheck } as const;

/**
 * Per-alert actions.
 *
 * "Resolve" is not cosmetic. The partial unique index keys on
 * `signature WHERE resolved_at IS NULL`, so an open alert holds its signature
 * and suppresses a recurrence. Resolving frees it — which is why a person
 * closing an alert they have dealt with is a real part of the loop, not a
 * tidy-up.
 */
export function AlertActions({
  alertId,
  isRead,
  isResolved,
}: {
  alertId: string;
  isRead: boolean;
  isResolved: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(action: Action) {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/alerts/${alertId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        setError(
          (body as { error?: { message?: string } } | null)?.error?.message ?? 'That did not work.',
        );
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  const actions: Action[] = isResolved ? [] : isRead ? ['unread', 'resolve'] : ['read', 'resolve'];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((action) => {
        const Icon = ICON[action];
        return (
          <button
            key={action}
            type="button"
            onClick={() => send(action)}
            disabled={busy !== null || pending}
            className={cn(
              'text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <Icon className="size-3" aria-hidden />
            {LABEL[action]}
          </button>
        );
      })}
      {error ? <span className="text-xs text-[#a82c2c] dark:text-[#e87070]">{error}</span> : null}
    </div>
  );
}

/** Mark every open alert read in one statement, so it cannot half-apply. */
export function MarkAllRead({ propertyId, unread }: { propertyId: string; unread: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  if (unread === 0) return null;

  return (
    <button
      type="button"
      disabled={busy || pending}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch(`/api/properties/${propertyId}/alerts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'read-all' }),
          });
          startTransition(() => router.refresh());
        } finally {
          setBusy(false);
        }
      }}
      className="text-muted-foreground hover:text-foreground rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
    >
      Mark all {unread} read
    </button>
  );
}
