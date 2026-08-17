import { Code2, Globe2, MessageSquareText } from 'lucide-react';

import { saveWebChatWidgetAction } from './actions';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { env } from '@/lib/supabase/config';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { messagingRpc } from '@/lib/messaging/service';

function origins(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((origin): origin is string => typeof origin === 'string').join('\n')
    : '';
}

export default async function WebChatPage() {
  const workspace = await requireCompletedWorkspace();
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';
  const auth = await getRequiredAuthContext();
  const widget =
    canManage && auth && workspace.locationId
      ? (
          await messagingRpc(auth.supabase)('get_my_web_chat_widget', {
            target_location_id: workspace.locationId,
          })
        ).data?.[0]
      : null;
  const appUrl = env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const apiUrl = env.NEXT_PUBLIC_AVENLYO_API_URL ?? 'http://localhost:4000';
  const snippet = widget
    ? `<script src="${appUrl}/chat-widget.js" data-avenlyo-key="${widget.public_key}" data-avenlyo-api-url="${apiUrl}" async></script>`
    : 'Save an allowed origin to generate an embed snippet.';

  if (!canManage || !workspace.locationId) {
    return (
      <section className="max-w-3xl">
        <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          AI Front Office / Web Chat
        </p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
          Web chat is owner/admin-only
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Choose a location and ask an organization owner or admin to configure the approved website
          origins.
        </p>
      </section>
    );
  }

  return (
    <section className="max-w-4xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        AI Front Office / Web Chat
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        Website chat widget
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
        The first-party iframe uses an opaque, expiring visitor token and accepts messages only from
        the exact HTTPS origins configured here.
      </p>
      <form
        action={saveWebChatWidgetAction}
        className="mt-8 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6"
      >
        <input name="locationId" type="hidden" value={workspace.locationId} />
        <label className="flex items-center gap-3 text-sm font-semibold text-ink">
          <input defaultChecked={widget?.enabled ?? false} name="enabled" type="checkbox" /> Enable
          website chat for {workspace.locationName ?? 'this location'}
        </label>
        <label className="mt-6 block text-sm font-semibold text-ink" htmlFor="allowed-origins">
          Allowed origins
        </label>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          One exact HTTPS origin per line. `http://localhost:3000` is supported for local
          development only.
        </p>
        <textarea
          className="avenlyo-textarea mt-2 min-h-28"
          defaultValue={origins(widget?.allowed_origins)}
          id="allowed-origins"
          name="allowedOrigins"
          placeholder={'https://www.example.com\nhttps://booking.example.com'}
          required
        />
        <label className="mt-6 block text-sm font-semibold text-ink" htmlFor="welcome-message">
          Welcome message
        </label>
        <textarea
          className="avenlyo-textarea mt-2 min-h-20"
          defaultValue={widget?.welcome_message ?? ''}
          id="welcome-message"
          maxLength={500}
          name="welcomeMessage"
          placeholder="How can we help?"
        />
        <button
          className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
          type="submit"
        >
          Save web chat settings
        </button>
      </form>
      <section className="mt-6 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Code2 aria-hidden="true" className="size-5 text-primary" />
          <h2 className="text-lg font-semibold text-ink">Embed snippet</h2>
        </div>
        <pre className="mt-4 overflow-x-auto rounded-xl bg-ink p-4 text-xs leading-6 text-slate-100">
          <code>{snippet}</code>
        </pre>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <p className="rounded-xl bg-muted p-4 text-sm leading-6 text-muted-foreground">
            <Globe2 aria-hidden="true" className="mb-2 size-4 text-primary" />
            No browser Supabase access or provider credentials are embedded.
          </p>
          <p className="rounded-xl bg-muted p-4 text-sm leading-6 text-muted-foreground">
            <MessageSquareText aria-hidden="true" className="mb-2 size-4 text-primary" />
            Visitors use bounded polling; staff work through the authenticated Inbox.
          </p>
        </div>
      </section>
    </section>
  );
}
