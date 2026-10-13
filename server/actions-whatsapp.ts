import { apiJson, bearer, required, records, string } from './action-http.ts';
import { isObject } from './provider-http.ts';
import { ProviderError, type Credential } from './provider-types.ts';
import { whatsappId, whatsappPhoneId, whatsappUrl } from './providers-whatsapp.ts';
import type { ActionAdapter, ActionField, ActionValues } from './action-types.ts';

const recipientField: ActionField = {
  name: 'recipient', label: 'Recipient phone number', type: 'text', required: true,
  help: 'International number including country code, for example +886912345678. The recipient must have opted in to business messages.',
};
const contentField: ActionField = { name: 'content', label: 'Message', type: 'textarea', required: true, help: 'Up to 4,096 characters.' };
const serviceWindowField: ActionField = {
  name: 'serviceWindow', label: 'Customer service window', type: 'select', required: true,
  options: [{ value: 'open', label: 'The customer messaged this business within the last 24 hours' }],
  help: 'Confirm that the 24-hour customer service window is open. This app does not receive incoming WhatsApp webhooks; Meta enforces the window. Otherwise use an approved template.',
};

function recipient(values: ActionValues): string {
  const value = required(values, 'recipient', 'Recipient phone number');
  if (!/^\+?[1-9]\d{6,14}$/.test(value)) {
    throw new ProviderError('Recipient phone number must contain 7–15 digits including country code, with an optional leading +.');
  }
  return value.replace(/^\+/, '');
}

function checkGraph(body: Record<string, unknown>): Record<string, unknown> {
  if (body.error) throw new ProviderError('WhatsApp Business denied the action. Check permissions, recipient eligibility, and template approval before retrying.', 403);
  return body;
}

async function read(credential: Credential, id: string, edge: string, params: Record<string, string>) {
  return checkGraph(await apiJson('WhatsApp Business', whatsappUrl(id, edge, params), { headers: bearer(credential) }));
}

async function send(credential: Credential, values: ActionValues, payload: Record<string, unknown>) {
  const phoneNumberId = whatsappPhoneId(credential);
  const body = checkGraph(await apiJson('WhatsApp Business', whatsappUrl(phoneNumberId, 'messages'), {
    method: 'POST', headers: { ...bearer(credential), 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient(values), ...payload }),
  }));
  const messageId = records(body.messages)[0]?.id;
  if (typeof messageId !== 'string' || !messageId.trim()) {
    throw new ProviderError('WhatsApp Business did not return a message ID. Check the recipient conversation before retrying.', 502);
  }
  return { summary: 'WhatsApp Business accepted the message. Delivery is not confirmed by this response.', items: [{ messageId, phoneNumberId }] };
}

function textPayload(values: ActionValues, reply: boolean): Record<string, unknown> {
  if (values.serviceWindow !== 'open') throw new ProviderError('Confirm the customer messaged this business within the last 24 hours, or use an approved template.');
  const content = required(values, 'content', 'Message');
  if (content.length > 4096) throw new ProviderError('WhatsApp text messages can contain at most 4,096 characters.');
  const payload: Record<string, unknown> = { type: 'text', text: { preview_url: false, body: content } };
  if (reply) {
    const messageId = required(values, 'replyTo', 'Message ID to reply to');
    if (!/^wamid\.[A-Za-z0-9+/=_-]{1,500}$/.test(messageId)) throw new ProviderError('Message ID to reply to must be a WhatsApp wamid message ID.');
    payload.context = { message_id: messageId };
  }
  return payload;
}

/** A deliberately small template subset: positional text parameters in body/header only. */
function templateComponents(value: string | undefined): Record<string, unknown>[] | undefined {
  if (!value?.trim()) return undefined;
  if (value.length > 25_000) throw new ProviderError('Template components are too large.');
  let components: unknown;
  try { components = JSON.parse(value); } catch { throw new ProviderError('Template components must be a JSON array.'); }
  if (!Array.isArray(components) || components.length > 2) {
    throw new ProviderError('Use at most one body and one header component with text parameters.');
  }
  const seen = new Set<string>();
  return components.map((component) => {
    if (!isObject(component) || Object.keys(component).some((key) => !['type', 'parameters'].includes(key))
      || !['body', 'header'].includes(String(component.type)) || seen.has(String(component.type))) {
      throw new ProviderError('Only one body and one header component are supported; buttons and media parameters are not supported.');
    }
    seen.add(String(component.type));
    if (!Array.isArray(component.parameters) || !component.parameters.length
      || component.parameters.length > (component.type === 'header' ? 1 : 20)) {
      throw new ProviderError('Provide 1–20 body text parameters or exactly one header text parameter.');
    }
    return {
      type: component.type,
      parameters: component.parameters.map((parameter: unknown) => {
        if (!isObject(parameter) || Object.keys(parameter).some((key) => !['type', 'text'].includes(key))
          || parameter.type !== 'text' || typeof parameter.text !== 'string' || !parameter.text.trim()
          || parameter.text.length > 1024) {
          throw new ProviderError('Each template parameter must contain only type "text" and nonempty text of at most 1,024 characters.');
        }
        return { type: 'text', text: parameter.text };
      }),
    };
  });
}

