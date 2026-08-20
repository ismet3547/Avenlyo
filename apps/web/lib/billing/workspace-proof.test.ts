import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SECRET_NAME = 'AVENLYO_INTERNAL_BILLING_SECRET';

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .split('\r\n')
    .join('\n');
}

/** Every source file under a directory, so a leak cannot hide in a file nobody thought to name. */
function sourcesUnder(relative: string): readonly { path: string; text: string }[] {
  const root = fileURLToPath(new URL(relative, import.meta.url));
  const found: { path: string; text: string }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) continue;
      found.push({ path, text: readFileSync(path, 'utf8').split('\r\n').join('\n') });
    }
  };
  walk(root);
  return found;
}

const actions = readSource('../../app/dashboard/billing/actions.ts');
const proofModule = readSource('./workspace-proof.ts');
const publicConfig = readSource('../supabase/config.ts');

describe('billing actions sign the selection they resolved', () => {
  it('resolves the organization through the trusted workspace resolver', () => {
    expect(actions).toContain('requireCompletedWorkspace()');
    // No form field, query parameter, or cookie chooses the billing organization.
    expect(actions).not.toMatch(/formData|searchParams|cookies\(\)/);
  });

  it('signs that exact organization together with the authenticated user', () => {
    expect(actions).toContain('billingWorkspaceProof({');
    expect(actions).toContain('organizationId: workspace.organizationId,');
    expect(actions).toContain('userId: auth.user.id,');
    // The body and the proof must name the same organization; sending one and signing another
    // would reintroduce exactly the gap this closes.
    expect(actions).toContain('JSON.stringify({ organizationId: workspace.organizationId })');
  });

  it('sends the proof as a header and refuses to call the API without one', () => {
    expect(actions).toContain('[WORKSPACE_PROOF_HEADER]: proof,');
    expect(actions).toContain('if (!proof) throw new Error');
    // Never a query parameter: a URL reaches logs, proxies, and referrers.
    expect(actions).not.toMatch(/\?.*proof/i);
  });
});

describe('the server-only secret stays on the server', () => {
  it('is read only from a server-only module', () => {
    expect(proofModule).toContain("import 'server-only';");
    expect(proofModule).toContain(`process.env.${SECRET_NAME}`);
  });

  it('is never exposed through the browser-visible configuration', () => {
    // lib/supabase/config.ts is the module whose whole contents reach the client bundle.
    expect(publicConfig).not.toContain(SECRET_NAME);
    expect(publicConfig).not.toContain('BILLING_SECRET');
  });

  it('is never given a NEXT_PUBLIC_ name anywhere in the web application', () => {
    for (const source of sourcesUnder('../..')) {
      expect(source.text).not.toContain(`NEXT_PUBLIC_${SECRET_NAME}`);
      expect(source.text).not.toMatch(/NEXT_PUBLIC_[A-Z_]*BILLING_SECRET/);
    }
  });

  it('is never reachable from a client component', () => {
    for (const source of sourcesUnder('../..')) {
      const isClient = /^\s*['"]use client['"]/m.test(source.text);
      if (!isClient) continue;
      expect(source.text).not.toContain('@/lib/billing/workspace-proof');
      expect(source.text).not.toContain('@avenlyo/shared/workspace-proof');
      expect(source.text).not.toContain(SECRET_NAME);
    }
  });

  it('is never logged or returned by the billing actions', () => {
    expect(actions).not.toContain(SECRET_NAME);
    expect(actions).not.toMatch(/console\.(log|info|warn|error)/);
    // The failure message names no setting and no value.
    expect(actions).toContain("throw new Error('Billing is unavailable.');");
  });
});
