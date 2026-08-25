import { veterinaryPack } from '@avenlyo/industries';
import { describe, expect, it, vi } from 'vitest';

import type { AgentToolServices, RuntimeKnowledgeSearchResult, ToolExecutor } from '../tools/types';
import { ControlledToolExecutor } from '../tools/executor';

import { requiresBusinessKnowledge } from './business-knowledge-predicate';
import { AgentRuntime } from './runtime';
import type {
  AgentProvider,
  AgentProviderResult,
  AgentTurnResult,
  KnowledgeSource,
} from './types';

/**
 * The grounding guard: a model that declines to search must not get to assert business facts.
 *
 * Staging produced exactly that. Asked how to register, the model made no tool call and replied
 * that no registration link existed -- about a site whose registration page had been published
 * minutes earlier. The runtime's no-knowledge guard only fires once a search has been attempted,
 * so skipping the search skipped the guard.
 *
 * The two halves asserted throughout: a business question can no longer be answered ungrounded,
 * and ordinary conversation is untouched.
 */

const UNKNOWN = "I don't have reliable information about that yet. I can ask the team to help.";

function source(similarity: number, title: string): KnowledgeSource {
  return {
    content: `Published body for ${title}.`,
    similarity,
    sourceUrl: `https://clinic.test/${title.toLowerCase()}`,
    title,
  };
}

function result(text: string, toolCalls: AgentProviderResult['toolCalls'] = []): AgentProviderResult {
  return { text, toolCalls };
}

function provider(script: readonly AgentProviderResult[]): AgentProvider {
  let index = 0;
  return {
    id: 'fake',
    runTurn: () => Promise.resolve(script[index++] ?? result('done')),
  };
}

/** A tool executor whose runtime search returns whatever the test dictates, and counts calls. */
function executor(input: {
  readonly forced?: readonly KnowledgeSource[];
  readonly forcedFails?: boolean;
  readonly modelSearch?: readonly KnowledgeSource[];
}) {
  const calls = { forced: 0, model: 0 };
  const services = {
    requestHumanHelp: vi.fn().mockResolvedValue({ created: true }),
    searchBusinessKnowledge: vi.fn(() => {
      calls.model += 1;
      return Promise.resolve(input.modelSearch ?? []);
    }),
  } as unknown as AgentToolServices;
  const real = new ControlledToolExecutor(veterinaryPack, services);
  const wrapper: ToolExecutor = {
    execute: (call, context) => real.execute(call, context),
    searchKnowledgeForRuntime: (): Promise<RuntimeKnowledgeSearchResult> => {
      calls.forced += 1;
      const sources = input.forcedFails ? [] : (input.forced ?? []);
      return Promise.resolve({
        diagnostic: {
          knowledgeOutcome: input.forcedFails
            ? 'failed'
            : sources.length
              ? 'reliable'
              : 'empty_or_unreliable',
          matches: [],
          origin: 'runtime_forced_search',
          qualifiedCount: sources.length,
          queryLength: 19,
          queryMatchesCustomerTurn: true,
          retrievedCount: sources.length,
          toolCallId: 'runtime-forced-search',
        },
        failed: input.forcedFails === true,
        sources,
      });
    },
    tools: real.tools,
  };
  return { calls, executor: wrapper };
}

function turn(
  script: readonly AgentProviderResult[],
  executorInput: Parameters<typeof executor>[0],
  userMessage: string,
): { calls: { forced: number; model: number }; run: () => Promise<AgentTurnResult> } {
  const { calls, executor: tools } = executor(executorInput);
  const runtime = new AgentRuntime(provider(script), tools, 'test-model');
  return {
    calls,
    run: () =>
      runtime.runTurn({
        business: {
          address: null,
          businessHours: 'Mon-Fri 09:00-17:00',
          locationName: 'Main location',
          name: 'oddrail',
          phone: null,
          timezone: 'UTC',
          website: 'https://petrandevu.com',
        },
        context: {
          conversationId: '00000000-0000-4000-8000-000000000001',
          industryId: 'veterinary',
          locationId: '00000000-0000-4000-8000-000000000002',
          mode: 'test',
          organizationId: '00000000-0000-4000-8000-000000000003',
        },
        history: [],
        industry: veterinaryPack,
        userMessage,
      }),
  };
}

