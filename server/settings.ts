import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './config';
import { parseAppOrigin } from './config';
import { ProviderError, providerSetupRequirements, type ProviderDefinition } from './providers';
import { Store } from './store';
import { hydratePipelineKey } from './pipeline-key';
import { oauthCallbackUrl } from './oauth-callback';

export interface SettingField {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  value?: string;
  help?: string;
  options?: string[];
  providerIds: string[];
  required?: boolean;
}
interface FieldDefinition { label: string; secret?: boolean; help?: string; options?: string[]; defaultValue?: string }
const definitions: Record<string, FieldDefinition> = {
  APP_ORIGIN: { label: 'Public HTTPS address', help: 'The address your AI assistants and platform callbacks use. The local dashboard remains available on this PC.' },
  META_APP_ID: { label: 'Meta app ID' }, META_APP_SECRET: { label: 'Meta app secret', secret: true },
  META_API_VERSION: { label: 'Meta API version', defaultValue: 'v26.0' },
  THREADS_APP_ID: { label: 'Threads app ID', help: 'Copy Threads app ID from the Threads section of your Meta developer app. It is different from the general Meta App ID.' },
  THREADS_APP_SECRET: { label: 'Threads app secret', secret: true, help: 'Use Show beside the matching Threads app secret, then copy the revealed value. When changing the Threads app ID, replace this secret too; leaving it blank keeps the previous secret.' },
  THREADS_API_VERSION: { label: 'Threads API version', defaultValue: 'v1.0', help: 'Use v1.0 for Threads. The Facebook/Instagram Meta API version is a separate setting.' },
  GOOGLE_CLIENT_ID: { label: 'Google OAuth client ID' }, GOOGLE_CLIENT_SECRET: { label: 'Google OAuth client secret', secret: true },
  GOOGLE_ADS_DEVELOPER_TOKEN: { label: 'Google Ads developer token', secret: true },
  X_CLIENT_ID: { label: 'X OAuth client ID' }, X_CLIENT_SECRET: { label: 'X OAuth client secret', secret: true },
  TIKTOK_CLIENT_KEY: { label: 'TikTok client key' }, TIKTOK_CLIENT_SECRET: { label: 'TikTok client secret', secret: true },
  SNAPCHAT_CLIENT_ID: { label: 'Snapchat client ID', help: 'Use an OAuth application created in Snap Business Manager, allowlisted for the Public Profile API. This is not a Snap Kit Login Kit application.' },
  SNAPCHAT_CLIENT_SECRET: { label: 'Snapchat client secret', secret: true, help: 'Use the matching Public Profile application secret. Saved separately from Snapchat Ads.' },
  SNAPCHAT_ORGANIZATION_ID: { label: 'Snapchat organization ID', help: 'Optional: enter your Snap Business organization ID to discover its Public Profiles. Leave blank to verify your own Public Profile. Use the organization ID, not an ad account or profile ID.' },
  SNAPCHAT_ADS_CLIENT_ID: { label: 'Snapchat Ads client ID', help: 'Use the OAuth application from Snap Business Manager for Marketing API access. Register the separate Snapchat Ads redirect URL.' },
  SNAPCHAT_ADS_CLIENT_SECRET: { label: 'Snapchat Ads client secret', secret: true, help: 'Use the secret belonging to the Snapchat Ads client ID above. This does not replace your content connection credentials.' },
  LINKEDIN_CLIENT_ID: { label: 'LinkedIn client ID' }, LINKEDIN_CLIENT_SECRET: { label: 'LinkedIn client secret', secret: true },
  LINKEDIN_COMBINE_SCOPES: { label: 'Use LinkedIn Pages and Ads together', options: ['false', 'true'], defaultValue: 'false', help: 'Enable when using both LinkedIn and Campaign Manager with this app and all listed permissions are approved. Both sign-ins will request the same permissions so one does not invalidate the other. Save, then update permissions on both connections once. Changing these permission choices later requires updating both again.' },
  LINKEDIN_ENABLE_MEMBER_READ: { label: 'Approved LinkedIn member reading', options: ['false', 'true'], defaultValue: 'false', help: 'Enable only after LinkedIn grants r_member_social, then reconnect LinkedIn.' },
  LINKEDIN_ENABLE_ORGANIZATIONS: { label: 'Approved LinkedIn company pages', options: ['false', 'true'], defaultValue: 'false', help: 'Enable after LinkedIn grants rw_organization_admin, r_organization_social and w_organization_social. Save, then update LinkedIn permissions to discover Pages you manage and let your AI use them.' },
  LINKEDIN_ENABLE_CONVERSIONS: { label: 'Approved LinkedIn conversion uploads', options: ['false', 'true'], defaultValue: 'false', help: 'Enable only after LinkedIn grants rw_conversions, then reconnect LinkedIn Ads.' },
  LINKEDIN_API_VERSION: { label: 'LinkedIn API version', defaultValue: '202601' },
  REDDIT_CLIENT_ID: { label: 'Reddit client ID' }, REDDIT_CLIENT_SECRET: { label: 'Reddit client secret', secret: true },
  REDDIT_ADS_CLIENT_ID: { label: 'Reddit Ads client ID', help: 'Copy the App ID from Reddit Ads Business Manager → Developer Portal → Developer Applications. This is different from your business ID and ad account ID.' },
  REDDIT_ADS_CLIENT_SECRET: { label: 'Reddit Ads client secret', secret: true, help: 'Paste the generated secret from the same Reddit Ads application as the App ID above. When changing the App ID, replace its secret too. Leaving this blank keeps the saved secret.' },
  REDDIT_USER_AGENT: { label: 'Reddit user agent', help: 'For example: web:my-connector:1.0 (by /u/your_username)' },
  REDDIT_ADS_ACCOUNT_ID: { label: 'Reddit Ads account ID', help: 'Select the intended account under Reddit Business Manager → Assets → Ad Accounts and copy its ad account ID. Do not use the Business ID, App ID, or Reddit username. The Reddit user approving access must have access to this advertising account.' }, REDDIT_CONVERSIONS_TOKEN: { label: 'Reddit conversion token', secret: true },
  PINTEREST_CLIENT_ID: { label: 'Pinterest app ID' }, PINTEREST_CLIENT_SECRET: { label: 'Pinterest app secret', secret: true },
  PINTEREST_ADS_CLIENT_ID: { label: 'Pinterest Ads app ID', help: 'Use a Pinterest developer app with approved advertising access. These settings are separate from the Pinterest boards and Pins connection.' },
  PINTEREST_ADS_CLIENT_SECRET: { label: 'Pinterest Ads app secret', secret: true, help: 'Copy the secret belonging to the Pinterest Ads app ID above. Saving it here does not replace your organic Pinterest credentials.' },
  WORDPRESS_CLIENT_ID: { label: 'WordPress client ID' }, WORDPRESS_CLIENT_SECRET: { label: 'WordPress client secret', secret: true },
  MICROSOFT_CLIENT_ID: { label: 'Microsoft application client ID' }, MICROSOFT_CLIENT_SECRET: { label: 'Microsoft client secret', secret: true },
  MICROSOFT_ADS_DEVELOPER_TOKEN: { label: 'Microsoft Advertising developer token', secret: true },
  TIKTOK_BUSINESS_APP_ID: { label: 'TikTok Business app ID' }, TIKTOK_BUSINESS_APP_SECRET: { label: 'TikTok Business app secret', secret: true },
  TIKTOK_EVENTS_ACCESS_TOKEN: { label: 'TikTok Events access token', secret: true },
  TIKTOK_BUSINESS_ACCOUNT_AUTH_URL: { label: 'TikTok account holder authorization URL', help: 'Optional for advertiser access. For account-holder authorization, activate the account-holder redirect shown above in TikTok for Business → My Apps → App Detail → Basic Information, then copy its generated authorization URL here. Requires TikTok Accounts approval. This is separate from the redirect URL.' },
  X_ADS_API_VERSION: { label: 'X Ads API version', defaultValue: '12' },
  DISCORD_CLIENT_ID: { label: 'Discord client ID' }, DISCORD_CLIENT_SECRET: { label: 'Discord client secret', secret: true },
  DISCORD_BOT_TOKEN: { label: 'Discord bot token', secret: true, help: 'Optional for account verification; required to send messages as your installed Discord bot.' },
  XAI_MODEL: { label: 'xAI API bot model', defaultValue: 'grok-4' },
};
const optionalFields: Record<string, string[]> = {
  snapchat: ['SNAPCHAT_ORGANIZATION_ID'],
  facebook: ['META_API_VERSION'], instagram: ['META_API_VERSION'], 'meta-business': ['META_API_VERSION'],
  threads: ['THREADS_API_VERSION'],
  'google-workspace': ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  discord: ['DISCORD_BOT_TOKEN'],
  linkedin: ['LINKEDIN_COMBINE_SCOPES', 'LINKEDIN_ENABLE_MEMBER_READ', 'LINKEDIN_ENABLE_ORGANIZATIONS', 'LINKEDIN_ENABLE_CONVERSIONS', 'LINKEDIN_API_VERSION'],
  'linkedin-ads': ['LINKEDIN_COMBINE_SCOPES', 'LINKEDIN_ENABLE_MEMBER_READ', 'LINKEDIN_ENABLE_ORGANIZATIONS', 'LINKEDIN_ENABLE_CONVERSIONS', 'LINKEDIN_API_VERSION'],
  'reddit-ads': ['REDDIT_USER_AGENT', 'REDDIT_CONVERSIONS_TOKEN'],
  'tiktok-business': ['TIKTOK_EVENTS_ACCESS_TOKEN', 'TIKTOK_BUSINESS_ACCOUNT_AUTH_URL'],
  'x-ads': ['X_ADS_API_VERSION'],
  xai: ['XAI_MODEL'],
};
const setupUrls: Record<string, string> = {
  snapchat: 'https://ads.snapchat.com/', 'snapchat-ads': 'https://ads.snapchat.com/',
  'microsoft-ads': 'https://entra.microsoft.com/', discord: 'https://discord.com/developers/applications',
  openai: 'https://platform.openai.com/api-keys', anthropic: 'https://console.anthropic.com/settings/keys', xai: 'https://console.x.ai/',
  facebook: 'https://developers.facebook.com/apps/', instagram: 'https://developers.facebook.com/apps/', 'meta-business': 'https://developers.facebook.com/apps/', threads: 'https://developers.facebook.com/apps/', whatsapp: 'https://developers.facebook.com/apps/',
  youtube: 'https://console.cloud.google.com/apis/credentials', 'google-ads': 'https://console.cloud.google.com/apis/credentials', 'google-analytics': 'https://console.cloud.google.com/apis/credentials', 'search-console': 'https://console.cloud.google.com/apis/credentials',
  x: 'https://developer.x.com/', 'x-ads': 'https://developer.x.com/', tiktok: 'https://developers.tiktok.com/', 'tiktok-business': 'https://business-api.tiktok.com/portal/',
  'tiktok-business-account': 'https://business-api.tiktok.com/portal/',
  linkedin: 'https://www.linkedin.com/developers/apps', 'linkedin-ads': 'https://www.linkedin.com/developers/apps',
  reddit: 'https://www.reddit.com/prefs/apps', 'reddit-ads': 'https://ads.reddit.com/',
  pinterest: 'https://developers.pinterest.com/', 'pinterest-ads': 'https://developers.pinterest.com/', wordpress: 'https://developer.wordpress.com/apps/',
  'wordpress-self-hosted': 'https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/',
  mailchimp: 'https://mailchimp.com/help/about-api-keys/',
};
const overrideName = 'provider-overrides';
const passwordName = 'owner-password';

