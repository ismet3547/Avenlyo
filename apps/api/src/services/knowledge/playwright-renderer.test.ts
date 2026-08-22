import { describe, expect, it } from 'vitest';

import {
  buildRenderedLaunchOptions,
  renderedChromiumArgs,
  renderedCapabilityExecutablePath,
} from './playwright-renderer.js';

/**
 * The production launch configuration, asserted without launching anything.
 *
 * This suite exists because of a real defect, and the defect is the reason it does not live in the
 * real-Chromium suite. `chromiumSandbox` was never passed. Playwright's `BrowserType.launch`
 * contract defaults it to `false`, so hostile third-party JavaScript ran unsandboxed in the worker
 * process while a comment two lines above the call said the OS sandbox stayed on. Every browser
 * test still passed: a sandbox that is off is invisible from inside the page.
 *
 * So the guarantee is asserted against the shipped options value itself, in the default suite, on
 * every host with or without a browser binary. The real-Chromium suite then proves that same value
 * actually starts a browser.
 */

const launchOptions = buildRenderedLaunchOptions({
  executablePath: '/opt/chromium/chrome',
  proxyServer: 'http://127.0.0.1:41234',
});

describe('production launch configuration', () => {
  it('requests the Chromium OS sandbox explicitly', () => {
    // Not `toBeTruthy`, and not "is not false": the point is that the property is present and
    // `true`, because absent means off.
    expect(launchOptions.chromiumSandbox).toBe(true);
    expect(Object.hasOwn(launchOptions, 'chromiumSandbox')).toBe(true);
  });

  it('never passes a switch that would disable the sandbox', () => {
    // `--no-sandbox` is the workaround that turns every other control in the renderer into
    // decoration, and `--disable-setuid-sandbox` is the half-measure that reads as safer.
    const args = launchOptions.args ?? [];
    for (const forbidden of [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu-sandbox',
      '--no-zygote',
      '--single-process',
    ]) {
      expect(args).not.toContain(forbidden);
    }
    expect(args.some((arg) => arg.includes('sandbox'))).toBe(false);
  });

  it('keeps the egress confinement switches it is launched with', () => {
    const args = launchOptions.args ?? [];
    // The sandbox is the process boundary; these are the network one. Enabling one must never be
    // read as licence to drop the other.
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(args).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(args).toContain('--disable-quic');
    expect(launchOptions.proxy).toEqual({ server: 'http://127.0.0.1:41234' });
  });

  it('runs headless from the binary the capability probe chose', () => {
    expect(launchOptions.headless).toBe(true);
    expect(launchOptions.executablePath).toBe('/opt/chromium/chrome');
  });

  it('cannot have its switch list mutated by a caller', () => {
    // The options object hands out a copy, so a caller that pushes `--no-sandbox` onto what it got
    // back cannot change what the next launch requests.
    const mutated = buildRenderedLaunchOptions({
      executablePath: '/opt/chromium/chrome',
      proxyServer: 'http://127.0.0.1:1',
    });
    mutated.args?.push('--no-sandbox');
    expect(buildRenderedLaunchOptions({ executablePath: 'x', proxyServer: 'y' }).args).not.toContain(
      '--no-sandbox',
    );
    expect(renderedChromiumArgs).not.toContain('--no-sandbox');
  });
});

describe('rendering capability probe', () => {
  it('reports no capability for a configured path that does not exist', () => {
    expect(renderedCapabilityExecutablePath('/nonexistent/chromium/binary')).toBeUndefined();
  });
});
