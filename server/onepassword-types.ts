/** Public metadata only. 1Password field values never belong in these responses. */
export interface OnePasswordAccount { id: string; name: string }
export interface OnePasswordVault { id: string; name: string }
export interface OnePasswordItem { id: string; title: string; category: string }
export interface OnePasswordField { id: string; label: string; type: string; purpose?: string }
export interface OnePasswordSelection { accountId: string; vaultId: string; itemId: string }
export interface OnePasswordTargetField {
  key: string; label: string; secret: boolean; required: boolean; source: 'vault' | 'literal';
}
export interface OnePasswordTarget {
  id: string; label: string; description: string; fields: OnePasswordTargetField[]; agentUsable: boolean;
}
export interface OnePasswordLinkInput extends OnePasswordSelection {
  name: string; targetId: string; fields: Record<string, string>; literals: Record<string, string>; principals: string[];
}
export interface OnePasswordLinkView extends OnePasswordLinkInput {
  id: string; targetLabel: string; lastUsedAt?: string;
}
export interface OnePasswordSnapshot {
  enabled: boolean; executable: string; windows: boolean; links: OnePasswordLinkView[];
  targets: OnePasswordTarget[]; principals: { id: string; label: string }[];
}
export interface OnePasswordCheck { installed: boolean; version?: string; message: string }
export interface OnePasswordUseResult { id: string; name: string; target: string; status: 'applied'; message: string }
