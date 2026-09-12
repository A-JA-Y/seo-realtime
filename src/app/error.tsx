'use client';

import { ErrorView } from '@/components/error-view';

/**
 * The ROOT boundary.
 *
 * It catches more than it looks like it should: an error thrown in a LAYOUT is
 * caught by the parent segment's boundary, so the property layout's tenancy
 * check lands here rather than in `p/[propertyId]/error.tsx`.
 */
export default function GlobalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorView {...props} />;
}
