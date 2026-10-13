import type { Credential } from './provider-types';

export type ActionValues = Record<string, string>;
export interface ActionField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'datetime' | 'select' | 'url' | 'file';
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  default?: string;
}
export interface ActionDefinition {
  id: string;
  label: string;
  group: 'publishing' | 'inbox' | 'analytics' | 'advertising';
  kind: 'read' | 'write';
  description: string;
  fields: ActionField[];
  /** Only publication operations can be placed in the persistent schedule. */
  schedulable?: boolean;
}
export interface ActionResult {
  summary: string;
  items?: Record<string, string | number | boolean | null>[];
  link?: string;
}
export interface ActionAdapter {
  provider: string;
  definition: ActionDefinition;
  execute: (credential: Credential, values: ActionValues, env: NodeJS.ProcessEnv) => Promise<ActionResult>;
}
