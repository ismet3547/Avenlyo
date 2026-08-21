import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { CrawlPolicyError } from '../crawler/types';
import { authorizeEgress, parseEgressAuthority, type EgressPolicyOptions } from './egress-policy';

/**
 * The only way a rendered import reaches the network.
 *
 * Chromium is pointed at this proxy on loopback and given no other route out, which changes who
 * performs DNS. A proxied client sends the *hostname* to its proxy and never resolves it, so the
 * lookup happens here, once, and the socket is opened to an address that was just validated. That
 * ordering is what makes DNS rebinding impossible: there is no second resolution for an attacker
 * to poison, because the browser never gets to do one.
 *
 * This is deliberately not a TLS terminator. A CONNECT is answered by opening a raw TCP socket to
 * the validated address and copying bytes, so the browser completes its own handshake with the
 * original hostname: SNI, certificate chain, and hostname verification all stay end-to-end and
 * entirely outside Avenlyo's reach. Nothing here can weaken certificate validation, because
 * nothing here can see the certificate.
 *
 * Everything the proxy does is bounded. It listens on loopback only, accepts a fixed number of
 * requests and origins per import, holds no state between imports, and never logs a URL or a body.
 */

export interface EgressProxyLimits {
  /** Total proxied requests, including CONNECT tunnels, for the whole import. */
  readonly maxRequests: number;
  /** Distinct `hostname:port` destinations for the whole import. */
  readonly maxOrigins: number;
  /** Idle socket timeout for one proxied connection. */
  readonly socketIdleMs: number;
}

/**
 * Headers that describe one hop of a connection rather than the response itself. A relay that
 * copies them forward is describing framing it did not keep.
 */
const hopByHopHeaders: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const defaultEgressProxyLimits: EgressProxyLimits = {
  maxOrigins: 25,
  maxRequests: 400,
  socketIdleMs: 15_000,
};

export interface EgressProxyOptions extends EgressPolicyOptions {
  readonly limits?: EgressProxyLimits;
}

export interface EgressProxyStats {
  readonly origins: number;
  readonly rejected: number;
  readonly requests: number;
}

/** A destination the proxy refused, recorded as bounded facts for tests and diagnostics only. */
export interface EgressRejection {
  readonly code: CrawlPolicyError['code'] | 'limit_exceeded' | 'method_not_allowed';
  readonly hostname: string;
  readonly port: number;
}

export class EgressProxy {
  private readonly limits: EgressProxyLimits;
  private readonly origins = new Set<string>();
  private readonly rejections: EgressRejection[] = [];
  private readonly server: Server;
  private readonly sockets = new Set<Duplex>();
  private requests = 0;

