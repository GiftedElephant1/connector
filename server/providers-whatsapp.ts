import { fetchJson, safeCredential } from './provider-http.ts';
import { ProviderError, type Credential, type ProviderAdapter, type VerifiedAccount } from './provider-types.ts';

const graphOrigin = 'https://graph.facebook.com/v26.0';

/** Graph paths are always built from numeric object IDs on Meta's fixed official origin. */
export function whatsappId(value: string | undefined, label: string): string {
  const id = value?.trim();
  if (!id || !/^\d{1,40}$/.test(id)) throw new ProviderError(`${label} must be a Meta numeric ID.`);
  return id;
}

export function whatsappPhoneId(credential: Credential): string {
  return whatsappId(credential.fields?.phoneNumberId, 'Phone number ID');
}

export function whatsappUrl(id: string, edge = '', params: Record<string, string> = {}): string {
  const url = new URL(`${graphOrigin}/${id}${edge ? `/${edge}` : ''}`);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

async function verify(credential: Credential): Promise<VerifiedAccount> {
  const phoneId = whatsappPhoneId(credential);
  const body = await fetchJson('WhatsApp Business', whatsappUrl(phoneId, '', {
    fields: 'id,display_phone_number,verified_name',
  }), { headers: { authorization: `Bearer ${safeCredential(credential)}` } });
  if (body.error) throw new ProviderError('WhatsApp Business denied access. Check the token and phone number permissions.', 403);
  if (body.id !== phoneId || typeof body.display_phone_number !== 'string' || !body.display_phone_number.trim()) {
    throw new ProviderError('WhatsApp Business returned an invalid phone number profile.', 502);
  }
  const accountName = typeof body.verified_name === 'string' && body.verified_name.trim()
    ? `${body.verified_name} (${body.display_phone_number})` : body.display_phone_number;
  return {
    accountId: phoneId,
    accountName,
    resources: [{ id: phoneId, name: accountName, type: 'whatsapp-phone-number' }],
  };
}

export const whatsappAdapters: ProviderAdapter[] = [{
  definition: {
    id: 'whatsapp', name: 'WhatsApp Business', category: 'communications', authType: 'api_key',
    description: 'Connect a WhatsApp Business Cloud API phone number to send messages and approved templates. Requires a Meta access token; personal WhatsApp accounts are not supported.',
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
    credentialFields: [{ name: 'phoneNumberId', label: 'Phone number ID' }],
  },
  requiredEnv: [],
  verify,
}];
