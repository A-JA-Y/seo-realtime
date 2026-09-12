'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface CheckResponse {
  status: 'ok';
  source: string;
  costUsd: number;
  cooldownSeconds: number;
  check: { found: boolean; rankGroup: number | null; rankAbsolute: number | null };
}

interface ErrorResponse {
  error: { code: string; message: string };
}

/**
 * "Check now" — the one button in this product that spends money when pressed.
 *
 * So it says so, before the press and after it. The price is on the button, the
 * cooldown is visible as a countdown rather than as a silent failure, and a
 * rate-limited response is reported as "already checked recently" instead of an
 * error, because it is not one.
 */
export function CheckNowButton({
  keywordTargetId,
  costUsd,
  cooldownSeconds,
  lastCheckedAt,
}: {
  keywordTargetId: string;
  costUsd: number;
  cooldownSeconds: number;
  lastCheckedAt: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<'neutral' | 'good' | 'warning' | 'critical'>('neutral');
  const [waitUntil, setWaitUntil] = useState<number | null>(() => {
    if (!lastCheckedAt) return null;
    const next = new Date(lastCheckedAt).getTime() + cooldownSeconds * 1000;
    return next > Date.now() ? next : null;
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (waitUntil === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waitUntil]);

  const remaining = waitUntil === null ? 0 : Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const cooling = remaining > 0;
  const disabled = busy || pending || cooling;

  async function check() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/keyword-targets/${keywordTargetId}/check`, {
        method: 'POST',
      });
      const body: unknown = await response.json();

      if (response.status === 429) {
        const seconds = Number(response.headers.get('Retry-After') ?? cooldownSeconds);
        setWaitUntil(Date.now() + seconds * 1000);
        setNow(Date.now());
        setTone('warning');
        setMessage((body as ErrorResponse).error?.message ?? 'Checked recently.');
        return;
      }

      if (!response.ok) {
        setTone('critical');
        setMessage((body as ErrorResponse).error?.message ?? 'The check failed.');
        return;
      }

      const result = body as CheckResponse;
      setWaitUntil(Date.now() + result.cooldownSeconds * 1000);
      setNow(Date.now());
      setTone('good');
      setMessage(
        result.check.found
          ? `#${result.check.rankGroup} organic, #${result.check.rankAbsolute} counting every element · $${result.costUsd.toFixed(4)}`
          : `Not found in the fetched results · $${result.costUsd.toFixed(4)}`,
      );
      startTransition(() => router.refresh());
    } catch {
      setTone('critical');
      setMessage('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={check}
        disabled={disabled}
        className={cn(
          'bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <RefreshCw className={cn('size-3.5', (busy || pending) && 'animate-spin')} aria-hidden />
        {busy ? 'Checking…' : cooling ? `Wait ${remaining}s` : 'Check now'}
      </button>

      <span className="text-muted-foreground text-xs">
        ${costUsd.toFixed(4)} a check · one per {Math.round(cooldownSeconds / 60)} minutes
      </span>

      {message ? <Badge tone={tone}>{message}</Badge> : null}
    </div>
  );
}
