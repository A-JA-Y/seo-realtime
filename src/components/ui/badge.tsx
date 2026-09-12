import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/*
 * Status colours are reserved (good / warning / serious / critical) and never
 * reused as a series colour, and each ships with a word rather than relying on
 * hue — a colourblind reader and a greyscale print both need the label.
 */
const badge = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground border-transparent',
        outline: 'text-foreground',
        good: 'border-transparent bg-[#0ca30c]/12 text-[#0a7d0a] dark:text-[#4ec44e]',
        warning: 'border-transparent bg-[#fab219]/18 text-[#8a5d00] dark:text-[#fab219]',
        serious: 'border-transparent bg-[#ec835a]/18 text-[#a1471f] dark:text-[#ec835a]',
        critical: 'border-transparent bg-[#d03b3b]/14 text-[#a82c2c] dark:text-[#e87070]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badge>['tone']>;

export function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
