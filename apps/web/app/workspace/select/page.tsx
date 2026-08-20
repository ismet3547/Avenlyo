import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { workspaceOptionKey } from '@/lib/workspace/selection';
import { loadWorkspaceOptions } from '@/lib/workspace/service';

import { selectWorkspaceAction } from './actions';

/**
 * Workspace selector.
 *
 * Only contexts returned by the trusted membership lookup are listed, so this page cannot offer a
 * choice the caller does not hold. A user with a single workspace never reaches it.
 */
interface SelectPageProps {
  readonly searchParams: Promise<{ error?: string }>;
}

export default async function WorkspaceSelectPage({ searchParams }: SelectPageProps) {
  const auth = await getRequiredAuthContext();
  if (!auth) {
    redirect('/auth/sign-in');
  }

  const { error } = await searchParams;
  const options = (await loadWorkspaceOptions(auth.supabase)).filter(
    (option) => option.onboardingStatus === 'completed',
  );

  if (options.length === 0) {
    redirect('/auth/continue');
  }

  const byOrganization = new Map<string, typeof options>();
  for (const option of options) {
    const existing = byOrganization.get(option.organizationId) ?? [];
    existing.push(option);
    byOrganization.set(option.organizationId, existing);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-12">
      <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Choose a workspace
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        You have access to more than one workspace. Pick the one you want to work in; you can switch
        at any time.
      </p>

      {error ? (
        <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950">
          That workspace is no longer available to you. Choose one from the list below.
        </p>
      ) : null}

      <div className="mt-8 space-y-6">
        {[...byOrganization.values()].map((group) => {
          const first = group[0];
          if (!first) return null;
          return (
            <section
              className="rounded-xl border border-border bg-white p-5"
              key={first.organizationId}
            >
              <h2 className="font-display text-lg font-semibold text-ink">
                {first.organizationName}
              </h2>
              <p className="text-xs font-medium uppercase tracking-wide text-primary">
                {first.role}
              </p>
              <ul className="mt-3 space-y-2">
                {group.map((option) => (
                  <li key={workspaceOptionKey(option)}>
                    <form action={selectWorkspaceAction}>
                      <input name="workspaceKey" type="hidden" value={workspaceOptionKey(option)} />
                      <Button className="w-full justify-between" type="submit" variant="outline">
                        <span>{option.locationName ?? 'Workspace'}</span>
                        <span aria-hidden>→</span>
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}
