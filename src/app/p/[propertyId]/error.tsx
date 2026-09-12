'use client';

import { ErrorView } from '@/components/error-view';

/**
 * The property-segment boundary.
 *
 * Catches errors thrown by the PAGES under `/p/[propertyId]`. Errors from the
 * layout itself — including its tenancy check — go to the root boundary
 * instead, which renders the same view.
 */
export default function PropertyError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorView {...props} />;
}
