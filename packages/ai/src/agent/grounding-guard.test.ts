import { veterinaryPack } from '@avenlyo/industries';
import { describe, expect, it, vi } from 'vitest';

import type { AgentToolServices, RuntimeKnowledgeSearchResult, ToolExecutor } from '../tools/types';
import { ControlledToolExecutor } from '../tools/executor';

import {
  requiresBusinessKnowledge,
  CONFIGURATION_QUESTIONS,
} from './business-knowledge-predicate';
import { AgentRuntime } from './runtime';
import type {
  AgentBusinessContext,
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

const CONFIGURED: AgentBusinessContext = {
  address: '1 Clinic Street, Istanbul',
  businessHours: 'Mon-Fri 09:00-17:00',
  locationName: 'Main location',
  name: 'oddrail',
  phone: '+90 555 000 0000',
  timezone: 'UTC',
  website: 'https://petrandevu.com',
};

const NOTHING_CONFIGURED: AgentBusinessContext = {
  address: null,
  businessHours: null,
  locationName: null,
  name: 'oddrail',
  phone: null,
  timezone: 'UTC',
  website: null,
};

describe('the predicate decides deterministically', () => {
  const requires = [
    // Registration -- the original staging failure.
    'Nasıl kayıt olucam?',
    'Nasil kayit olucam?',
    'Siteye nasıl üye olurum?',
    'How do I register an account?',
    // Specific services. None contains the word "service" in any language, which is why the
    // keyword catalogue this replaced missed every one of them.
    'Kısırlaştırma yapıyor musunuz?',
    'Botoks yapıyor musunuz?',
    'Motor yağı değiştiriyor musunuz?',
    'Do you do oil changes?',
    'Do you perform Botox?',
    'Do you offer equine physiotherapy?',
    // Pricing, policy, requirements.
    'Fiyatlarınız nedir?',
    'İptal politikanız nedir?',
    'What is your refund policy?',
    'Yeni hasta olarak ne yapmam gerekiyor?',
    'Randevu iptal ücreti var mı?',
    'Is there a cancellation fee for appointments?',
  ];

  for (const message of requires) {
    it(`requires grounding for ${JSON.stringify(message)}`, () => {
      expect(requiresBusinessKnowledge(message, CONFIGURED)).toBe(true);
    });
  }

  const conversation = ['Merhaba', 'merhaba!', 'Teşekkürler', 'Nasılsınız?', 'Hello', 'thanks', 'ok', 'How are you?', 'Can you help me?'];
  for (const message of conversation) {
    it(`leaves conversation alone: ${JSON.stringify(message)}`, () => {
      expect(requiresBusinessKnowledge(message, CONFIGURED)).toBe(false);
    });
  }
});

describe('a configuration exemption checks that the configuration exists', () => {
  const configurationQuestions: readonly [string, string][] = [
    ['Adresiniz neresi?', 'address'],
    ['Neredesiniz?', 'address'],
    ['What is your address?', 'address'],
    ['Çalışma saatleriniz nedir?', 'businessHours'],
    ['Kaçta açılıyorsunuz?', 'businessHours'],
    ['What are your business hours?', 'businessHours'],
    ['Telefon numaranız nedir?', 'phone'],
    ['What is your phone number?', 'phone'],
    ['Web siteniz nedir?', 'website'],
    ['What is your website?', 'website'],
  ];

  for (const [message, field] of configurationQuestions) {
    it(`is exempt when ${field} is configured: ${JSON.stringify(message)}`, () => {
      expect(requiresBusinessKnowledge(message, CONFIGURED)).toBe(false);
    });

    it(`is NOT exempt when ${field} is missing: ${JSON.stringify(message)}`, () => {
      // The defect this replaced. With nothing configured there is no authoritative answer
      // anywhere, so exempting the turn handed the model a blank page and let it invent one.
      expect(requiresBusinessKnowledge(message, NOTHING_CONFIGURED)).toBe(true);
    });
  }

  it('is not exempt when no business context is supplied at all', () => {
    expect(requiresBusinessKnowledge('Adresiniz neresi?')).toBe(true);
  });

  it('is not exempt when the configured value is blank rather than null', () => {
    expect(
      requiresBusinessKnowledge('Adresiniz neresi?', { ...CONFIGURED, address: '   ' }),
    ).toBe(true);
  });
});

describe('a configuration word is not a configuration question', () => {
  // The second failure mode: these all begin like a configuration question and ask for something
  // configuration does not contain. Matching whole turns rather than counting keywords is what
  // separates them, and it does not need another blacklist to keep up with.
  const looksLikeConfiguration = [
    'Kaçta botoks yapıyorsunuz?',
    'Kaçta kısırlaştırma yapıyorsunuz?',
    'Adresinizde otopark bulunuyor mu?',
    'Web sitenizden ödeme yapabilir miyim?',
    'Telefonla kayıt olabilir miyim?',
    'Adresiniz nerede ve kısırlaştırma yapıyor musunuz?',
  ];

  for (const message of looksLikeConfiguration) {
    it(`grounds ${JSON.stringify(message)} even with everything configured`, () => {
      expect(requiresBusinessKnowledge(message, CONFIGURED)).toBe(true);
    });
  }
});

describe('a scheduling exemption needs intent, not vocabulary', () => {
  const actions = [
    'Yarın için randevu almak istiyorum',
    'Randevumu iptal etmek istiyorum',
    'Randevumu başka güne almak istiyorum',
    'Yarınki randevumu iptal et',
    'I want to book an appointment for tomorrow',
    'Please cancel my appointment',
    "I'd like to reschedule my appointment",
  ];

  for (const message of actions) {
    it(`leaves the scheduling tools to handle ${JSON.stringify(message)}`, () => {
      expect(requiresBusinessKnowledge(message, CONFIGURED)).toBe(false);
    });
  }

  const enquiries = [
    'Randevu almak için hangi belgeler gerekiyor?',
    'Randevu almak için ne yapmam gerekiyor?',
    'Randevu iptal süreciniz nasıl işliyor?',
    'What documents do I need to book an appointment?',
    'How does your appointment cancellation process work?',
  ];

  for (const message of enquiries) {
    it(`grounds the question ${JSON.stringify(message)}`, () => {
      // Asking what booking requires is a question about the business. The scheduling tools do not
      // perform it, and an earlier version exempted it purely because "randevu" and "almak" both
      // appeared in the sentence.
      expect(requiresBusinessKnowledge(message, CONFIGURED)).toBe(true);
    });
  }

  it('separates a cancellation policy question from a cancellation action', () => {
    expect(requiresBusinessKnowledge('İptal politikanız nedir?', CONFIGURED)).toBe(true);
    expect(requiresBusinessKnowledge('Randevu iptal ücreti var mı?', CONFIGURED)).toBe(true);
    expect(requiresBusinessKnowledge('Randevumu iptal etmek istiyorum.', CONFIGURED)).toBe(false);
    expect(requiresBusinessKnowledge('What is your cancellation policy?', CONFIGURED)).toBe(true);
    expect(requiresBusinessKnowledge('Please cancel my appointment.', CONFIGURED)).toBe(false);
  });

  it('reads Turkish casing rather than failing on it', () => {
    // JavaScript lowercases "İ" to "i" plus a combining dot, so "İptal" never matched "iptal"
    // until that mark was stripped.
    expect(requiresBusinessKnowledge('Nasılsınız?', CONFIGURED)).toBe(false);
    expect(requiresBusinessKnowledge('Kayıtlı mıyım?', CONFIGURED)).toBe(true);
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

    expect(calls.forced).toBe(0);
    expect(answer.text).toBe('Tabii, hangi randevunuzu iptal edelim?');
  });

  it('refuses an address the business has not configured', async () => {
    // End to end through the runtime: nothing configured, model answers with no tool call, and the
    // invented address does not reach the customer.
    const { calls, executor: tools } = executor({ forced: [] });
    const runtime = new AgentRuntime(
      provider([result('Adresimiz 5 Uydurma Caddesi.')]),
      tools,
      'test-model',
    );

    const answer = await runtime.runTurn({
      business: NOTHING_CONFIGURED,
      context: {
        conversationId: '00000000-0000-4000-8000-000000000001',
        industryId: 'veterinary',
        locationId: '00000000-0000-4000-8000-000000000002',
        mode: 'test',
        organizationId: '00000000-0000-4000-8000-000000000003',
      },
      history: [],
      industry: veterinaryPack,
      userMessage: 'Adresiniz neresi?',
    });

    expect(calls.forced).toBe(1);
    expect(answer.text).toBe(UNKNOWN);
    expect(answer.text).not.toContain('Uydurma');
  });

  it('lets a configured address answer without any search', async () => {
    // The other side of the same rule: with an address configured there *is* an authoritative
    // answer, so the turn is exempt and no search is spent on it.
    const { calls, executor: tools } = executor({ forced: [] });
    const runtime = new AgentRuntime(
      provider([result('Adresimiz 1 Clinic Street, Istanbul.')]),
      tools,
      'test-model',
    );

    const answer = await runtime.runTurn({
      business: CONFIGURED,
      context: {
        conversationId: '00000000-0000-4000-8000-000000000001',
        industryId: 'veterinary',
        locationId: '00000000-0000-4000-8000-000000000002',
        mode: 'test',
        organizationId: '00000000-0000-4000-8000-000000000003',
      },
      history: [],
      industry: veterinaryPack,
      userMessage: 'Adresiniz neresi?',
    });

    expect(calls.forced).toBe(0);
    expect(answer.text).toBe('Adresimiz 1 Clinic Street, Istanbul.');
  });
});


describe('every configuration matcher is a true whole-turn matcher', () => {
  /**
   * Finds an alternation that is not inside a group.
   *
   * This is the bug that shipped: `^(a|b)?\\s*(c)\\s*mısınız|misiniz$` reads as two patterns, and
   * the second one is anchored only at the end. Any turn finishing in "misiniz?" -- including
   * "Botoks yapıyor misiniz?" -- matched the business-hours question and was exempted from
   * grounding. A behavioural test catches the one phrasing someone thought of; this catches the
   * shape, for every pattern, including ones added later.
   */
  function hasTopLevelAlternation(source: string): boolean {
    let depth = 0;
    let inClass = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (inClass) {
        if (character === ']') inClass = false;
        continue;
      }
      if (character === '[') inClass = true;
      else if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      else if (character === '|' && depth === 0) return true;
    }
    return false;
  }

  it('detects the alternation shape that actually shipped', () => {
    // The exact broken form, so the detector is proven to detect rather than merely assumed to.
    expect(hasTopLevelAlternation('^(a|b)?[ ]*(c)[ ]*misiniz|musunuz[ ]*$')).toBe(true);
    expect(hasTopLevelAlternation('^(?:a|b)?[ ]*(?:c)[ ]*(?:misiniz|musunuz)[ ]*$')).toBe(false);
    // An escaped pipe and one inside a character class are not alternations.
    expect(hasTopLevelAlternation('^a\\|b$')).toBe(false);
    expect(hasTopLevelAlternation('^[a|b]c$')).toBe(false);
  });

  it.each(CONFIGURATION_QUESTIONS.map((entry) => [entry.field, entry.pattern.source] as const))(
    '%s pattern is anchored at both ends with no top-level alternation',
    (_field, source) => {
      expect(source.startsWith('^')).toBe(true);
      expect(source.endsWith('$')).toBe(true);
      expect(hasTopLevelAlternation(source)).toBe(false);
    },
  );

  it('rejects a padded or extended version of every configuration question it accepts', () => {
    // Whole-turn means whole turn: nothing may match with an unrelated clause bolted on.
    for (const { pattern } of CONFIGURATION_QUESTIONS) {
      for (const sample of [
        'botoks yapıyor misiniz',
        'randevuda ödeme yapabilir miyim',
        'kısırlaştırma yapıyor musunuz',
      ]) {
        expect(pattern.test(sample)).toBe(false);
      }
    }
  });
});

