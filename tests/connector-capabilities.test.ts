import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listActions } from '../server/actions.ts';
import { providerCatalog } from '../server/providers.ts';
import { listWorkspaceActions, workspaceApps } from '../server/workspace-actions.ts';

// These exceptions describe the actual connected products, not entire vendors:
// Places cannot modify a personal Maps account; the Voice administrator
// Reports API exposes audit reads only.
// See docs/connector-capabilities.md. Any new read-only connector needs an
// explicit review of its official API limits instead of silently losing writes.
const readOnlyPlatforms = new Set<string>();
const readOnlyWorkspaceApps = new Set(['maps', 'voice']);

test('every destination platform with a writable API exposes at least one write action', () => {
  const destinations = providerCatalog.filter(provider => provider.category !== 'ai');
  const actualReadOnly = destinations.filter(provider => !listActions(provider.id).some(action => action.kind === 'write')).map(provider => provider.id);
  assert.deepEqual(actualReadOnly.sort(), [...readOnlyPlatforms].sort(),
    'A destination lost write support or a new read-only connector needs an explicit documented official-API exception.');
  for (const provider of destinations) {
    assert.ok(listActions(provider.id).length, `${provider.name} must expose usable actions rather than only an account check.`);
  }
});

test('every available Workspace app with a writable API exposes at least one write action', () => {
  const available = workspaceApps.filter(app => app.available);
  const actualReadOnly = available.filter(app => !listWorkspaceActions(app.id).some(action => action.kind === 'write')).map(app => app.id);
  assert.deepEqual(actualReadOnly.sort(), [...readOnlyWorkspaceApps].sort(),
    'A Workspace app lost write support or a new read-only app needs an explicit documented official-API exception.');
  for (const app of available) {
    assert.ok(listWorkspaceActions(app.id).length, `${app.name} must expose usable actions rather than only an account check.`);
  }
});