  public constructor(private readonly options: EgressProxyOptions = {}) {
    this.limits = options.limits ?? defaultEgressProxyLimits;
    this.server = createServer((request, response) => {
      // A response with no socket has already lost its connection; there is nothing to relay onto.
      if (response.socket) void this.handleRequest(request, response.socket);
    });
    this.server.on('connect', (request, socket, head) => {
      void this.handleConnect(request, socket, head);
    });
    // A hostile page can open sockets it never uses; none of them may outlive the import.
    this.server.on('connection', (socket) => {
      this.track(socket);
      socket.setTimeout(this.limits.socketIdleMs, () => socket.destroy());
      // Every accepted socket needs an error listener from the moment it exists. A peer that resets
      // before a handler attaches its own would otherwise be an uncaught exception, and an uncaught
      // socket error takes the whole worker process down.
      socket.on('error', () => socket.destroy());
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }

  /** Binds to loopback only, so nothing outside this machine can use the proxy as an open relay. */
  public async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  public get proxyUrl(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  public stats(): EgressProxyStats {
    return {
      origins: this.origins.size,
      rejected: this.rejections.length,
      requests: this.requests,
    };
  }

  public rejectionLog(): readonly EgressRejection[] {
    return [...this.rejections];
  }

  public async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  /**
   * Counts one destination against the import budget. A hostile page cannot spend an unbounded
   * amount of worker time or open an unbounded set of origins even if every one of them is public.
   */
  private admit(hostname: string, port: number): void {
    this.requests += 1;
    if (this.requests > this.limits.maxRequests) {
      throw new CrawlPolicyError('request_failed', 'The website made too many network requests.');
    }
    const origin = `${hostname}:${port}`;
    if (!this.origins.has(origin) && this.origins.size >= this.limits.maxOrigins) {
      throw new CrawlPolicyError('request_failed', 'The website used too many network origins.');
    }
    this.origins.add(origin);
  }

  private record(code: EgressRejection['code'], hostname: string, port: number): void {
    // Bounded facts only: a hostname and a port, never a path, header, body, or client address.
    if (this.rejections.length < 200) this.rejections.push({ code, hostname, port });
  }

  private async handleConnect(
    request: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const target = parseEgressAuthority(request.url ?? '', 443);
    if (!target) {
      this.record('invalid_url', '', 0);
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    let upstream: Socket;
    try {
      this.admit(target.hostname, target.port);
      const destination = await authorizeEgress(target.hostname, target.port, this.options);
      upstream = netConnect({
        host: destination.addresses[0]!.address,
        port: destination.port,
      });
      // Upstream sockets are tracked alongside client sockets so closing the proxy tears down both
      // halves of every tunnel. An untracked half keeps the peer alive past the end of the import.
      this.track(upstream);
      upstream.on('error', () => upstream.destroy());
    } catch (error) {
      this.record(
        error instanceof CrawlPolicyError ? error.code : 'limit_exceeded',
        target.hostname,
        target.port,
      );
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    upstream.setTimeout(this.limits.socketIdleMs, () => upstream.destroy());
    upstream.once('error', () => clientSocket.destroy());
    clientSocket.once('error', () => upstream.destroy());
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      // Opaque byte tunnel. The TLS handshake inside it is between Chromium and the origin, so
      // certificate verification and SNI never pass through Avenlyo at all.
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  }

  private async handleRequest(request: IncomingMessage, clientSocket: Duplex): Promise<void> {
    let requestUrl: URL;
    try {
      // A proxied plain-HTTP request carries an absolute URL. A relative one is a direct request
      // to the proxy itself, which is never legitimate.
      requestUrl = new URL(request.url ?? '');
    } catch {
      this.record('invalid_url', '', 0);
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (requestUrl.protocol !== 'http:') {
      this.record('invalid_url', requestUrl.hostname, 0);
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const port = requestUrl.port ? Number(requestUrl.port) : 80;
    try {
      this.admit(requestUrl.hostname, port);
      const destination = await authorizeEgress(requestUrl.hostname, port, this.options);
      const pinned = destination.addresses[0]!;
      const upstream = httpRequest(
        {
          // Host is taken from the URL policy validated, never from the client's own header. A
          // client that sends a Host disagreeing with its request line is describing a different
          // destination to the origin than the one that was authorised here.
          headers: { ...request.headers, host: requestUrl.host },
          host: requestUrl.hostname,
          // The connection is pinned to the validated address while the request keeps the original
          // Host, exactly as the static fetcher does.
          lookup: (_hostname, options, callback) =>
            options.all === true
              ? callback(null, [{ address: pinned.address, family: pinned.family }])
              : callback(null, pinned.address, pinned.family),
          method: request.method ?? 'GET',
          path: `${requestUrl.pathname}${requestUrl.search}`,
          port,
          timeout: this.limits.socketIdleMs,
        },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 502;
          // Node has already decoded any chunked framing into this stream, so the hop-by-hop
          // headers that described the original framing must not be copied forward: relaying
          // `transfer-encoding: chunked` alongside a decoded body produces bytes no client can
          // parse. Connection close delimits the relayed response instead, which needs no framing.
          const headers = Object.entries(upstreamResponse.headers)
            .filter(([key]) => !hopByHopHeaders.has(key.toLowerCase()))
            .flatMap(([key, value]) =>
              Array.isArray(value)
                ? value.map((entry) => `${key}: ${entry}`)
                : value === undefined
                  ? []
                  : [`${key}: ${value}`],
            )
            .concat('connection: close')
            .join('\r\n');
          clientSocket.write(
            `HTTP/1.1 ${status} ${upstreamResponse.statusMessage ?? ''}\r\n${headers}\r\n\r\n`,
          );
          // A peer that resets mid-body is ordinary; it must not become an uncaught exception.
          upstreamResponse.on('error', () => clientSocket.destroy());
          upstreamResponse.pipe(clientSocket);
        },
      );
      upstream.once('error', () => clientSocket.destroy());
      upstream.once('timeout', () => upstream.destroy());
      clientSocket.on('error', () => upstream.destroy());
      request.on('error', () => upstream.destroy());
      request.pipe(upstream);
    } catch (error) {
      this.record(
        error instanceof CrawlPolicyError ? error.code : 'limit_exceeded',
        requestUrl.hostname,
        port,
      );
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  }
}
