import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `process.env.NODE_ENV` is typed read-only by @types/node, so it is written
 * through the record view. The value genuinely is mutable at runtime, and this
 * suite has to exercise both branches of a production-only gate.
 */
const env = process.env as Record<string, string | undefined>;

describe('checkOpsAccess', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = env.NODE_ENV;
    vi.resetModules();
  });

  afterEach(() => {
    if (saved === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = saved;
  });

  it('FAILS CLOSED in production until real auth lands', async () => {
    // /ops exposes ingest errors and month-to-date spend. Shipping it open and
    // promising to lock it down next milestone is how an internal dashboard
    // ends up indexed.
    env.NODE_ENV = 'production';
    const { checkOpsAccess } = await import('./ops-access');

    const access = checkOpsAccess();
    expect(access.allowed).toBe(false);
    expect(access.reason).toMatch(/M5/);
  });

  it('allows access in development', async () => {
    env.NODE_ENV = 'development';
    const { checkOpsAccess } = await import('./ops-access');
    expect(checkOpsAccess().allowed).toBe(true);
  });
});
