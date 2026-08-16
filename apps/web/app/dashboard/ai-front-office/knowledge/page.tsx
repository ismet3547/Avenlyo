import Link from 'next/link';
import { BookOpenCheck, FileText, Globe2, ShieldCheck } from 'lucide-react';

import { ImportWebsiteForm } from '@/components/knowledge/import-website-form';
import { KnowledgeSearch } from '@/components/knowledge/knowledge-search';
import { loadKnowledgeOverview } from '@/lib/knowledge/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

function importStatusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

export default async function KnowledgePage() {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';
  const imports = auth ? await loadKnowledgeOverview(auth.supabase) : [];
  const latestImport = imports[0];
  const publishedDocuments = imports.reduce((sum, item) => sum + item.readyDocuments, 0);
  const draftDocuments = imports.reduce((sum, item) => sum + item.draftDocuments, 0);

  return (
    <section className="max-w-5xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        AI Front Office / Knowledge
      </p>
      <div className="mt-3 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
            Business Knowledge
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Import public website pages, review every draft, then publish the source material your
            future AI Front Office can retrieve.
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900">
          <ShieldCheck aria-hidden="true" className="size-3.5" /> Human review required
        </div>
      </div>

      <section className="mt-8 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Globe2 className="size-5" />
          </div>
          <div>
            <h2 className="font-semibold text-ink">Website source</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Static public HTML only. New pages are saved as drafts and never become searchable
              until an owner or admin publishes them.
            </p>
          </div>
        </div>
        {canManage ? (
          <ImportWebsiteForm defaultUrl={workspace.websiteUrl ?? ''} disabled={false} />
        ) : (
          <p className="mt-5 rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
            Only organization owners and admins can import or publish business knowledge.
          </p>
        )}
      </section>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <section className="rounded-xl border border-border bg-white p-5 shadow-sm">
          <BookOpenCheck className="size-5 text-primary" />
          <p className="mt-4 text-2xl font-semibold tracking-tight text-ink">
            {publishedDocuments}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Published documents</p>
        </section>
        <section className="rounded-xl border border-border bg-white p-5 shadow-sm">
          <FileText className="size-5 text-amber-600" />
          <p className="mt-4 text-2xl font-semibold tracking-tight text-ink">{draftDocuments}</p>
          <p className="mt-1 text-sm text-muted-foreground">Draft documents</p>
        </section>
        <section className="rounded-xl border border-border bg-white p-5 shadow-sm">
          <Globe2 className="size-5 text-sky-600" />
          <p className="mt-4 text-sm font-semibold capitalize text-ink">
            {latestImport ? importStatusLabel(latestImport.status) : 'No imports yet'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Last import</p>
        </section>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-xl border border-border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Import history</h2>
          {imports.length ? (
            <ul className="mt-4 divide-y divide-border">
              {imports.map((item) => (
                <li className="py-4 first:pt-0 last:pb-0" key={item.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">{item.rootUrl}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {item.pagesDiscovered} pages discovered · {item.pagesImported} ready for
                        review
                      </p>
                      {item.errorMessage ? (
                        <p className="mt-2 text-sm text-red-700">{item.errorMessage}</p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium capitalize text-muted-foreground">
                        {importStatusLabel(item.status)}
                      </span>
                      {canManage ? (
                        <Link
                          className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
                          href={`/dashboard/ai-front-office/knowledge/imports/${item.id}`}
                        >
                          Review
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              No website knowledge has been imported. Start with the public pages customers use
              most.
            </p>
          )}
        </section>
        <KnowledgeSearch disabled={!canManage || publishedDocuments === 0} />
      </div>
    </section>
  );
}
