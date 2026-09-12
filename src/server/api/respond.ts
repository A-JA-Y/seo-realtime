import { NextResponse } from 'next/server';
import { z } from 'zod';

import { logger } from '@/lib/logger';
import { redactError } from '@/lib/redact';
import { ForbiddenError, UnauthorizedError } from '@/server/auth/access';

/**
 * One error shape for every API route (§10).
 *
 * "Return typed errors with a stable `code` field."
 *
 * The mapping matters as much as the shape. A tenancy failure returns 403 and
 * nothing else — never 404, and never a message naming the resource. A 404
 * would confirm which ids exist, turning any endpoint addressed by id into a
 * cross-tenant enumeration oracle.
 */

export interface ApiError {
  error: { code: string; message: string };
}

export function apiError(code: string, message: string, status: number) {
  return NextResponse.json<ApiError>({ error: { code, message } }, { status });
}

/**
 * Run a route handler, turning known failures into typed responses.
 *
 * Anything unrecognised becomes a 500 with a stable code and no detail: the
 * detail goes to the log, redacted, because driver errors carry connection
 * strings (acceptance criterion 12).
 */
export async function handleRoute<T>(
  route: string,
  handler: () => Promise<T>,
): Promise<NextResponse> {
  try {
    return NextResponse.json(await handler());
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return apiError(error.code, error.message, error.status);
    }

    if (error instanceof z.ZodError) {
      return apiError(
        'INVALID_INPUT',
        error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; '),
        400,
      );
    }

    logger.error('unhandled error in an API route', { route, error: redactError(error) });
    return apiError('INTERNAL', 'Something went wrong.', 500);
  }
}
