export const outboundProviders = ['claude', 'chatgpt', 'gemini', 'cursor', 'grok'] as const;
export type OutboundProvider = typeof outboundProviders[number];
export const outboundNames: Record<OutboundProvider, string> = {
  claude: 'Claude via Claude Code', chatgpt: 'ChatGPT via Codex', gemini: 'Gemini via Antigravity', cursor: 'Cursor Cloud Agent', grok: 'Grok Bot routine',
};
export type AiTaskStatus = 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled' | 'submitted';
export interface AiTask {
  id: string;
  provider: OutboundProvider;
  status: AiTaskStatus;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  link?: string;
}
export interface StoredAiTask extends AiTask {
  principal: string;
  fingerprint: string;
  remoteId?: string;
  configGeneration: string;
}
export interface OutboundProviderConfig {
  enabled: boolean;
  generation: string;
  executable?: string;
  apiKey?: string;
  model?: string;
  webhookUrl?: string;
  webhookKey?: string;
  check?: {status: 'ready' | 'action_required' | 'unavailable'; message: string; checkedAt: string};
}
export interface OutboundSettings {
  allowSharedKey: boolean;
  providers: Partial<Record<OutboundProvider, OutboundProviderConfig>>;
}
export interface OutboundProviderView {
  id: OutboundProvider;
  name: string;
  enabled: boolean;
  configured: boolean;
  executable?: string;
  model?: string;
  hasApiKey?: boolean;
  hasWebhookUrl?: boolean;
  hasWebhookKey?: boolean;
  check?: OutboundProviderConfig['check'];
}
