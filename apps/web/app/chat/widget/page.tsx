'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';

interface ChatMessage {
  id: string;
  body: string | null;
  direction: string;
  authorType: string;
  createdAt: string;
}

export default function HostedChatWidget() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-white" />}>
      <HostedChatWidgetContents />
    </Suspense>
  );
}

function HostedChatWidgetContents() {
  const search = useSearchParams();
  const api = useMemo(() => search.get('api') ?? '', [search]);
  const parentOrigin = useMemo(() => search.get('origin') ?? '', [search]);
  const token = useMemo(() => search.get('token'), [search]);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const welcome = search.get('welcome');
    if (!token || !parentOrigin) setError('Chat is unavailable right now.');
    else if (welcome)
      setMessages([
        {
          id: 'welcome',
          body: welcome,
          direction: 'outbound',
          authorType: 'ai',
          createdAt: new Date().toISOString(),
        },
      ]);
  }, [parentOrigin, search, token]);

  useEffect(() => {
    if (!token || !api || !parentOrigin) return;
    const poll = () =>
      void fetch(
        `${api}/v1/chat/messages?token=${encodeURIComponent(token)}&parentOrigin=${encodeURIComponent(parentOrigin)}`,
        { method: 'GET' },
      )
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{ messages: ChatMessage[] }>)
            : Promise.reject(new Error('poll')),
        )
        .then((result) => setMessages(result.messages))
        .catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => window.clearInterval(timer);
  }, [api, parentOrigin, token]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !body.trim()) return;
    const content = body.trim();
    setBody('');
    const response = await fetch(`${api}/v1/chat/messages`, {
      body: JSON.stringify({
        body: content,
        clientMessageId: crypto.randomUUID(),
        parentOrigin,
        token,
      }),
      headers: { 'Content-Type': 'text/plain' },
      method: 'POST',
    });
    if (!response.ok) setError('Your message could not be sent.');
  }

  return (
    <main className="flex min-h-screen flex-col bg-white p-4 text-sm text-ink">
      <header>
        <p className="font-semibold">Avenlyo</p>
        <p className="mt-1 text-xs text-muted-foreground">Chat with the team</p>
      </header>
      <div className="mt-4 flex-1 space-y-2 overflow-auto">
        {messages.map((message) => (
          <p
            className={
              message.direction === 'inbound'
                ? 'ml-8 rounded-xl bg-muted p-3'
                : 'mr-8 rounded-xl bg-primary p-3 text-primary-foreground'
            }
            key={message.id}
          >
            {message.body}
          </p>
        ))}
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          void send(event);
        }}
      >
        <input
          className="min-w-0 flex-1 rounded-md border border-border px-3 py-2"
          maxLength={2000}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Type a message"
          value={body}
        />
        <button
          className="rounded-md bg-primary px-3 py-2 font-semibold text-primary-foreground"
          type="submit"
        >
          Send
        </button>
      </form>
    </main>
  );
}
