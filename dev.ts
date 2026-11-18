// dev.ts — local test launcher: starts the forge on a port without the env
// lifecycle (the trial's main.ts needs MAKEFUN_ENV_URL; this file is only for
// local testing). Usage: MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev.ts [port]

import { createApp } from './app.ts';

const port = Number(process.argv[2] ?? '18080');
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[dev] forge listening on http://127.0.0.1:${port}\n`);
  process.stdout.write(`[dev] token: ${process.env.MAKEFUN_SHOP_TOKEN ? '(set)' : '(none — any token accepted)'}\n`);
});
