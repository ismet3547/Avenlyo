import Link from 'next/link';
import type { ReactNode } from 'react';

import { signOutAction } from '@/app/auth/actions';
import {
  onboardingStepRoutes,
  onboardingSteps,
  type ActiveOnboardingStep,
} from '@/lib/onboarding/routing';

const labels: Record<ActiveOnboardingStep, string> = {
  industry: 'Industry',
  business: 'Business',
  location: 'Location',
  website: 'Website',
  review: 'Review',
};

interface OnboardingShellProps {
  activeStep: ActiveOnboardingStep;
  children: ReactNode;
  persistedStep: ActiveOnboardingStep;
}

export function OnboardingShell({ activeStep, children, persistedStep }: OnboardingShellProps) {
  const activeIndex = onboardingSteps.indexOf(activeStep);
  const persistedIndex = onboardingSteps.indexOf(persistedStep);

  return (
    <main className="min-h-screen bg-[#f5f7fb]">
      <header className="border-b border-slate-200/80 bg-white/90 px-5 py-4 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <Link className="inline-flex items-center gap-2 text-sm font-semibold text-ink" href="/">
            <span aria-hidden="true" className="size-2.5 rounded-full bg-primary shadow-signal" />
            Avenlyo
          </Link>
          <form action={signOutAction}>
            <button
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              type="submit"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-14 lg:py-14">
        <aside>
          <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Workspace setup
          </p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Five focused steps. Your progress is saved after each one.
          </p>

          <ol
            className="mt-6 grid grid-cols-5 gap-2 lg:block lg:space-y-1"
            aria-label="Setup progress"
          >
            {onboardingSteps.map((step, index) => {
              const isActive = index === activeIndex;
              const isAvailable = index <= persistedIndex;
              const content = (
                <>
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-full font-utility text-[11px] font-semibold ${
                      isActive
                        ? 'bg-primary text-white shadow-signal'
                        : index < persistedIndex
                          ? 'bg-ink text-white'
                          : 'border border-slate-300 bg-white text-slate-500'
                    }`}
                  >
                    {index + 1}
                  </span>
                  <span className="hidden text-sm font-medium lg:inline">{labels[step]}</span>
                </>
              );

              return (
                <li className="relative" key={step}>
                  {isAvailable ? (
                    <Link
                      aria-current={isActive ? 'step' : undefined}
                      className={`flex items-center gap-3 rounded-xl p-2 transition ${
                        isActive
                          ? 'bg-white text-ink shadow-sm'
                          : 'text-muted-foreground hover:text-ink'
                      }`}
                      href={onboardingStepRoutes[step]}
                    >
                      {content}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-3 p-2 text-slate-400">{content}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </aside>

        <section className="min-w-0 rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-panel sm:p-9 lg:p-12">
          {children}
        </section>
      </div>
    </main>
  );
}
