import { describe, expect, it } from 'vitest';

import { parseRobots } from './robots';

function isAllowed(robots: string, path: string): boolean {
  const robotsUrl = new URL('https://clinic.example/robots.txt');
  return parseRobots(robotsUrl, robots).isAllowed(new URL(path, 'https://clinic.example'));
}

describe('robots policy', () => {
  it('uses the specific AvenlyoBot group before the wildcard group', () => {
    expect(
      isAllowed('User-agent: *\nDisallow: /\n\nUser-agent: AvenlyoBot\nAllow: /', '/services'),
    ).toBe(true);
  });

  it('treats multiple user-agent lines as one rule group', () => {
    expect(
      isAllowed('User-agent: AvenlyoBot\nUser-agent: OtherBot\nDisallow: /', '/services'),
    ).toBe(false);
  });

  it('selects the applicable group when multiple groups are present', () => {
    expect(
      isAllowed('User-agent: OtherBot\nDisallow: /\n\nUser-agent: *\nAllow: /', '/services'),
    ).toBe(true);
  });

  it('uses the most-specific Allow or Disallow rule', () => {
    expect(
      isAllowed('User-agent: *\nDisallow: /private\nAllow: /private/summary', '/private'),
    ).toBe(false);
    expect(
      isAllowed('User-agent: *\nDisallow: /private\nAllow: /private/summary', '/private/summary'),
    ).toBe(true);
  });

  it('supports wildcard and end-anchor path rules', () => {
    const robots = 'User-agent: *\nDisallow: /*.pdf$';
    expect(isAllowed(robots, '/guide.pdf')).toBe(false);
    expect(isAllowed(robots, '/guide.pdf/preview')).toBe(true);
  });

  it('allows an empty Disallow directive and ignores comments', () => {
    expect(
      isAllowed('uSeR-aGeNt: * # bot policy\nDiSaLlOw: # intentionally empty', '/services'),
    ).toBe(true);
  });
});
