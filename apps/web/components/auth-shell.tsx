import Link from 'next/link';
import type { ReactNode } from 'react';

interface AuthShellProps {
  children: ReactNode;
  description: string;
  title: string;
}

export function AuthShell({ children, description, title }: AuthShellProps) {
  return (
    <main className="grid min-h-screen bg-white lg:grid-cols-[minmax(22rem,0.8fr)_1.2fr]">
      <section className="flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-md">
          <Link className="inline-flex items-center gap-2 text-sm font-semibold text-ink" href="/">
            <span aria-hidden="true" className="size-2.5 rounded-full bg-primary shadow-signal" />
            Avenlyo
          </Link>
          <p className="mt-14 font-utility text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            Secure workspace access
          </p>
          <h1 className="mt-3 font-display text-4xl font-semibold tracking-[-0.04em] text-ink">
            {title}
          </h1>
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
          {children}
        </div>
      </section>

      <aside className="auth-signal-panel relative hidden overflow-hidden p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <p className="font-utility text-xs font-semibold uppercase tracking-[0.22em] text-white/60">
          AI Front Office
        </p>
        <div className="relative z-10 max-w-xl">
          <div className="mb-10 flex items-center gap-3" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((item) => (
              <span className="block h-px flex-1 bg-white/30 first:bg-mint" key={item} />
            ))}
          </div>
          <p className="font-display text-4xl font-medium leading-tight tracking-[-0.03em]">
            A calm handoff from first contact to a ready front office.
          </p>
          <p className="mt-5 max-w-md text-base leading-7 text-white/65">
            Set up the essentials once. Avenlyo keeps the workspace organized around your business.
          </p>
        </div>
      </aside>
    </main>
  );
}
