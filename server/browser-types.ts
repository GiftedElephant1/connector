import type { OnePasswordSelection } from './onepassword-types';

export type BrowserChoice = 'auto' | 'edge' | 'chrome' | 'chromium';
export interface BrowserConfiguration { enabled: boolean; browser: BrowserChoice; principals: string[] }
export interface BrowserCheck { installed: boolean; name?: string; message: string }
export interface BrowserSnapshot extends BrowserConfiguration {
  onePasswordEnabled: boolean;
  availablePrincipals: { id: string; label: string }[];
  sessions: { id: string; principalLabel: string; origin: string; lastUsedAt: string }[];
}
export interface BrowserElement { ref: string; role: string; name: string }
export interface BrowserPageSnapshot {
  origin: string; title: string; text: string; elements: BrowserElement[];
}
/** Internal only: selected credential values never belong in an HTTP/tool result. */
export interface BrowserLogin extends OnePasswordSelection {
  title: string; accountName: string; vaultName: string; origins: string[];
}
export interface BrowserCredential { origins: string[]; username: string; password: string }
export interface BrowserVault {
  browserLogins(executable: string, origin: string, assertCurrent?: () => void): Promise<BrowserLogin[]>;
  browserCredential(executable: string, selection: OnePasswordSelection): Promise<BrowserCredential>;
}
export interface BrowserDriver {
  origin(): string;
  navigate(url: string, assertCurrent: () => void): Promise<void>;
  snapshot(assertCurrent: () => void): Promise<BrowserPageSnapshot>;
  click(ref: string, assertCurrent: () => void): Promise<void>;
  type(ref: string, text: string, assertCurrent: () => void): Promise<void>;
  fillLogin(origin: string, credential: BrowserCredential, assertCurrent: () => void): Promise<{ filled: 'username' | 'password' | 'username_and_password' }>;
  close(): Promise<void>;
}
export interface BrowserRuntime {
  check(choice: BrowserChoice): Promise<BrowserCheck>;
  launch(choice: BrowserChoice): Promise<BrowserDriver>;
}
