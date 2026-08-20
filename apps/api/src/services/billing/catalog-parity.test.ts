import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createBillingCatalog } from './catalog.js';

/**
 * The API catalogue and the database enforcement catalogue have to name exactly the same features.
 *
 * They are two representations of one product decision, and drift between them is silent in the
 * worst possible direction: a feature the API believes is included but the database has never heard
 * of returns false from `billing_feature_available`, so a paying customer's automation stops with
 * no error anywhere. A feature the database knows and the API does not is the mirror image.
 *
 * This is asserted against the migration source rather than a live database on purpose, so it holds
 * in ordinary unit runs with no Postgres, and so a pull request that edits one side is red before
 * it ever reaches CI's database job. The pgTAP suite separately proves the deployed table matches.
 */
function readSql(url: URL): string {
  return readFileSync(url, 'utf8').split('\r\n').join('\n');
}

const migration = readSql(
  new URL(
    '../../../../../supabase/migrations/20260830000000_phase_17_billing_enforcement.sql',
    import.meta.url,
  ),
);

/** The seeded rows of `public.billing_core_features`, read straight out of the migration. */
function databaseFeatures(): readonly string[] {
  const seed = /insert into public\.billing_core_features \(feature\) values([\s\S]*?);/.exec(
    migration,
  );
  if (!seed?.[1]) throw new Error('The Phase 17 feature catalogue seed was not found.');
  return [...seed[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string);
}

const apiFeatures = createBillingCatalog({
  STRIPE_PRICE_CORE_MONTHLY: 'price_core',
  STRIPE_PRODUCT_CORE: 'prod_core',
})!.core.features;

describe('billing catalogue parity', () => {
  it('names exactly the same Core features on both sides', () => {
    expect([...databaseFeatures()].sort()).toEqual([...apiFeatures].sort());
  });

  it('keeps the Core feature set at the seven Phase 12 features', () => {
    expect([...apiFeatures].sort()).toEqual([
      'appointments',
      'lead_capture',
      'lead_followups',
      'reminders',
      'sms',
      'voice',
      'web_chat',
    ]);
  });

  it('introduces no pricing tier beyond Core', () => {
    for (const tier of ['pro', 'enterprise', 'starter', 'free', 'seat', 'overage', 'credit']) {
      expect(migration.toLowerCase()).not.toContain(`'${tier}'`);
    }
  });

  it('keeps Core usage limits unlimited', () => {
    expect(
      Object.values(
        createBillingCatalog({
          STRIPE_PRICE_CORE_MONTHLY: 'price_core',
          STRIPE_PRODUCT_CORE: 'prod_core',
        })!.core.usageLimits,
      ),
    ).toEqual([null, null, null, null]);
  });

  it('leaves the feature catalogue unwritable by every role', () => {
    // No policy and no grant: it is source-controlled product data, not an admin pricing table.
    expect(migration).toContain(
      'alter table public.billing_core_features enable row level security',
    );
    expect(migration).toContain(
      'revoke all on table public.billing_core_features\n  from public, anon, authenticated, service_role;',
    );
    expect(migration).not.toMatch(/create policy \w+ on public\.billing_core_features/);
    expect(migration).not.toMatch(/grant [\w ,]+ on table public\.billing_core_features/);
  });
});
