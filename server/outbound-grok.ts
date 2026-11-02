import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';
import { ProviderError } from './provider-types';
import { publicWordPressAddress as publicAddress } from './wordpress-http';

export type GrokConfig = { webhookUrl: string; webhookKey: string };
export type GrokSubmission = { status: 'submitted'; result: string };

type Dependencies = {
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  request?: typeof https.request;
  lookupTimeoutMs?: number;
  requestTimeoutMs?: number;
};

const invalidAddress = () => new ProviderError('Paste the public HTTPS POST to address from your Grok Bot routine’s Webhook section. Local addresses, credentials in URLs, and nonstandard ports are not supported.');
const uncertain = () => new ProviderError('Connector could not confirm the Grok Bot webhook response. The routine may have started; check the Bot’s chat before sending the task again.', 502);
const cancelled = () => new ProviderError('The Grok Bot request was stopped. A routine already received by Grok Bot may still run; check the Bot’s chat before sending the task again.', 409);

/** The routine UI supplies its URL; the public documentation specifies no fixed host/path. */
export function validateGrokConfig(input: unknown): GrokConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidAddress();
  const values = input as Record<string, unknown>;
  if (typeof values.webhookUrl !== 'string' || !values.webhookUrl.trim() || values.webhookUrl.length > 2048) throw invalidAddress();
  const value = values.webhookUrl.trim();
  let url: URL;
  try { url = new URL(value); } catch { throw invalidAddress(); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#') ||
      (url.port && url.port !== '443') || /[\\\s\u0000-\u001f\u007f]/.test(value) ||
      /%(?:00|0a|0d|5c)/i.test(value) || (!host.includes('.') && !isIP(host)) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)\.?$/i.test(host) ||
      (isIP(host) && !publicAddress(host))) throw invalidAddress();
  if (typeof values.webhookKey !== 'string') throw new ProviderError('Paste the key from your Grok Bot routine’s Webhook section.');
  const webhookKey = values.webhookKey.trim();
  if (!webhookKey.length || webhookKey.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(webhookKey)) {
    throw new ProviderError('Paste only the Grok Bot webhook key, without the Authorization header or Bearer prefix.');
  }
  return { webhookUrl: url.href, webhookKey };
}

/** One HTTPS submission, with the verified DNS answer pinned to the TLS connection. */
export function createGrokStarter(dependencies: Dependencies = {}) {
  const lookup = dependencies.lookup || (hostname => dns.lookup(hostname, { all: true, verbatim: true }));
  const request = dependencies.request || https.request;
  return async (input: GrokConfig, prompt: string, taskId: string, signal?: AbortSignal): Promise<GrokSubmission> => {
    const config = validateGrokConfig(input);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000 || Buffer.byteLength(prompt) > 300_000) {
      throw new ProviderError('Provide a Grok Bot task of at most 100,000 characters.');
    }
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new ProviderError('Provide a valid task ID for this Grok Bot request.');
    if (signal?.aborted) throw cancelled();
    const endpoint = new URL(config.webhookUrl);
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
    let addresses: LookupAddress[];
    let lookupDeadline: ReturnType<typeof setTimeout> | undefined;
    let cancelLookup: (() => void) | undefined;
    try {
      addresses = await Promise.race([
        lookup(hostname),
        new Promise<never>((_resolve, reject) => {
          lookupDeadline = setTimeout(() => reject(uncertain()), dependencies.lookupTimeoutMs ?? 10_000);
          cancelLookup = () => reject(cancelled());
          signal?.addEventListener('abort', cancelLookup, { once: true });
          if (signal?.aborted) cancelLookup();
        }),
      ]);
    } catch {
      if (signal?.aborted) throw cancelled();
      throw new ProviderError('Connector could not resolve the Grok Bot webhook address. No task was sent.', 502);
    } finally {
      clearTimeout(lookupDeadline);
      if (cancelLookup) signal?.removeEventListener('abort', cancelLookup);
    }
    if (!addresses.length || addresses.some(item => !publicAddress(item.address) || isIP(item.address) !== item.family)) {
      throw new ProviderError('The Grok Bot webhook must resolve only to public internet addresses. Local, private, and reserved networks are not supported.');
    }
    if (signal?.aborted) throw cancelled();
    const address = addresses[0];
    // These fields are Connector's routine-input convention, not a Grok model API schema.
    const body = JSON.stringify({ taskId, prompt });
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let cancelRequest: (() => void) | undefined;
      let outgoing: ReturnType<typeof https.request> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (cancelRequest) signal?.removeEventListener('abort', cancelRequest);
        if (error) reject(error);
        else resolve({ status: 'submitted', result: 'Grok Bot accepted the task and started the routine. This is not a completed answer; check the Bot’s chat for the result.' });
      };
      try {
        outgoing = request(endpoint, {
          method: 'POST', agent: false,
          // Retain hostname/SNI and normal certificate verification, but never
          // resolve again, reuse a pooled socket, or follow an upstream redirect.
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
          headers: {
            accept: 'application/json', 'content-type': 'application/json',
            authorization: `Bearer ${config.webhookKey}`, 'content-length': Buffer.byteLength(body),
          },
        }, incoming => {
          incoming.on('error', () => finish(uncertain()));
          incoming.on('aborted', () => finish(uncertain()));
          if (incoming.statusCode === 200) finish();
          else if (incoming.statusCode === 401 || incoming.statusCode === 403) finish(new ProviderError('Grok Bot rejected the webhook key. Copy the current key from that routine and save it again.', incoming.statusCode));
          else if (incoming.statusCode === 429) finish(new ProviderError('Grok Bot rate limited this routine. Check its status and usage before starting a new task.', 429));
          else if (incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400) finish(new ProviderError('The Grok Bot webhook returned a redirect, which Connector did not follow. Copy its current POST to address from the routine.', 502));
          else finish(new ProviderError('Grok Bot did not accept this webhook request. Check the routine’s address, active status, key, and usage before trying again.', 502));
          // Status 200 is the documented acknowledgement. Bodies are neither
          // needed nor trusted; stop immediately without reading/logging them.
          incoming.destroy();
          outgoing?.destroy();
        });
        outgoing.on('error', () => { finish(uncertain()); outgoing?.destroy(); });
        cancelRequest = () => { finish(cancelled()); outgoing?.destroy(); };
        signal?.addEventListener('abort', cancelRequest, { once: true });
        deadline = setTimeout(() => { finish(uncertain()); outgoing?.destroy(); }, dependencies.requestTimeoutMs ?? 15_000);
        if (signal?.aborted) { cancelRequest(); return; }
        outgoing.end(body);
      } catch { finish(uncertain()); outgoing?.destroy(); }
    });
  };
}

export const startGrok = createGrokStarter();
