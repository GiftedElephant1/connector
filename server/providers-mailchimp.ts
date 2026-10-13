import { fetchJson, safeCredential } from './provider-http.ts';
import { ProviderError, type Credential, type ProviderAdapter } from './provider-types.ts';

/** A Mailchimp API key determines its data center, never an arbitrary fetch host. */
export function mailchimpConnection(credential: Credential): { origin: string; headers: Record<string, string> } {
  const token = safeCredential(credential);
  const match = /^[a-f0-9]{32}-(us[1-9]\d{0,2})$/i.exec(token);
  if (!match) throw new ProviderError('Enter a Mailchimp Marketing API key including its data center suffix, for example -us21.');
  return {
    origin: `https://${match[1].toLowerCase()}.api.mailchimp.com/3.0`,
    headers: { authorization: `Basic ${Buffer.from(`connector:${token}`).toString('base64')}` },
  };
}

export const mailchimpAdapters: ProviderAdapter[] = [{
  definition: {
    id: 'mailchimp', name: 'Mailchimp', category: 'communications', authType: 'api_key',
    description: 'Connect your Mailchimp Marketing API key to create email campaign drafts, set their content, send campaigns, and read reports.',
    docsUrl: 'https://mailchimp.com/help/about-api-keys/',
  },
  requiredEnv: [],
  verify: async (credential) => {
    const { origin, headers } = mailchimpConnection(credential);
    const body = await fetchJson('Mailchimp', `${origin}/?fields=account_id,account_name`, { headers });
    if (typeof body.account_id !== 'string' || !body.account_id.trim() || body.account_id.length > 128
      || typeof body.account_name !== 'string' || !body.account_name.trim()) {
      throw new ProviderError('Mailchimp returned an invalid account profile.', 502);
    }
    return { accountId: body.account_id, accountName: body.account_name.slice(0, 300), resources: [] };
  },
}];
