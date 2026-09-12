import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">Not found</h1>
      <p className="text-muted-foreground text-sm leading-relaxed">
        There is nothing at this address.
      </p>
      <Link href="/" className="w-fit rounded-md border px-3 py-1.5 text-sm">
        All properties
      </Link>
    </main>
  );
}
