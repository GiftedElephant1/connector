import { ProviderError, type Credential, type OAuthExchange, type OAuthRequest, type ProviderAdapter, type ProviderDefinition, type Resource, type VerifiedAccount } from './provider-types.ts';
import { fetchJson, isObject, safeCredential, type JsonObject } from './provider-http.ts';
import { metaAdapters } from './providers-meta.ts';
import { googleAdapters } from './providers-google.ts';
import { socialAdapters } from './providers-social.ts';
import { adsAdapters } from './providers-ads.ts';
import { discordAdapters } from './providers-discord.ts';
import { whatsappAdapters } from './providers-whatsapp.ts';
import { wordpressAdapters } from './providers-wordpress.ts';
import { mailchimpAdapters } from './providers-mailchimp.ts';
import { obsidianAdapters } from './providers-obsidian.ts';
import { pinterestAdsAdapter } from './providers-pinterest-ads.ts';
import { tiktokAccountAdapter } from './providers-tiktok-account';
import { snapchatAdapter } from './providers-snapchat';
import { snapchatAdsAdapter } from './providers-snapchat-ads';

export * from './provider-types.ts';

const aiDefinitions: ProviderDefinition[] = [
  {
    id: 'openai', name: 'OpenAI', category: 'ai', authType: 'api_key',
    description: 'Connect an OpenAI API key and verify available models. API access is separate from a ChatGPT subscription.',
    docsUrl: 'https://platform.openai.com/docs/api-reference/models/list',
  },
  {
    id: 'anthropic', name: 'Anthropic', category: 'ai', authType: 'api_key',
    description: 'Connect an Anthropic API key and verify available models. API access is separate from a Claude subscription.',
    docsUrl: 'https://docs.anthropic.com/en/api/models-list',
  },
  {
    id: 'xai', name: 'xAI', category: 'ai', authType: 'api_key',
    description: 'Connect an xAI API key and verify available models. API access is separate from a Grok subscription.',
    docsUrl: 'https://docs.x.ai/developers/rest-api-reference/inference/models',
  },
];

function modelResources(providerName: string, body: JsonObject): Resource[] {
  if (!Array.isArray(body.data)) throw new ProviderError(`${providerName} returned an unexpected model list.`, 502);
  return body.data.filter(isObject).filter((model) => typeof model.id === 'string').slice(0, 100).map((model) => ({
    id: String(model.id).slice(0, 300),
    name: typeof model.display_name === 'string' ? model.display_name.slice(0, 300) : String(model.id).slice(0, 300),
    type: 'model',
  }));
}

const aiAdapters: ProviderAdapter[] = aiDefinitions.map((definition) => ({
  definition,
  requiredEnv: [],
  verify: async (credential) => {
    const token = safeCredential(credential);
    const endpoints: Record<string, string> = {
      openai: 'https://api.openai.com/v1/models',
      anthropic: 'https://api.anthropic.com/v1/models?limit=100',
      xai: 'https://api.x.ai/v1/models',
    };
    const headers: Record<string, string> = definition.id === 'anthropic'
      ? { 'x-api-key': token, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${token}` };
    const body = await fetchJson(definition.name, endpoints[definition.id], { headers });
    return { accountName: `${definition.name} API account`, resources: modelResources(definition.name, body) };
  },
}));

const adapters: ProviderAdapter[] = [...aiAdapters, ...socialAdapters, snapchatAdapter, ...metaAdapters, ...googleAdapters, ...adsAdapters, pinterestAdsAdapter, snapchatAdsAdapter, tiktokAccountAdapter, ...discordAdapters, ...whatsappAdapters, ...wordpressAdapters, ...mailchimpAdapters, ...obsidianAdapters];
const byId = new Map(adapters.map((adapter) => [adapter.definition.id, adapter]));
if (byId.size !== adapters.length) throw new Error('Provider IDs must be unique.');
export const providerCatalog = adapters.map((adapter) => adapter.definition).filter(provider => !provider.auxiliaryFor);
export const auxiliaryProviderCatalog = adapters.map((adapter) => adapter.definition).filter(provider => provider.auxiliaryFor);
export const providerSetupRequirements: Record<string, string[]> = Object.fromEntries(adapters.map((adapter) => [adapter.definition.id, [...adapter.requiredEnv]]));

function getAdapter(id: string): ProviderAdapter {
  const adapter = byId.get(id);
  if (!adapter) throw new ProviderError('This provider is not supported.', 404);
  return adapter;
}

export function getProvider(id: string): ProviderDefinition { return getAdapter(id).definition; }

export function getProviderSetup(id: string, env: NodeJS.ProcessEnv): { configured: boolean; missing: string[] } {
  const missing = getAdapter(id).requiredEnv.filter((name) => !env[name]?.trim());
  return { configured: missing.length === 0, missing };
}

function requireSetup(id: string, env: NodeJS.ProcessEnv): void {
  if (!getProviderSetup(id, env).configured) {
    throw new ProviderError(`${getProvider(id).name} needs its server configuration before it can connect.`);
  }
}

export function createOAuthRequest(id: string, input: OAuthRequest): string {
  const adapter = getAdapter(id);
  if (!adapter.authorize) throw new ProviderError('This provider uses an API key or access token.');
  requireSetup(id, input.env);
  return adapter.authorize(input);
}

export async function exchangeOAuthCode(id: string, input: OAuthExchange): Promise<Credential> {
  const adapter = getAdapter(id);
  if (!adapter.exchange) throw new ProviderError('This provider uses an API key or access token.');
  requireSetup(id, input.env);
  return adapter.exchange(input);
}

export async function verifyConnection(id: string, credential: Credential, env: NodeJS.ProcessEnv): Promise<VerifiedAccount> {
  const adapter = getAdapter(id);
  safeCredential(credential);
  requireSetup(id, env);
  return adapter.verify(credential, env);
}

export async function refreshCredential(id: string, credential: Credential, env: NodeJS.ProcessEnv): Promise<Credential> {
  const adapter = getAdapter(id);
  safeCredential(credential);
  if (!credential.expiresAt || credential.expiresAt > Date.now() + 60_000) return credential;
  if (adapter.refresh) {
    requireSetup(id, env);
    return adapter.refresh(credential, env);
  }
  if (credential.expiresAt <= Date.now()) {
    throw new ProviderError(`${adapter.definition.name} access has expired. Reconnect this account.`, 401);
  }
  return credential;
}
