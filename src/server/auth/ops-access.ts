import { requireEnv } from '@/lib/env';

/**
 * Access gate for `/ops`, pending real auth in M5.
 *
 * §10 makes `/ops` agency_admin only, and it exposes ingest health, error
 * messages and spend. Auth.js lands in M5, so this is the seam that will hold
 * `assertPropertyAccess`-style checks when it does.
 *
 * Until then it FAILS CLOSED in production. Shipping an open /ops and promising
 * to lock it down next milestone is how an internal dashboard ends up indexed;
 * a page that refuses to render is an obvious gap, which is the failure mode to
 * prefer.
 */
export class OpsAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsAccessError';
  }
}

export interface OpsAccess {
  allowed: boolean;
  reason: string;
}

export function checkOpsAccess(): OpsAccess {
  const { NODE_ENV } = requireEnv('NODE_ENV');

  if (NODE_ENV === 'production') {
    return {
      allowed: false,
      reason:
        'Authentication is not wired up yet (Auth.js lands in M5). /ops exposes ingest ' +
        'errors and spend, so it stays closed in production until a real agency_admin ' +
        'session check replaces this.',
    };
  }

  return { allowed: true, reason: 'development' };
}
