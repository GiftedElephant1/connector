export type Credential = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  fields?: Record<string, string>;
};

export type Resource = { id: string; name: string; type: string };
export type VerifiedAccount = { accountName: string; accountId?: string; resources: Resource[] };
export type ProviderDefinition = {
  id: string;
  name: string;
  category: 'ai' | 'social' | 'communications' | 'advertising' | 'analytics' | 'websites' | 'finance';
  description: string;
  authType: 'api_key' | 'oauth' | 'link' | 'local';
  docsUrl: string;
  credentialFields?: { name: string; label: string; secret?: boolean }[];
};

/** Every message is intentionally public and must not contain upstream response bodies or credentials. */
export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export type OAuthRequest = { redirectUri: string; state: string; codeVerifier: string; env: NodeJS.ProcessEnv };
export type OAuthExchange = { code: string; redirectUri: string; codeVerifier: string; env: NodeJS.ProcessEnv };
export interface ProviderAdapter {
  definition: ProviderDefinition;
  requiredEnv: string[];
  authorize?: (input: OAuthRequest) => string;
  exchange?: (input: OAuthExchange) => Promise<Credential>;
  refresh?: (credential: Credential, env: NodeJS.ProcessEnv) => Promise<Credential>;
  verify: (credential: Credential, env: NodeJS.ProcessEnv) => Promise<VerifiedAccount>;
}
