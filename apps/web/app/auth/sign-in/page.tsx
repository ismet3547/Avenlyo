import Link from 'next/link';

import { Button } from '@/components/ui/button';

export default function SignInPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6 py-16">
      <section className="w-full rounded-xl border bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold text-primary">Avenlyo</p>
        <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Supabase Auth will be connected here once public Supabase environment variables are
          configured.
        </p>
        <Button asChild className="mt-6 w-full">
          <Link href="/dashboard">Continue to dashboard shell</Link>
        </Button>
      </section>
    </main>
  );
}
