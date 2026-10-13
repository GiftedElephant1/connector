import 'dotenv/config';
import { loadConfig } from './config';
import { Store } from './store';
import { createApp } from './app';
import { Pipeline } from './pipeline';
import { PublicTunnel } from './tunnel';
import { updatePublicOrigin } from './settings';

try {
  const env = { ...process.env };
  const desktopToken = env.CONNECTOR_DESKTOP_TOKEN;
  delete env.CONNECTOR_DESKTOP_TOKEN;
  delete process.env.CONNECTOR_DESKTOP_TOKEN;
  const config = loadConfig(env);
  const store = new Store(config.databasePath, config.encryptionKey);
  const pipeline = new Pipeline(store, env);
  const tunnel = new PublicTunnel(config, store, origin => updatePublicOrigin(config, store, env, origin));
  let stopScheduler = async () => {};
  const server = createApp(config, store, undefined, env, pipeline, {
    desktopToken, ...(desktopToken ? { localOrigin: `http://127.0.0.1:${config.port}` } : {}), tunnel,
  }).listen(config.port, config.host, () => {
    stopScheduler = pipeline.startScheduler();
    console.log(`Connector is listening on port ${config.port}.`);
    void tunnel.restore().catch(() => console.error('Public access could not restart. Open Settings to reconnect.'));
  });
  server.on('error', () => { console.error('Could not start Connector. Check HOST, PORT, and file permissions.'); store.close(); process.exitCode = 1; });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const stopped = Promise.all([stopScheduler(), tunnel.stop(true).catch(() => {})]);
    server.close(() => { void stopped.then(() => { store.close(); process.exit(0); }); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The Windows launcher owns stdin; no network shutdown endpoint is exposed.
  if (desktopToken) {
    process.stdin.setEncoding('utf8');
    let command = '';
    process.stdin.on('data', (chunk: string) => {
      command += chunk;
      if (command.length > 64) { command = ''; return; }
      if (command.includes('\n')) {
        if (command.trim() === 'stop') shutdown();
        command = '';
      }
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Connector could not start.');
  process.exitCode = 1;
}
