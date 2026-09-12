import { ArrowDown, ArrowUp, Minus } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * A movement, with the arrow pointing the way the RANK moved and the colour
 * saying whether that was good.
 *
 * Rank is inverted: 8 → 3 is a rise of five places but a numeric decrease. The
 * arrow follows the visual metaphor (up = better position), the sign follows
 * the number, and the two are reconciled by `lowerIsBetter` so neither ever
 * silently flips. Colour never carries this alone — the arrow shape and the
 * signed number both encode it.
 *
 * A null delta prints "no baseline", not a zero. Zero is the claim "it did not
 * move"; null is "we cannot say", and the difference matters to someone
 * deciding whether to act.
 */
export function Delta({
  value,
  lowerIsBetter = true,
  suffix,
  className,
}: {
  value: number | null;
  lowerIsBetter?: boolean;
  suffix?: string;
  className?: string;
}) {
  if (value === null) {
    return (
      <span className={cn('text-muted-foreground text-xs', className)}>
        no baseline
      </span>
    );
  }

  const rounded = Math.round(value * 10) / 10;

  if (rounded === 0) {
    return (
      <span className={cn('text-muted-foreground inline-flex items-center gap-1 text-xs', className)}>
        <Minus className="size-3" aria-hidden />
        no change{suffix ? ` ${suffix}` : ''}
      </span>
    );
  }

  const improved = lowerIsBetter ? rounded < 0 : rounded > 0;
  // Rank improving means the number went down but the position went UP.
  const arrowUp = lowerIsBetter ? rounded < 0 : rounded > 0;
  const Arrow = arrowUp ? ArrowUp : ArrowDown;
  const magnitude = Math.abs(rounded);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        improved ? 'text-[#0a7d0a] dark:text-[#4ec44e]' : 'text-[#a82c2c] dark:text-[#e87070]',
        className,
      )}
      title={`${improved ? 'Improved' : 'Worsened'} by ${magnitude}${suffix ? ` ${suffix}` : ''}`}
    >
      <Arrow className="size-3" aria-hidden />
      {magnitude}
      {suffix ? <span className="text-muted-foreground font-normal">{suffix}</span> : null}
    </span>
  );
}