describe('a business question answered without searching', () => {
  it('is grounded by a runtime search and then allowed', async () => {
    // Staging case 1: the model asserts an answer with zero tool calls.
    const { calls, run } = turn(
      [
        result('Kayıt olabileceğiniz bir bağlantı bulunmuyor.'),
        result('Hesap Oluştur sayfasından kayıt olabilirsiniz.'),
      ],
      { forced: [source(0.611, 'HesapOlustur')] },
      'Nasıl kayıt olucam?',
    );

    const answer = await run();

    expect(calls.forced).toBe(1);
    expect(answer.text).toBe('Hesap Oluştur sayfasından kayıt olabilirsiniz.');
    expect(answer.sources.map((entry) => entry.title)).toEqual(['HesapOlustur']);
    expect(answer.knowledgeDiagnostics?.[0]?.origin).toBe('runtime_forced_search');
  });

  it('is refused outright when the corpus does not support it', async () => {
    // Staging case 2: the ungrounded answer is discarded, not softened or partially kept.
    const { calls, run } = turn(
      [result('Kayıt olabileceğiniz bir bağlantı bulunmuyor.')],
      { forced: [] },
      'Nasıl kayıt olucam?',
    );

    const answer = await run();

    expect(calls.forced).toBe(1);
    expect(answer.text).toBe(UNKNOWN);
    expect(answer.text).not.toContain('bulunmuyor');
    expect(answer.sources).toEqual([]);
  });

  it('is grounded for a service question too', async () => {
    const { calls, run } = turn(
      [result('We do not offer that.'), result('Pet otel ve kedi bakıcısı hizmetleri var.')],
      { forced: [source(0.66, 'Hizmetler')] },
      'Hangi hizmetleri sunuyorsunuz?',
    );

    const answer = await run();

    expect(calls.forced).toBe(1);
    expect(answer.text).toBe('Pet otel ve kedi bakıcısı hizmetleri var.');
  });

  it('does not hallucinate an unsupported business fact', async () => {
    const { run } = turn(
      [result('Evet, dizüstü bilgisayar tamiri yapıyoruz ve 2 yıl garanti veriyoruz.')],
      { forced: [] },
      'Dizüstü bilgisayar tamiri için fiyatınız nedir?',
    );

    const answer = await run();

    expect(answer.text).toBe(UNKNOWN);
  });

  it('refuses rather than answers when no knowledge service exists at all', async () => {
    const { executor: tools } = executor({});
    const withoutSearch: ToolExecutor = {
      execute: (call, context) => tools.execute(call, context),
      tools: tools.tools,
    };
    const runtime = new AgentRuntime(
      provider([result('Kayıt bağlantısı yok.')]),
      withoutSearch,
      'test-model',
    );

    const answer = await runtime.runTurn({
      business: {
        address: null,
        businessHours: null,
        locationName: 'Main',
        name: 'oddrail',
        phone: null,
        timezone: 'UTC',
        website: null,
      },
      context: {
        conversationId: '00000000-0000-4000-8000-000000000001',
        industryId: 'veterinary',
        locationId: null,
        mode: 'test',
        organizationId: '00000000-0000-4000-8000-000000000003',
      },
      history: [],
      industry: veterinaryPack,
      userMessage: 'Nasıl kayıt olucam?',
    });

    expect(answer.text).toBe(UNKNOWN);
  });
});

describe('ordinary conversation is untouched', () => {
  it('lets a greeting through without any search', async () => {
    const { calls, run } = turn([result('Merhaba! Size nasıl yardımcı olabilirim?')], {}, 'Merhaba');

    const answer = await run();

    expect(calls.forced).toBe(0);
    expect(answer.text).toBe('Merhaba! Size nasıl yardımcı olabilirim?');
  });

  it('lets thanks through without any search', async () => {
    const { calls, run } = turn([result('Rica ederim!')], {}, 'Teşekkürler');

    const answer = await run();

    expect(calls.forced).toBe(0);
    expect(answer.text).toBe('Rica ederim!');
  });

  it('lets a configured business-hours answer through without a website search', async () => {
    // Hours come from authoritative business configuration, which the prompt already carries.
    // Forcing a crawled-page search for them would be both wasteful and a worse source.
    const { calls, run } = turn(
      [result('Hafta içi 09:00-17:00 arası açığız.')],
      {},
      'Çalışma saatleriniz nedir?',
    );

    const answer = await run();

    expect(calls.forced).toBe(0);
    expect(answer.text).toBe('Hafta içi 09:00-17:00 arası açığız.');
  });
});

