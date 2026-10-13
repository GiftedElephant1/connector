import { isObject } from './provider-http';
import { ProviderError, type ProviderAdapter } from './provider-types';
import { normalizeWordPressSite, wordpressJson } from './wordpress-http';

export function createWordpressAdapters(request: typeof wordpressJson = wordpressJson): ProviderAdapter[] {
  return [{
    definition: {
      id: 'wordpress-self-hosted', name: 'WordPress (your hosting provider)', category: 'websites', authType: 'api_key',
      description: 'Connect your own WordPress website with an Application Password. Let your AI agent read, draft, publish, and edit blog posts and pages using the official WordPress REST API.',
      docsUrl: 'https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/',
      credentialFields: [{ name: 'siteUrl', label: 'WordPress website HTTPS URL', secret: false }, { name: 'username', label: 'WordPress username', secret: false }],
    },
    requiredEnv: [],
    verify: async (credential) => {
      const site = normalizeWordPressSite(credential.fields?.siteUrl ?? '');
      const body = await request(credential, '/wp/v2/users/me?context=edit');
      if (!isObject(body) || !Number.isSafeInteger(body.id) || Number(body.id) <= 0 || typeof body.name !== 'string' || !body.name.trim() || !isObject(body.capabilities)) {
        throw new ProviderError('WordPress did not return a valid authenticated user profile.', 502);
      }
      if (body.capabilities.edit_posts !== true && body.capabilities.edit_pages !== true) {
        throw new ProviderError('This WordPress user cannot edit posts or pages. Connect a user with an Author, Editor, Administrator, or equivalent custom role.', 403);
      }
      const permissions: Record<string, string> = {
        edit_posts: 'Create and edit own posts', publish_posts: 'Publish posts', edit_others_posts: 'Edit other authors’ posts',
        edit_pages: 'Create and edit pages', publish_pages: 'Publish pages', edit_others_pages: 'Edit other authors’ pages',
      };
      const capabilities = body.capabilities;
      return {
        accountId: String(body.id),
        accountName: `${body.name.trim().slice(0, 200)} · ${new URL(site).host}`,
        resources: [
          { id: site, name: site, type: 'website' },
          ...Object.entries(permissions).filter(([id]) => capabilities[id] === true).map(([id, name]) => ({ id, name, type: 'permission' })),
        ],
      };
    },
  }];
}

export const wordpressAdapters = createWordpressAdapters();
