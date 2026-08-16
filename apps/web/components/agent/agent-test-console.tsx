'use client';

import { useState, useTransition } from 'react';
import { Bot, ExternalLink, LoaderCircle, Plus, Send, UserRound } from 'lucide-react';

import {
  createAgentTestConversationAction,
  sendAgentTestMessageAction,
} from '@/app/dashboard/ai-front-office/test-agent/actions';
import type { AgentTestTurn } from '@/lib/agent/types';
import {
  beginSubmission,
  pendingSubmissionAfterFailure,
  type PendingSubmission,
} from '@/lib/agent/submission';

interface TranscriptMessage {
  readonly body: string;
  readonly role: 'assistant' | 'customer';
  readonly turn?: AgentTestTurn;
}

interface AgentTestConsoleProps {
  readonly available: boolean;
  readonly hasPublishedKnowledge: boolean;
}

export function AgentTestConsole({ available, hasPublishedKnowledge }: AgentTestConsoleProps) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<readonly TranscriptMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null);
  const [isPending, startTransition] = useTransition();

  function startConversation() {
    setNotice(null);
    startTransition(async () => {
      const state = await createAgentTestConversationAction();
      if (state.status !== 'success' || !state.conversationId) {
        setNotice(state.message ?? 'A new test conversation could not be created.');
        return;
      }
      setConversationId(state.conversationId);
      setMessages([]);
      setDraft('');
      setPendingSubmission(null);
    });
  }

  function sendMessage() {
    const message = draft.trim();
    if (!conversationId || !message) return;
    const submission = beginSubmission(pendingSubmission, message, () => crypto.randomUUID());
    setPendingSubmission(submission);
    setNotice(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('conversationId', conversationId);
      formData.set('message', message);
      formData.set('idempotencyKey', submission.idempotencyKey);
      const state = await sendAgentTestMessageAction(formData);
      const turn = state.turn;
      const submittedMessage = state.submittedMessage;
      if (state.status !== 'success' || !turn || !submittedMessage) {
        setNotice(state.message ?? 'The Agent Test could not be completed.');
        setPendingSubmission(
          pendingSubmissionAfterFailure(submission, state.submissionDisposition ?? 'reuse-key'),
        );
        return;
      }
      setMessages((current) => [
        ...current,
        { body: submittedMessage, role: 'customer' },
        { body: turn.text, role: 'assistant', turn },
      ]);
      setDraft('');
      setPendingSubmission(null);
    });
  }

  if (!available) {
    return (
      <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950">
        <p className="font-semibold">OpenAI is not configured</p>
        <p className="mt-1 text-amber-900">
          Add the server-only <code>OPENAI_API_KEY</code> before running an Agent Test. Nothing is
          sent to an AI provider until this environment variable is configured.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-border bg-white shadow-sm">
      <div className="flex flex-col gap-4 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold text-ink">Test conversation</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This is a safe internal simulation. It never sends messages to customers.
          </p>
        </div>
        <button
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-ink px-3 py-2 text-sm font-semibold text-ink transition hover:bg-ink hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isPending}
          onClick={startConversation}
          type="button"
        >
          <Plus aria-hidden="true" className="size-4" /> New test conversation
        </button>
      </div>

      {!hasPublishedKnowledge ? (
        <p className="mx-5 mt-5 rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
          No published business knowledge is available yet. The agent can still respond safely and
          request a handoff, but it will not invent business facts.
        </p>
      ) : null}

      <div className="min-h-80 space-y-5 p-5" aria-live="polite">
        {!conversationId ? (
          <div className="flex min-h-64 flex-col items-center justify-center text-center">
            <Bot aria-hidden="true" className="size-8 text-primary" />
            <p className="mt-3 font-semibold text-ink">Start a private test</p>
            <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
              Try customer questions, factual knowledge retrieval, or a human-handoff scenario.
            </p>
          </div>
        ) : messages.length ? (
          messages.map((message, index) => (
            <article
              className={
                message.role === 'customer'
                  ? 'ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm text-primary-foreground'
                  : 'max-w-[85%] rounded-2xl rounded-bl-md bg-muted px-4 py-3 text-sm text-ink'
              }
              key={`${message.role}-${index}`}
            >
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold opacity-75">
                {message.role === 'customer' ? (
                  <UserRound aria-hidden="true" className="size-3.5" />
                ) : (
                  <Bot aria-hidden="true" className="size-3.5" />
                )}
                {message.role === 'customer' ? 'Customer simulation' : 'Avenlyo'}
              </div>
              <p className="whitespace-pre-wrap leading-6">{message.body}</p>
              {message.turn ? <TurnDetails turn={message.turn} /> : null}
            </article>
          ))
        ) : (
          <p className="pt-20 text-center text-sm text-muted-foreground">
            Your new test is ready. Send a customer message to begin.
          </p>
        )}
      </div>

      {notice ? <p className="mx-5 mb-4 text-sm text-red-700">{notice}</p> : null}
      <div className="border-t border-border p-4">
        <label className="sr-only" htmlFor="agent-test-message">
          Customer test message
        </label>
        <div className="flex gap-2">
          <textarea
            className="avenlyo-textarea min-h-11 flex-1 resize-y py-2.5"
            disabled={!conversationId || isPending}
            id="agent-test-message"
            maxLength={4000}
            onChange={(event) => {
              setDraft(event.target.value);
              if (pendingSubmission?.message !== event.target.value.trim())
                setPendingSubmission(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
            placeholder={
              conversationId ? 'Type a customer message...' : 'Start a test conversation first'
            }
            value={draft}
          />
          <button
            className="self-end rounded-lg bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!conversationId || !draft.trim() || isPending}
            onClick={sendMessage}
            type="button"
          >
            {isPending ? (
              <LoaderCircle aria-label="Running" className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            <span className="sr-only">Send message</span>
          </button>
        </div>
      </div>
    </section>
  );
}

function TurnDetails({ turn }: { turn: AgentTestTurn }) {
  return (
    <div className="mt-3 border-t border-ink/10 pt-3 text-xs text-muted-foreground">
      <p>Model: {turn.model}</p>
      {turn.tools.length ? (
        <p className="mt-1">
          Tools: {turn.tools.map((tool) => `${tool.name} (${tool.status})`).join(', ')}
        </p>
      ) : null}
      {turn.handoffRequested ? (
        <p className="mt-1 font-semibold text-amber-800">Human handoff requested</p>
      ) : null}
      {turn.sources.length ? (
        <ul className="mt-2 space-y-1">
          {turn.sources.map((source) => (
            <li key={`${source.title}-${source.sourceUrl ?? ''}`}>
              {source.sourceUrl ? (
                <a
                  className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                  href={source.sourceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {source.title} <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              ) : (
                source.title
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