describe('the guard never stacks on the tool path', () => {
  it('does not force a search when the model already searched and found something', async () => {
    const { calls, run } = turn(
      [
        result('', [
          {
            arguments: JSON.stringify({ query: 'kayit olma sayfasi' }),
            callId: 'fc_1',
            name: 'search_business_knowledge',
          },
        ]),
        result('Hesap Oluştur sayfasından kayıt olabilirsiniz.'),
      ],
      { modelSearch: [source(0.7, 'HesapOlustur')] },
      'Nasıl kayıt olucam?',
    );

    const answer = await run();

    expect(calls.forced).toBe(0);
    expect(answer.text).toBe('Hesap Oluştur sayfasından kayıt olabilirsiniz.');
  });

  it('does not force a search when the model searched and the existing recovery ran', async () => {
    // The model searched, its query was flat, and the executor's own trusted-query recovery
    // handled it. The guard must stay out of the way -- it only exists for turns with no search.
    const { calls, run } = turn(
      [
        result('', [
          {
            arguments: JSON.stringify({ query: 'a rewritten registration question' }),
            callId: 'fc_1',
            name: 'search_business_knowledge',
          },
        ]),
        result('Bir şey bulamadım.'),
      ],
      { modelSearch: [source(0.46, 'A'), source(0.44, 'B')] },
      'Nasıl kayıt olucam?',
    );

    const answer = await run();

    expect(calls.forced).toBe(0);
    // The tool path's own outcome still governs the reply.
    expect(answer.text).toBe(UNKNOWN);
    expect(answer.knowledgeDiagnostics?.[0]?.origin).toBe('trusted_query_retry');
  });

  it('bounds the whole turn to one forced search even across several rounds', async () => {
    // The model refuses to search, gets grounded, and then produces another bare answer. The guard
    // must not fire a second time.
    const { calls, run } = turn(
      [result('first bare answer'), result('second bare answer'), result('third bare answer')],
      { forced: [source(0.7, 'HesapOlustur')] },
      'Nasıl kayıt olucam?',
    );

    const answer = await run();

    expect(calls.forced).toBe(1);
    expect(calls.model).toBe(0);
    expect(answer.text).toBe('second bare answer');
  });

  it('falls back safely when the runtime search itself fails', async () => {
    const { calls, run } = turn(
      [result('Kayıt bağlantısı yok.')],
      { forcedFails: true },
      'Nasıl kayıt olucam?',
    );

    const answer = await run();

    expect(calls.forced).toBe(1);
    expect(answer.text).toBe(UNKNOWN);
  });
});

