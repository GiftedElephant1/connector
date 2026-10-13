import 'dotenv/config';
import { loadConfig } from './config';
import { Store } from './store';
import { createApp } from './app';
import { Pipeline } from './pipeline';

try {
  const config = loadConfig();
  const store = new Store(config.databasePath, config.encryptionKey);
  const pipeline = new Pipeline(store);
  let stopScheduler = async () => {};
  const server = createApp(config, store, undefined, process.env, pipeline).listen(config.port, config.host, () => {
    stopScheduler = pipeline.startScheduler();
    console.log(`Connector is listening on port ${config.port}.`);
  });
  server.on('error', () => { console.error('Could not start Connector. Check HOST, PORT, and file permissions.'); store.close(); process.exitCode = 1; });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const stopped = stopScheduler();
    server.close(() => { void stopped.then(() => { store.close(); process.exit(0); }); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Connector could not start.');
  process.exitCode = 1;
}
