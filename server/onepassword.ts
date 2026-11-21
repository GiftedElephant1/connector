import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { Store } from './store';
import { ProviderError } from './provider-types';
import { OnePasswordCli } from './onepassword-cli';
import type { OnePasswordLinkInput, OnePasswordLinkView, OnePasswordSnapshot, OnePasswordTarget, OnePasswordUseResult } from './onepassword-types';

const SETTING = 'onepassword-v1';
const text = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const identifier = z.string().regex(/^[a-z0-9]{26}$/i);
const selection = z.object({ accountId: identifier, vaultId: identifier, itemId: identifier }).strict();
const linkSchema = selection.extend({
  name: text, targetId: z.string().min(1).max(200),
  fields: z.record(z.string().min(1).max(100), z.string().min(1).max(4096)),
  literals: z.record(z.string().min(1).max(100), z.string().trim().min(1).max(2048).regex(/^[^\u0000-\u001f\u007f]+$/)),
  principals: z.array(z.string().max(200)).max(200),
}).strict();
interface SavedLink extends OnePasswordLinkInput { id: string; revision: string; lastUsedAt?: string }
interface Saved { enabled: boolean; executable: string; revision: string; links: SavedLink[] }
export interface OnePasswordTargets {
  catalog(): OnePasswordTarget[];
  prepare(id: string): { assertUnchanged(): void; apply(values: Record<string, string>, assertCurrent: () => void): Promise<void> };
}
export type OnePasswordCliAccess = Pick<OnePasswordCli, 'check' | 'accounts' | 'vaults' | 'items' | 'fields' | 'readFields'>;