describe('the predicate decides deterministically', () => {
  const requires = [
    // Registration -- the original staging failure.
    'Nasıl kayıt olucam?',
    'Nasil kayit olucam?',
    'Siteye nasıl üye olurum?',
    'How do I register an account?',
    // Specific services, none of which contain the word "service" in any language. The keyword
    // list this replaced missed every one of them.
    'Kısırlaştırma yapıyor musunuz?',
    'Botoks yapıyor musunuz?',
    'Motor yağı değiştiriyor musunuz?',
    'Do you do oil changes?',
    'Do you perform Botox?',
    'Do you spay and neuter?',
    'Diş temizliği yapıyor musunuz mu acaba?',
    // Pricing, policy, requirements, process.
    'Fiyatlarınız nedir?',
    'How much does a dental cleaning cost?',
    'İptal politikanız nedir?',
    'What is your refund policy?',
    'Yeni hasta olarak ne yapmam gerekiyor?',
    'What are the requirements for a new patient?',
    // Asking what an appointment action costs is a question about the business, not an action.
    'Randevu iptal ücreti var mı?',
    'Is there a cancellation fee for appointments?',
    // A mixed turn is not exempted by the half that would have been.
    'Adresiniz nerede ve kısırlaştırma yapıyor musunuz?',
  ];

  const doesNotRequire = [
    // Conversation.
    'Merhaba',
    'merhaba!',
    'Teşekkürler',
    'tesekkurler',
    'Sağ olun',
    'Nasılsınız?',
    'Hello',
    'thanks',
    'ok',
    'How are you?',
    'Can you help me?',
    // Authoritative configuration.
    'Çalışma saatleriniz nedir?',
    'Kaçta açılıyorsunuz?',
    'Adresiniz neresi?',
    'Neredesiniz?',
    'Telefon numaranız nedir?',
    'Web siteniz nedir?',
    'What are your business hours?',
    'What is your address?',
    'What is your phone number?',
    'What is your website?',
    // Scheduling and lifecycle actions.
    'Yarın için randevu almak istiyorum',
    'Randevumu iptal etmek istiyorum',
    'Randevumu başka güne almak istiyorum',
    'Yarınki randevumu iptal et',
    'I want to book an appointment for tomorrow',
    'I want to cancel my appointment',
    'I would like to reschedule my appointment',
  ];

  for (const message of requires) {
    it(`requires grounding for ${JSON.stringify(message)}`, () => {
      expect(requiresBusinessKnowledge(message)).toBe(true);
    });
  }

  for (const message of doesNotRequire) {
    it(`leaves ${JSON.stringify(message)} alone`, () => {
      expect(requiresBusinessKnowledge(message)).toBe(false);
    });
  }

  it('separates a cancellation policy question from a cancellation action', () => {
    // The contradiction this replaced: "iptal" sat in the knowledge list while the comment above
    // it claimed cancellation belonged to the lifecycle tools. Both are right, for different
    // sentences, and the price/policy marker is what tells them apart.
    expect(requiresBusinessKnowledge('İptal politikanız nedir?')).toBe(true);
    expect(requiresBusinessKnowledge('Randevu iptal ücreti var mı?')).toBe(true);
    expect(requiresBusinessKnowledge('Randevumu iptal etmek istiyorum.')).toBe(false);
    expect(requiresBusinessKnowledge('Yarınki randevumu iptal et.')).toBe(false);

    expect(requiresBusinessKnowledge('What is your cancellation policy?')).toBe(true);
    expect(requiresBusinessKnowledge('Is there a fee to cancel an appointment?')).toBe(true);
    expect(requiresBusinessKnowledge('Please cancel my appointment.')).toBe(false);
  });

  it('reads Turkish suffixes rather than failing on them', () => {
    // `\w` is ASCII-only even under the `u` flag, so an earlier version silently failed on exactly
    // these characters: "nasılsınız" did not match "nasılsın\w*" and became a forced search.
    expect(requiresBusinessKnowledge('Nasılsınız?')).toBe(false);
    expect(requiresBusinessKnowledge('Çok teşekkürler')).toBe(false);
    expect(requiresBusinessKnowledge('Kayıtlı mıyım?')).toBe(true);
  });

  it('grounds an unrecognised word rather than assuming it is small talk', () => {
    // "büyük" is not in the filler list, so this is not whole-turn conversation and falls through
    // to grounding. That is the fail-closed direction working, not a miss: the cost is one search.
    expect(requiresBusinessKnowledge('Çok büyük teşekkürler')).toBe(true);
  });

  it('fails closed on an enquiry it has no category for', () => {
    // The property that replaced the unfinishable service catalogue: an unrecognised business
    // question is grounded rather than answered from nothing.
    expect(requiresBusinessKnowledge('Peluş oyuncak tamiri yapıyor musunuz?')).toBe(true);
    expect(requiresBusinessKnowledge('Do you offer equine physiotherapy?')).toBe(true);
  });
});

describe('a specific service question the model refused to research', () => {
  it('is grounded rather than answered', async () => {
    const { calls, run } = turn(
      [result('Evet, kısırlaştırma yapıyoruz.'), result('Kısırlaştırma hizmeti sunuyoruz.')],
      { forced: [source(0.64, 'Hizmetler')] },
      'Kısırlaştırma yapıyor musunuz?',
    );

    const answer = await run();

    expect(calls.forced).toBe(1);
    expect(answer.text).toBe('Kısırlaştırma hizmeti sunuyoruz.');
  });

  it('is refused when the corpus cannot support it', async () => {
    const { calls, run } = turn(
      [result('Evet, botoks yapıyoruz ve fiyatı 2000 TL.')],
      { forced: [] },
      'Botoks yapıyor musunuz?',
    );

    const answer = await run();

    expect(calls.forced).toBe(1);
    expect(answer.text).toBe(UNKNOWN);
    expect(answer.text).not.toContain('2000');
  });

  it('does not hijack a cancellation action into a website search', async () => {
    const { calls, run } = turn(
      [result('Tabii, hangi randevunuzu iptal edelim?')],
      { forced: [source(0.9, 'Anything')] },
      'Randevumu iptal etmek istiyorum',
    );

    const answer = await run();

    // Scheduling authority stays with the lifecycle tools; the guard must not reach into it.
    expect(calls.forced).toBe(0);
    expect(answer.text).toBe('Tabii, hangi randevunuzu iptal edelim?');
  });
});