export const whatsappActions: ActionAdapter[] = [
  {
    provider: 'whatsapp',
    definition: { id: 'get-phone', label: 'Read business phone number', group: 'analytics', kind: 'read', description: 'Read the connected business phone number and verified business name.', fields: [] },
    execute: async (credential) => {
      const phoneNumberId = whatsappPhoneId(credential);
      const body = await read(credential, phoneNumberId, '', { fields: 'id,display_phone_number,verified_name' });
      if (body.id !== phoneNumberId) throw new ProviderError('WhatsApp Business returned an invalid phone number profile.', 502);
      return { summary: 'Connected WhatsApp Business phone number.', items: [{ phoneNumberId, displayPhoneNumber: string(body.display_phone_number), verifiedName: string(body.verified_name) }] };
    },
  },
  {
    provider: 'whatsapp',
    definition: { id: 'get-business-profile', label: 'Read business profile', group: 'analytics', kind: 'read', description: 'Read the public business profile for this WhatsApp phone number.', fields: [] },
    execute: async (credential) => {
      const body = await read(credential, whatsappPhoneId(credential), 'whatsapp_business_profile', { fields: 'about,address,description,email,profile_picture_url,websites,vertical' });
      if (!Array.isArray(body.data)) throw new ProviderError('WhatsApp Business returned an invalid business profile.', 502);
      return { summary: 'WhatsApp Business profile.', items: records(body.data).slice(0, 1).map((profile) => ({ about: string(profile.about), address: string(profile.address), description: string(profile.description), email: string(profile.email), vertical: string(profile.vertical), websites: Array.isArray(profile.websites) ? profile.websites.filter((value) => typeof value === 'string').slice(0, 2).join(', ') : '' })) };
    },
  },
  {
    provider: 'whatsapp',
    definition: { id: 'list-templates', label: 'List message templates', group: 'inbox', kind: 'read', description: 'Read up to 100 templates from a WhatsApp Business Account accessible to this token. Only approved templates can be sent.', fields: [{ name: 'businessAccountId', label: 'WhatsApp Business Account ID', type: 'text', required: true, help: 'Copy the WABA ID from Meta WhatsApp → API Setup. This differs from the phone number ID.' }] },
    execute: async (credential, values) => {
      const body = await read(credential, whatsappId(values.businessAccountId, 'WhatsApp Business Account ID'), 'message_templates', { fields: 'id,name,status,category,language,components', limit: '100' });
      if (!Array.isArray(body.data)) throw new ProviderError('WhatsApp Business returned an invalid template list.', 502);
      return { summary: 'WhatsApp Business templates (up to 100). Check approval status before sending.', items: records(body.data).map((item) => ({ id: string(item.id), name: string(item.name), status: string(item.status), category: string(item.category), language: string(item.language), components: JSON.stringify(records(item.components)).slice(0, 16_000) })) };
    },
  },
  {
    provider: 'whatsapp',
    definition: { id: 'send-message', label: 'Send service-window message', group: 'inbox', kind: 'write', description: 'Send text during an open 24-hour customer service window. This app cannot determine window status; Meta enforces it. Immediate delivery request only.', fields: [recipientField, contentField, serviceWindowField] },
    execute: async (credential, values) => send(credential, values, textPayload(values, false)),
  },
  {
    provider: 'whatsapp',
    definition: { id: 'reply-message', label: 'Reply to a WhatsApp message', group: 'inbox', kind: 'write', description: 'Reply by known WhatsApp message ID during an open 24-hour customer service window. Incoming message IDs must come from your separately configured webhook integration.', fields: [recipientField, { name: 'replyTo', label: 'Message ID to reply to', type: 'text', required: true }, contentField, serviceWindowField] },
    execute: async (credential, values) => send(credential, values, textPayload(values, true)),
  },
  {
    provider: 'whatsapp',
    definition: { id: 'send-template', label: 'Send approved template', group: 'publishing', kind: 'write', schedulable: true, description: 'Send an approved template to an opted-in recipient, including outside the 24-hour window. Supports plain templates and positional text parameters in body/header only. Meta messaging charges may apply.', fields: [recipientField, { name: 'templateName', label: 'Approved template name', type: 'text', required: true }, { name: 'language', label: 'Template language code', type: 'text', required: true, placeholder: 'en_US' }, { name: 'components', label: 'Text template components (optional JSON)', type: 'textarea', help: 'Leave blank for a template without variables. Example: [{"type":"body","parameters":[{"type":"text","text":"Alex"}]}]. Buttons, media, and named parameters are not supported.' }] },
    execute: async (credential, values) => {
      const name = required(values, 'templateName', 'Template name');
      const language = required(values, 'language', 'Template language code');
      if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new ProviderError('Template name must use lowercase letters, numbers, and underscores.');
      if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) throw new ProviderError('Use the approved template language code, such as en_US or zh_TW.');
      const components = templateComponents(values.components);
      return send(credential, values, { type: 'template', template: { name, language: { code: language }, ...(components?.length ? { components } : {}) } });
    },
  },
];
