import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import type { FastifyRequest } from 'fastify';

/**
 * Who the client is, for abuse-control purposes only.
 *
 * ## The problem this exists to solve
 *
 * Fastify's default is `trustProxy: false`, which makes `request.ip` the socket peer. In the
 * compose topology that peer is always Caddy, so before this module every public visitor collapsed
 * into a single identity. The durable web-chat rate limits are keyed on that value, which meant the
 * per-client quotas in Phase 7 were in practice one global quota shared by every tenant's widget:
 * one abuser could exhaust it and lock everybody else out. That is the defect this fixes.
 *
 * The obvious repair -- `trustProxy: true` -- is worse than the defect. It tells Fastify to believe
 * `X-Forwarded-For` from whoever sent it, so any internet client could pick its own rate-limit
 * identity by writing a header, and could equally pick somebody else's.
 *
 * ## The boundary, and what actually enforces it
 *
 * A forwarding header is only meaningful if the hop that added it is one of ours, so this module
 * trusts a peer only on a private or loopback address. On its own that is a weak statement: "any
 * private container", which is not the same as "Caddy". An earlier version of this file claimed the
 * two were equivalent, and they were not -- `deploy/compose.yaml` put `web`, `api` and `caddy` on
 * one shared network, so the web container was also an internal peer of `api:4000` and could have
 * presented a forwarding chain this predicate would have believed.
 *
 * The fix is topological, not textual. `web` and `api` now sit on separate bridge networks with
 * Caddy on both, so no container except Caddy can open a socket to the API at all, and the API
 * publishes no host port. The set of peers able to present forwarding information is therefore
 * exactly one process, and this predicate is the second line rather than the only one.
 *
 * If the API is ever reached from a public address, that peer is untrusted, every forwarding header
 * it sent is ignored, and its own socket address becomes the identity. It fails closed.
 *
 * Deliberately not a hop count. A count says "believe the Nth entry" without ever asking who wrote
 * it; if the topology gains a hop, or the API is exposed by mistake, a count keeps believing.
 *
 * `deploy/Caddyfile` additionally replaces `X-Forwarded-For` with the real remote host rather than
 * appending to whatever arrived, so an injected chain does not survive the hop at all. Three
 * controls -- network separation, header replacement, peer predicate -- and no one of them is
 * relied on to be perfect.
 */

/** Longest textual address worth considering. Anything larger is malformed, not exotic. */
const MAX_ADDRESS_LENGTH = 45;

function stripIPv6Zone(address: string): string {
  const zone = address.indexOf('%');
  return zone === -1 ? address : address.slice(0, zone);
}

function unwrapIPv4Mapped(address: string): string {
  // ::ffff:203.0.113.9 and ::ffff:cb00:7109 both mean the same IPv4 host.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  return mapped?.[1] ?? address;
}

/** Expands an IPv6 address to its eight four-digit groups, or null when it is not one. */
function expandIPv6(address: string): readonly string[] | null {
  if (isIP(address) !== 6) return null;
  const [head, tail] = address.split('::', 2);
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  if (tail === undefined) {
    if (headGroups.length !== 8) return null;
    return headGroups.map((group) => group.padStart(4, '0').toLowerCase());
  }
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 0) return null;
  return [...headGroups, ...Array.from({ length: fill }, () => '0'), ...tailGroups].map((group) =>
    group.padStart(4, '0').toLowerCase(),
  );
}

/**
 * True when the address belongs to a range that only our own infrastructure can occupy.
 *
 * Loopback covers the container's own health probe, which reaches the API on 127.0.0.1 and must not
 * be mistaken for an internet client.
 */
export function isInternalAddress(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ADDRESS_LENGTH) {
    return false;
  }
  const address = unwrapIPv4Mapped(stripIPv6Zone(value.trim()));
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets as [number, number, number, number];
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (version === 6) {
    const groups = expandIPv6(address);
    if (!groups) return false;
    const first = groups[0] ?? '';
    if (groups.every((group) => group === '0000')) return false;
    if (groups.slice(0, 7).every((group) => group === '0000') && groups[7] === '0001') return true;
    // fc00::/7 unique-local, fe80::/10 link-local.
    const leading = Number.parseInt(first, 16);
    if ((leading & 0xfe00) === 0xfc00) return true;
    if ((leading & 0xffc0) === 0xfe80) return true;
    return false;
  }
  return false;
}

/**
 * Fastify's `trustProxy` predicate.
 *
 * proxy-addr walks the socket address first and then the forwarding chain right to left, asking
 * this for each one. Returning true means "this is our hop, keep looking"; the first address that
 * is not ours is the client. An internet peer is never ours, so a request that did not come through
 * the internal network can never have its forwarding headers honoured.
 */
export function trustInternalProxy(address: string): boolean {
  return isInternalAddress(address);
}

/**
 * Canonical, bounded form of a client address for use as an abuse-control key.
 *
 * IPv6 collapses to its /64 prefix on purpose: a single subscriber is routinely handed an entire
 * /64, so keying on the full address would let one client rotate through billions of identities and
 * defeat every quota. IPv4 keeps its full address, which is the equivalent unit there.
 *
 * Returns null for anything unparseable, which callers treat as a single shared "malformed" bucket
 * rather than as an unbounded key space.
 */
export function canonicalClientAddress(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ADDRESS_LENGTH) return null;
  const address = unwrapIPv4Mapped(stripIPv6Zone(trimmed));
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6) {
    const groups = expandIPv6(address);
    if (!groups) return null;
    return `${groups.slice(0, 4).join(':')}::/64`;
  }
  return null;
}

/** Fixed label for a request whose address could not be parsed. Bounded by construction. */
export const UNRESOLVED_CLIENT_LABEL = 'unresolved';

/**
 * The opaque per-client key every abuse control uses.
 *
 * Hashed rather than raw, so no limiter store, log line, or database row ever holds an address.
 * `scope` separates the counters so one route's quota cannot be spent by traffic to another.
 */
export function clientRateKey(request: FastifyRequest, scope: string): string {
  const canonical = canonicalClientAddress(request.ip) ?? UNRESOLVED_CLIENT_LABEL;
  return createHash('sha256').update(`${scope}:${canonical}`).digest('hex');
}