describe('a turn ending like a configuration question is not one', () => {
  it('grounds "Botoks yapıyor misiniz?" even with hours configured', () => {
    // The shipped regression: this ended in "misiniz?" and was exempted as an hours question.
    expect(requiresBusinessKnowledge('Botoks yapıyor misiniz?', CONFIGURED)).toBe(true);
  });

  it('grounds the same question in its correctly-voweled form', () => {
    expect(requiresBusinessKnowledge('Kısırlaştırma yapıyor musunuz?', CONFIGURED)).toBe(true);
  });

  it('still exempts a real open-now question when hours are configured', () => {
    expect(requiresBusinessKnowledge('Şu an açık mısınız?', CONFIGURED)).toBe(false);
    expect(requiresBusinessKnowledge('Bugün açık mısınız?', CONFIGURED)).toBe(false);
  });

  it('grounds a real open-now question when hours are NOT configured', () => {
    expect(requiresBusinessKnowledge('Şu an açık mısınız?', NOTHING_CONFIGURED)).toBe(true);
    expect(requiresBusinessKnowledge('Bugün açık mısınız?', NOTHING_CONFIGURED)).toBe(true);
  });
});

describe('an appointment mentioned is not an appointment being changed', () => {
  const notScheduling = [
    // "Can I have Botox at the appointment" -- the appointment is where it happens, not the thing
    // being booked or cancelled. The earlier rule exempted it because "randevu" sat beside a modal.
    'Randevuda botoks yapabilir miyim?',
    'Randevuda kredi kartıyla ödeme yapabilir miyim?',
    'Randevuda yanımda birini getirebilir miyim?',
    'Randevu almak için hangi belgeler gerekiyor?',
    'Randevu almak için ne yapmam gerekiyor?',
    'Randevu iptal süreciniz nasıl işliyor?',
  ];

  for (const message of notScheduling) {
    it(`grounds ${JSON.stringify(message)}`, () => {
      expect(requiresBusinessKnowledge(message, CONFIGURED)).toBe(true);
    });
  }

  const scheduling = [
    'Yarın için randevu almak istiyorum',
    'Randevumu iptal etmek istiyorum',
    'Randevumu başka güne almak istiyorum',
    'Yarınki randevumu iptal et',
    'Randevu alabilir miyim?',
    'I want to book an appointment for tomorrow',
    'Please cancel my appointment',
    "I'd like to reschedule my appointment",
  ];

  for (const message of scheduling) {
    it(`leaves the scheduling tools to handle ${JSON.stringify(message)}`, () => {
      expect(requiresBusinessKnowledge(message, CONFIGURED)).toBe(false);
    });
  }
});