function originValue(value: string): string {
  try { return parseAppOrigin(value).origin; }
  catch { throw new ProviderError('Enter an HTTPS address without a path, query, or credentials. Local addresses may use HTTP.'); }
}
export function updatePublicOrigin(config: AppConfig, store: Store, env: NodeJS.ProcessEnv, value: string): void {
  const origin = originValue(value);
  const overrides = store.readSetting<Record<string, string>>(overrideName) || {};
  store.writeSetting(overrideName, { ...overrides, APP_ORIGIN: origin });
  env.APP_ORIGIN = origin;
  config.origin = origin;
  config.secureCookies = origin.startsWith('https:');
}
export function hydrateSettings(config: AppConfig, store: Store, env: NodeJS.ProcessEnv): void {
  const overrides = store.readSetting<Record<string, string>>(overrideName) || {};
  for (const [key, value] of Object.entries(overrides)) {
    if (Object.hasOwn(definitions, key) && typeof value === 'string') env[key] = value;
  }
  if (overrides.APP_ORIGIN) {
    config.origin = originValue(overrides.APP_ORIGIN);
    config.secureCookies = config.origin.startsWith('https:');
  }
  hydratePipelineKey(config, store, env);
}
export const providerSettingKeys = (id: string) => [...new Set([...(providerSetupRequirements[id] || []), ...(optionalFields[id] || [])])].filter(key => Object.hasOwn(definitions, key));
const providerKeys = providerSettingKeys;
/** Persist blank overrides so a restart cannot restore reset credentials from .env. */
export function clearProviderSettings(store: Store, env: NodeJS.ProcessEnv, keys: string[]): void {
  const next = { ...(store.readSetting<Record<string, string>>(overrideName) || {}) };
  for (const key of keys) {
    if (key === 'APP_ORIGIN' || !Object.hasOwn(definitions, key)) throw new ProviderError('That setting cannot be cleared by a connector reset.');
    next[key] = '';
  }
  store.writeSetting(overrideName, next);
  for (const key of keys) env[key] = '';
}
function field(key: string, env: NodeJS.ProcessEnv): SettingField {
  const definition = definitions[key];
  const value = key === 'APP_ORIGIN' ? env.APP_ORIGIN || '' : env[key] ?? definition.defaultValue ?? '';
  return {
    key, label: definition.label, secret: !!definition.secret, configured: !!value.trim(),
    ...(definition.secret ? {} : { value }),
    ...(definition.help ? { help: definition.help } : {}),
    ...(definition.options ? { options: definition.options } : {}),
    providerIds: [...new Set([...Object.keys(providerSetupRequirements), ...Object.keys(optionalFields)])].filter(id => providerKeys(id).includes(key)),
  };
}
export function settingsSnapshot(config: AppConfig, store: Store, env: NodeJS.ProcessEnv, localOrigin?: string) {
  return {
    origin: config.origin, ...(localOrigin ? { localOrigin } : {}),
    fields: Object.keys(definitions).map(key => field(key, key === 'APP_ORIGIN' ? { ...env, APP_ORIGIN: config.origin } : env)),
    passwordConfigured: !!store.readSetting(passwordName), pipelineConfigured: !!config.pipelineKey,
  };
}
export function providerSettings(provider: ProviderDefinition, config: AppConfig, env: NodeJS.ProcessEnv) {
  const required = providerSetupRequirements[provider.id] || [];
  return {
    id: provider.id, name: provider.name, docsUrl: provider.docsUrl, setupUrl: setupUrls[provider.id] || provider.docsUrl,
    fields: providerKeys(provider.id).filter(key => Object.hasOwn(definitions, key)).map(key => ({ ...field(key, env), required: required.includes(key) })),
    ...(provider.authType === 'oauth' ? { callbackUrl: oauthCallbackUrl(config.origin, provider.id) } : {}),
  };
}
export function saveSettings(config: AppConfig, store: Store, env: NodeJS.ProcessEnv, body: unknown, localOrigin?: string): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('Provide the settings to save.');
  const { values, reset = [] } = body as { values?: unknown; reset?: unknown };
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new ProviderError('Provide settings as named values.');
  if (!Array.isArray(reset) || reset.some(key => typeof key !== 'string' || !Object.hasOwn(definitions, key) || key === 'APP_ORIGIN')) throw new ProviderError('Choose valid settings to clear.');
  const next = { ...(store.readSetting<Record<string, string>>(overrideName) || {}) };
  for (const [key, rawValue] of Object.entries(values)) {
    if (!Object.hasOwn(definitions, key)) throw new ProviderError('That setting cannot be changed in the dashboard.');
    if (typeof rawValue !== 'string' || rawValue.length > 8192 || /[\r\n\0]/.test(rawValue)) throw new ProviderError('Setting values must be a single line of text.');
    const definition = definitions[key];
    let value = rawValue.trim();
    if (definition.secret && !value) continue;
    if (definition.options && !definition.options.includes(value)) throw new ProviderError(`Choose a supported value for ${definition.label}.`);
    if (key === 'APP_ORIGIN') {
      value = originValue(value);
      if (!value.startsWith('https:') && value !== localOrigin && value !== config.origin) throw new ProviderError('Use your configured local address or a public HTTPS address.');
    }
    if (key === 'LINKEDIN_API_VERSION' && value && !/^\d{6}$/.test(value)) throw new ProviderError('LinkedIn API versions use six digits, such as 202601.');
    if (['META_API_VERSION', 'THREADS_API_VERSION'].includes(key) && value && !/^v\d+\.\d+$/.test(value)) throw new ProviderError('Meta and Threads API versions use a version such as v26.0 or v1.0.');
    if (key === 'X_ADS_API_VERSION' && value && !/^\d{1,3}$/.test(value)) throw new ProviderError('X Ads API versions use a numeric version.');
    next[key] = value;
  }
  for (const key of reset as string[]) next[key] = '';
  store.writeSetting(overrideName, next);
  hydrateSettings(config, store, env);
}
export function passwordMatches(store: Store, config: AppConfig, password: string): boolean {
  const saved = store.readSetting<{ salt: string; hash: string }>(passwordName);
  if (saved) {
    const actual = scryptSync(password, saved.salt, 64);
    const expected = Buffer.from(saved.hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  // Hash both strings to keep comparison time independent of the password length.
  return timingSafeEqual(scryptSync(password, 'connector-initial-password', 64), scryptSync(config.password, 'connector-initial-password', 64));
}
export function savePassword(store: Store, password: unknown): void {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024 || /[\r\n\0]/.test(password)) throw new ProviderError('Choose a password with 12 to 1,024 characters.');
  const salt = randomBytes(32).toString('hex');
  store.writeSetting(passwordName, { salt, hash: scryptSync(password, salt, 64).toString('hex') });
  store.deleteAllSessions();
}
