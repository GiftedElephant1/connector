import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const installation = Object.freeze({
  version: manifest.version,
  downloadUrl: 'https://github.com/GiftedElephant1/connector/releases',
  updateGuideUrl: 'https://github.com/GiftedElephant1/connector/blob/main/docs/windows.md#update-without-reconnecting-your-accounts',
  preservesConnections: true,
});
