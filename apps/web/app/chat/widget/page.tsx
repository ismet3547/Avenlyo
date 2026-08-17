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
  const parentOrigin = useMemo(() => search.get('parentOrigin') ?? '', [search]);
  const [token, setToken] = useState<string | null>(null);
  const [welcome, setWelcome] = useState('');
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const expectedOrigin = parentOrigin;
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== expectedOrigin || event.source !== window.parent) return;
      const value = event.data;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const payload = value as { type?: unknown; token?: unknown; welcomeMessage?: unknown };
      if (
        payload.type !== 'avenlyo.chat.initialize' ||
        typeof payload.token !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(payload.token)
      ) {
        return;
      }
      setToken(payload.token);
      setWelcome(typeof payload.welcomeMessage === 'string' ? payload.welcomeMessage : '');
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [parentOrigin]);

  useEffect(() => {
    if (!token) return;
    if (welcome)
      setMessages([
        {
          id: 'welcome',
          body: welcome,
          direction: 'outbound',
          authorType: 'ai',
          createdAt: new Date().toISOString(),
        },
      ]);
  }, [token, welcome]);

  useEffect(() => {
    if (!token || !api) return;
    const poll = () =>
      void fetch(`${api}/v1/chat/messages`, {
        headers: { 'X-Avenlyo-Chat-Token': token },
        method: 'GET',
      })
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
  }, [api, token]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !body.trim()) return;
    const content = body.trim();
    setBody('');
    const response = await fetch(`${api}/v1/chat/messages`, {
      body: JSON.stringify({
        body: content,
        clientMessageId: crypto.randomUUID(),
      }),
      headers: { 'Content-Type': 'text/plain', 'X-Avenlyo-Chat-Token': token },
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
