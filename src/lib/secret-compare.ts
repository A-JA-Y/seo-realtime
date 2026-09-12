import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time secret comparison.
 *
 * §6 and §7 both require it for the pingback and cron secrets. A naive `===`
 * on strings short-circuits at the first differing byte, so response time leaks
 * how many leading characters an attacker got right — enough to recover the
 * secret one character at a time.
 *
 * Both values are hashed to a fixed 32 bytes first. `timingSafeEqual` throws on
 * length mismatch, and comparing raw inputs would leak the secret's LENGTH
 * through that error path; hashing makes every comparison the same width.
 */
export function secretsMatch(provided: string | null | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (expected.length === 0) return false;

  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();

  return timingSafeEqual(a, b);
}

/**
 * Check an `Authorization: Bearer <secret>` header, or a `?secret=` query param.
 *
 * §7 requires both: Vercel's own cron sends the header automatically, while a
 * free external scheduler often cannot set headers at all and must use the
 * query string.
 */
export function requestSecretMatches(request: Request, expected: string): boolean {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ') && secretsMatch(header.slice(7), expected)) return true;

  const param = new URL(request.url).searchParams.get('secret');
  return secretsMatch(param, expected);
}
