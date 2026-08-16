import Link from 'next/link';

import { Button } from '@/components/ui/button';

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl items-center px-6 py-16">
      <section className="max-w-3xl">
        <p className="mb-6 text-sm font-semibold uppercase tracking-[0.22em] text-primary">
          Avenlyo
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-6xl">
          AI Front Office for Service Businesses
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
          A calm, capable first point of contact for the conversations that keep a service business
          moving.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/auth/sign-in">Sign in</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard">View dashboard shell</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