/** All machine access is an explicit per-link grant to a fixed destination, never a vault-reading proxy. */
export class OnePasswordService {
  private readonly cli: OnePasswordCliAccess;
  private readonly inFlight = new Set<string>();
  constructor(private readonly store: Store, private readonly targets: OnePasswordTargets,
    private readonly principals: () => { id: string; label: string }[], cli?: OnePasswordCliAccess) {
    this.cli = cli || new OnePasswordCli();
  }
  private saved(): Saved { return this.store.readSetting<Saved>(SETTING) || { enabled: false, executable: '', revision: '', links: [] }; }
  private enabled(): Saved {
    const state = this.saved();
    if (!state.enabled) throw new ProviderError('Enable 1Password in Connector Settings before using a saved credential link.', 409);
    return state;
  }
  private target(id: string) {
    const target = this.targets.catalog().find(item => item.id === id);
    if (!target) throw new ProviderError('This credential destination is unavailable. Review its link in Settings → 1Password.', 409);
    return target;
  }
  snapshot(): OnePasswordSnapshot {
    const state = this.saved();
    const targets = this.targets.catalog();
    return { enabled: state.enabled, executable: state.executable, windows: process.platform === 'win32',
      links: state.links.map(({ revision: _revision, ...link }): OnePasswordLinkView => ({ ...link, targetLabel: targets.find(target => target.id === link.targetId)?.label || 'Destination unavailable' })),
      targets, principals: this.principals() };
  }
  configure(input: unknown) {
    const body = z.object({ enabled: z.boolean(), executable: z.string().trim().max(2048).optional() }).strict().safeParse(input);
    if (!body.success) throw new ProviderError('Choose whether to enable 1Password and an optional CLI executable path.');
    const executable = body.data.executable || '';
    if (executable && (!isAbsolute(executable) || /[\u0000-\u001f\u007f]/.test(executable) || /\.(?:bat|cmd|ps1|sh|js|vbs)$/i.test(executable))) throw new ProviderError('Use the full path to the official 1Password CLI executable, or leave it blank for automatic discovery.');
    this.store.writeSetting(SETTING, { ...this.saved(), ...body.data, executable, revision: randomUUID() });
    return this.snapshot();
  }
  async check() { return this.cli.check(this.saved().executable); }
  async accounts(assertCurrent: () => void) {
    const { executable, revision } = this.enabled();
    const accounts = await this.cli.accounts(executable);
    this.assertState(revision, assertCurrent);
    return { accounts };
  }
  async vaults(input: unknown, assertCurrent: () => void) {
    const body = z.object({ accountId: identifier }).strict().safeParse(input);
    if (!body.success) throw new ProviderError('Select a 1Password account.');
    const { executable, revision } = this.enabled();
    const vaults = await this.cli.vaults(executable, body.data.accountId);
    this.assertState(revision, assertCurrent);
    return { vaults };
  }
  async items(input: unknown, assertCurrent: () => void) {
    const body = selection.omit({ itemId: true }).safeParse(input);
    if (!body.success) throw new ProviderError('Select a 1Password account and vault.');
    const { executable, revision } = this.enabled();
    const items = await this.cli.items(executable, body.data.accountId, body.data.vaultId);
    this.assertState(revision, assertCurrent);
    return { items };
  }
  async fields(input: unknown, assertCurrent: () => void) {
    const body = selection.safeParse(input);
    if (!body.success) throw new ProviderError('Select an item from a 1Password vault.');
    const { executable, revision } = this.enabled();
    const fields = await this.cli.fields(executable, body.data);
    this.assertState(revision, assertCurrent);
    return { fields };
  }
  private assertState(revision: string, assertCurrent: () => void) {
    assertCurrent();
    if (this.enabled().revision !== revision) throw new ProviderError('1Password settings changed while this request was waiting. Try again.', 409);
  }
  private validateTarget(input: OnePasswordLinkInput) {
    const target = this.target(input.targetId);
    if (Object.keys(input.fields).length + Object.keys(input.literals).length > 30) throw new ProviderError('Select at most 30 credential fields.');
    if (!Object.keys(input.fields).length) throw new ProviderError('Select at least one field from 1Password.');
    for (const key of Object.keys(input.fields)) if (!target.fields.some(field => field.key === key && field.source === 'vault')) throw new ProviderError('Select only the documented 1Password fields for this destination.');
    for (const key of Object.keys(input.literals)) if (!target.fields.some(field => field.key === key && field.source === 'literal' && !field.secret)) throw new ProviderError('Enter only the fixed non-secret destination fields.');
    for (const field of target.fields) if (field.required && !(field.source === 'vault' ? input.fields[field.key] : input.literals[field.key])) throw new ProviderError(`Select ${field.label} before saving this link.`);
    if (input.principals.length && !target.agentUsable) throw new ProviderError('This destination can be updated only by the workspace owner.');
    const allowed = new Set(this.principals().map(item => item.id));
    if (input.principals.some(principal => !allowed.has(principal))) throw new ProviderError('Select an existing AI connection or the current shared Connector key.');
    return target;
  }
  async saveLink(input: unknown, assertCurrent: () => void, id?: string) {
    const parsed = linkSchema.safeParse(input);
    if (!parsed.success) throw new ProviderError('Choose a name, destination, 1Password item, and its fields.');
    const body = parsed.data;
    this.validateTarget(body);
    const state = this.enabled();
    const previous = id ? state.links.find(item => item.id === id) : undefined;
    if (id && !previous) throw new ProviderError('This saved credential link no longer exists.', 404);
    if (!id && state.links.length >= 100) throw new ProviderError('Remove an unused 1Password link before adding another.', 409);
    const fields = await this.cli.fields(state.executable, body);
    this.assertState(state.revision, assertCurrent);
    this.validateTarget(body);
    if (Object.values(body.fields).some(fieldId => !fields.some(field => field.id === fieldId))) throw new ProviderError('The selected fields are no longer in this 1Password item. Reload its fields.');
    const target = this.target(body.targetId);
    for (const [key, fieldId] of Object.entries(body.fields)) {
      const source = fields.find(field => field.id === fieldId)!;
      if (!target.fields.find(field => field.key === key)!.secret && (source.type === 'CONCEALED' || source.purpose === 'PASSWORD')) throw new ProviderError('A concealed or password field cannot be copied into a visible account setting. Choose a non-secret field for that setting.');
    }
    const current = this.saved();
    if (id && current.links.find(link => link.id === id)?.revision !== previous?.revision) throw new ProviderError('This link changed while the request was waiting. Reload it.', 409);
    if (!id && current.links.length >= 100) throw new ProviderError('Remove an unused 1Password link before adding another.', 409);
    const link: SavedLink = { ...body, principals: [...new Set(body.principals)], id: id || randomUUID(), revision: randomUUID() };
    this.store.writeSetting(SETTING, { ...current, links: id ? current.links.map(item => item.id === id ? link : item) : [...current.links, link] });
    return this.snapshot();
  }
  remove(id: string) {
    const state = this.saved();
    if (!state.links.some(item => item.id === id)) throw new ProviderError('This saved credential link no longer exists.', 404);
    this.store.writeSetting(SETTING, { ...state, links: state.links.filter(item => item.id !== id) });
    return this.snapshot();
  }
  private allowed(link: SavedLink, principal: string) {
    if (principal === 'owner') return true;
    return link.principals.includes(principal) && this.principals().some(item => item.id === principal) && !!this.targets.catalog().find(item => item.id === link.targetId)?.agentUsable;
  }
  visibleLinks(principal: string) {
    const state = this.saved();
    if (!state.enabled) return { links: [] };
    const targets = this.targets.catalog();
    return { links: state.links.filter(link => this.allowed(link, principal) && targets.some(target => target.id === link.targetId))
      .map(link => ({ id: link.id, name: link.name, target: targets.find(target => target.id === link.targetId)!.label })) };
  }
  hasAccess(principal: string) { return this.visibleLinks(principal).links.length > 0; }
  async use(id: string, principal: string, assertCurrent: () => void = () => {}): Promise<OnePasswordUseResult> {
    assertCurrent();
    const state = this.enabled();
    const link = state.links.find(item => item.id === id);
    if (!link || !this.allowed(link, principal)) throw new ProviderError('This 1Password link is not available to this connection.', 403);
    const target = this.target(link.targetId);
    if (this.inFlight.has(target.id)) throw new ProviderError('This credential destination is already being updated. Wait for that request to finish.', 409);
    const prepared = this.targets.prepare(target.id);
    const guard = () => {
      this.assertState(state.revision, assertCurrent);
      const current = this.saved().links.find(item => item.id === id);
      if (!current || current.revision !== link.revision || !this.allowed(current, principal)) throw new ProviderError('Access to this 1Password link changed while it was waiting. Review the link before retrying.', 403);
      prepared.assertUnchanged();
    };
    this.inFlight.add(target.id);
    try {
      const visibleFields = target.fields.filter(field => !field.secret && field.source === 'vault').flatMap(field => link.fields[field.key] ? [link.fields[field.key]] : []);
      const values = await this.cli.readFields(state.executable, link, [...new Set(Object.values(link.fields))], visibleFields);
      guard();
      const mapped: Record<string, string> = { ...link.literals };
      for (const [key, fieldId] of Object.entries(link.fields)) {
        const value = values[fieldId];
        if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)) throw new ProviderError('A selected 1Password field is empty or cannot be used as this credential. Review the item in 1Password.');
        mapped[key] = value.trim();
      }
      await prepared.apply(mapped, guard);
      // apply() checks the guard immediately before committing. Do not compare
      // its old destination stamp after our own successful write.
      assertCurrent();
      const current = this.saved();
      const currentLink = current.links.find(item => item.id === id);
      if (currentLink?.revision === link.revision) {
        currentLink.lastUsedAt = new Date().toISOString();
        this.store.writeSetting(SETTING, current);
      }
      return { id, name: link.name, target: target.label, status: 'applied', message: 'The approved credentials were retrieved from 1Password and saved in Connector’s encrypted storage. No secret values were returned. Existing account permissions still apply.' };
    } finally { this.inFlight.delete(target.id); }
  }
}
