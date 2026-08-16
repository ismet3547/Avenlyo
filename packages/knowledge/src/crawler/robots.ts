import { normalizeCrawlUrl } from './url-policy';

interface RobotsRule {
  readonly allow: boolean;
  readonly path: string;
}

function rulesForUserAgent(robots: string, userAgent: string): readonly RobotsRule[] {
  const target = userAgent.toLowerCase();
  const groups = new Map<string, RobotsRule[]>();
  let agents: string[] = [];

  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const match = /^([^:]+):\s*(.*)$/i.exec(line);
    if (!match) continue;
    const directive = match[1]!.trim().toLowerCase();
    const value = match[2]!.trim();
    if (directive === 'user-agent') {
      agents = [value.toLowerCase()];
      if (!groups.has(agents[0]!)) groups.set(agents[0]!, []);
      continue;
    }
    if ((directive === 'allow' || directive === 'disallow') && agents.length > 0) {
      for (const agent of agents) {
        groups.get(agent)?.push({ allow: directive === 'allow', path: value });
      }
    }
  }

  return groups.get(target) ?? groups.get('*') ?? [];
}

export function isRobotsAllowed(robots: string, candidateUrl: URL): boolean {
  const rules = rulesForUserAgent(robots, 'avenlyobot');
  const matching = rules
    .filter((rule) => rule.path && candidateUrl.pathname.startsWith(rule.path))
    .sort((left, right) => right.path.length - left.path.length);
  return matching[0]?.allow ?? true;
}

export function robotsUrlFor(root: URL): URL {
  return normalizeCrawlUrl('/robots.txt', root.toString());
}
