/** Broader Google grants accepted by the same user-delegated API capabilities.
 * These checks never select an app or change an agent's account/app bindings.
 */
const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const implications: Record<string, readonly string[]> = {
  [scope('drive')]: ['drive.file', 'drive.readonly', 'drive.metadata', 'drive.metadata.readonly'].map(scope),
  [scope('drive.readonly')]: [scope('drive.metadata.readonly')],
  [scope('drive.metadata')]: [scope('drive.metadata.readonly')],
  'https://mail.google.com/': ['gmail.modify', 'gmail.readonly', 'gmail.compose', 'gmail.send', 'gmail.insert', 'gmail.labels', 'gmail.metadata'].map(scope),
  [scope('gmail.modify')]: ['gmail.readonly', 'gmail.compose', 'gmail.send', 'gmail.insert', 'gmail.labels', 'gmail.metadata'].map(scope),
  [scope('gmail.compose')]: [scope('gmail.send')],
  [scope('gmail.readonly')]: [scope('gmail.metadata')],
  [scope('chat.spaces')]: ['chat.spaces.readonly', 'chat.spaces.create', 'chat.spaces.pins', 'chat.spaces.pins.readonly'].map(scope),
  [scope('chat.spaces.pins')]: [scope('chat.spaces.pins.readonly')],
  [scope('chat.messages')]: ['chat.messages.readonly', 'chat.messages.create', 'chat.messages.reactions', 'chat.messages.reactions.create', 'chat.messages.reactions.readonly'].map(scope),
  [scope('chat.messages.reactions')]: ['chat.messages.reactions.create', 'chat.messages.reactions.readonly'].map(scope),
  [scope('chat.memberships')]: [scope('chat.memberships.readonly')],
  ...Object.fromEntries(['chat.users.readstate', 'chat.users.sections', 'chat.users.availability', 'chat.customemojis'].map(name => [scope(name), [scope(`${name}.readonly`)]])),
};

export function hasGoogleScope(granted: readonly string[], required: string): boolean {
  return granted.includes(required) || granted.some(value => implications[value]?.includes(required));
}

export function hasGoogleScopes(granted: readonly string[], required: readonly string[]): boolean {
  return required.every(value => hasGoogleScope(granted, value));
}

/** Expanded ordinary-user consent; baseline grants continue to enable existing actions. */
export const expandedWorkspaceScopes: Record<string, string[]> = {
  drive: ['drive.readonly', 'drive', 'drive.appdata', 'drive.apps.readonly'].map(scope),
  gmail: ['https://mail.google.com/', scope('gmail.settings.basic')],
  meet: [scope('meetings.space.settings')],
  chat: ['chat.spaces', 'chat.messages', 'chat.memberships', 'chat.delete', 'chat.users.readstate', 'chat.users.spacesettings', 'chat.spaces.pins', 'chat.customemojis', 'chat.users.sections', 'chat.users.availability'].map(scope),
};
