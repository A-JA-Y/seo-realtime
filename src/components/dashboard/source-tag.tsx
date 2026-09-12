import { cn } from '@/lib/utils';

/**
 * The source label that sits next to every position number (§11, acceptance
 * criterion 7: "Every position number rendered anywhere in the UI is labelled
 * with its source").
 *
 * The swatch carries the identity and the words carry the meaning — the text
 * itself stays in muted ink rather than wearing the series colour, so the label
 * is still readable at small sizes and in greyscale.
 */
export type Source = 'live rank' | 'Search Console average' | 'rank_absolute' | 'configuration';

const SWATCH: Record<Source, string> = {
  'live rank': 'bg-source-serp',
  'Search Console average': 'bg-source-gsc',
  rank_absolute: 'bg-source-absolute',
  configuration: 'bg-muted-foreground/40',
};

const WORDS: Record<Source, string> = {
  'live rank': 'live rank check',
  'Search Console average': 'Search Console average',
  rank_absolute: 'live check, all elements',
  configuration: 'configuration',
};

export function SourceTag({
  source,
  className,
  label,
}: {
  source: Source;
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1.5 text-[11px] leading-none font-normal',
        className,
      )}
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-[2px]', SWATCH[source])} />
      {label ?? WORDS[source]}
    </span>
  );
}
