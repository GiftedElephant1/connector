import type { AppConfig } from './config';
import type { ProviderService } from './app';
import { Store, hash } from './store';
import { ProviderError, type Credential, type VerifiedAccount } from './provider-types';
import { settingsSnapshot, saveSettings, providerSettingKeys } from './settings';
import type { WorkspaceAccounts } from './workspace-accounts';
import type { OutboundAI } from './outbound-ai';
import type { PublicTunnel } from './tunnel';
import { normalizeWordPressSite } from './wordpress-http';
import type { OnePasswordTargets } from './onepassword';
import type { OnePasswordTarget, OnePasswordTargetField } from './onepassword-types';

const field = (key: string, label: string, secret = true, required = true, source: 'vault' | 'literal' = 'vault'): OnePasswordTargetField => ({ key, label, secret, required, source });

/** Fixed credential destinations. No URLs, commands, headers or arbitrary settings are supplied by an AI. */
export function onePasswordTargets(config: AppConfig, store: Store, service: ProviderService, env: NodeJS.ProcessEnv,
  workspace: WorkspaceAccounts, outbound: OutboundAI, tunnel?: PublicTunnel, localOrigin?: string): OnePasswordTargets {
  const catalog = (): OnePasswordTarget[] => {
    const settings = settingsSnapshot(config, store, env).fields;
    const credentials: OnePasswordTarget[] = service.providerCatalog.filter(provider => provider.authType === 'api_key').map(provider => ({
      id: `connection:${provider.id}`, label: `${provider.name} connection`, agentUsable: true,
      description: 'Retrieve and verify this account’s credentials, then save an encrypted copy in Connector. Existing AI platform permissions determine who can use the connected account.',
      fields: [field('apiKey', provider.id === 'wordpress-self-hosted' ? 'Application password' : 'API key or access token'), ...(provider.credentialFields || []).map(item => field(item.name, item.label, !!item.secret, true, item.name === 'siteUrl' ? 'literal' : 'vault'))],
    }));
    const applications: OnePasswordTarget[] = [...service.providerCatalog, { id: 'google-workspace', name: 'Google Workspace' }].flatMap(provider => {
      const keys = new Set(providerSettingKeys(provider.id));
      const selected = settings.filter(item => keys.has(item.key) && (item.secret || /(?:_CLIENT_ID|_CLIENT_KEY|_APP_ID)$/.test(item.key)));
      return selected.length ? [{ id: `settings:${provider.id}`, label: `${provider.name} application settings`, agentUsable: false,
        description: 'Owner only. Import application credentials; finish the provider’s official account sign-in and consent separately. Client IDs are visible in normal application settings.',
        fields: selected.map(item => field(item.key, item.label, item.secret, false)) }] : [];
    });
    return [...credentials, ...applications,
      { id: 'outbound:cursor', label: 'Cursor task sending API key', agentUsable: true, description: 'Save the Cursor account key. Choose a subscription model and enable task sending separately in AI connections.', fields: [field('apiKey', 'Cursor API key')] },
      { id: 'outbound:grok', label: 'Grok Bot routine credentials', agentUsable: true, description: 'Save the routine webhook URL and key. This does not enable task sending or trigger the routine.', fields: [field('webhookUrl', 'Grok routine webhook URL'), field('webhookKey', 'Grok routine webhook key')] },
      ...workspace.listAccounts().map(account => ({ id: `maps:${account.id}`, label: `Google Maps key for ${account.email}`, agentUsable: true,
        description: 'Save a Maps project key for this connected account. Google Workspace agent app permissions still apply.', fields: [field('apiKey', 'Google Maps project API key')] })),
      ...(tunnel ? [{ id: 'tunnel:ngrok', label: 'ngrok public access authtoken', agentUsable: false,
        description: 'Owner only. Save the authtoken for the next public-access start. This does not change the public address or restart the tunnel.', fields: [field('authtoken', 'ngrok authtoken')] }] : []),
    ];
  };
  const stamp = (targetId: string): string => {
    const [kind, id] = targetId.split(':');
    if (kind === 'connection') return hash(JSON.stringify({ generation: store.connectionGeneration(id), credential: store.credential(id), settings: providerSettingKeys(id).map(key => env[key]) }));
    if (kind === 'settings') return hash(JSON.stringify({ generation: store.connectionGeneration(id), settings: providerSettingKeys(id).map(key => env[key]), saved: store.readSetting('provider-overrides') }));
    if (kind === 'maps') return hash(JSON.stringify({ generation: store.connectionGeneration(`google-workspace:${id}`), mapsGeneration: store.connectionGeneration(`google-workspace:${id}:maps`), credential: store.credential(`google-workspace:${id}`) }));
    if (kind === 'outbound') return hash(JSON.stringify(store.readSetting('outbound-ai-v1')));
    if (targetId === 'tunnel:ngrok') return hash(JSON.stringify({ saved: store.readSetting('public-tunnel'), current: tunnel?.snapshot() }));
    throw new ProviderError('This 1Password credential destination is unavailable.', 404);
  };
  return { catalog, prepare(targetId) {
    const target = catalog().find(item => item.id === targetId);
    if (!target) throw new ProviderError('This 1Password credential destination is unavailable.', 404);
    const before = stamp(targetId);
    const assertUnchanged = () => {
      if (!catalog().some(item => item.id === targetId) || before !== stamp(targetId)) throw new ProviderError('This destination changed while 1Password was waiting. Review the saved link before trying again.', 409);
    };
    return { assertUnchanged, async apply(values, assertCurrent) {
      const [kind, id] = targetId.split(':');
      assertCurrent();
      const invalid = () => new ProviderError('Connector could not apply the selected 1Password fields. Check the field mapping and destination setup.', 422);
      if (kind === 'connection') {
          let credential: Credential;
          try {
          const provider = service.getProvider(id);
          if (provider.authType !== 'api_key') throw new Error('Unsupported credential type');
          const fields = Object.fromEntries((provider.credentialFields || []).map(item => [item.name, values[item.name]]));
          // The owner pins the destination outside 1Password. Updating a vault
          // item cannot redirect a saved website password to another server.
          if (id === 'wordpress-self-hosted') fields.siteUrl = normalizeWordPressSite(fields.siteUrl);
          credential = { accessToken: values.apiKey, ...(Object.keys(fields).length ? { fields } : {}) };
          } catch { throw invalid(); }
          let account: VerifiedAccount;
          try { account = await service.verifyConnection(id, credential, env); }
          catch { throw new ProviderError('The destination could not verify the selected 1Password credentials. Check the item, account access, and Internet connection.', 422); }
          assertCurrent();
          // Never allow an upstream echo of a credential into account summaries.
          const secrets = target.fields.filter(item => item.secret).map(item => values[item.key]).filter(Boolean);
          const clean = (value: unknown): unknown => typeof value === 'string' ? secrets.reduce((result, secret) => result.split(secret).join('[redacted]'), value)
            : Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value;
          store.save(id, credential, clean(account) as VerifiedAccount);
      } else try {
        if (kind === 'settings') {
          saveSettings(config, store, env, { values }, localOrigin);
        } else if (kind === 'outbound') {
          const current = outbound.snapshot().providers.find(item => item.id === id)!;
          outbound.configure(id, { enabled: current.enabled, ...values });
        } else if (kind === 'maps') {
          workspace.saveMapsKey(id, values.apiKey);
        } else if (targetId === 'tunnel:ngrok' && tunnel) {
          tunnel.saveAuthtoken(values.authtoken);
        } else throw new Error('Unsupported destination');
      } catch { throw invalid(); }
    } };
  } };
}
