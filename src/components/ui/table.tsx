import { cn } from '@/lib/utils';

/** A table that scrolls horizontally on a phone rather than squashing. */
export function TableWrap({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('w-full overflow-x-auto', className)} {...props} />;
}

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return <table className={cn('w-full caption-bottom text-sm', className)} {...props} />;
}

export function Th({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'text-muted-foreground px-3 py-2 text-left text-xs font-medium whitespace-nowrap',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('border-t px-3 py-2 align-middle', className)} {...props} />;
}
