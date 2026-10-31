import { createNetworkRelay } from './relay-server.mjs';

const server = createNetworkRelay({ token: process.env.REGISTRATION_TOKEN ?? '' });
const port = Number(process.env.PORT ?? 8081);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('invalid-listen-port');
server.listen(port, process.env.HOST ?? '0.0.0.0', () => process.stdout.write(JSON.stringify({ service: 'codelight-network-relay', version: 1, listening: true }) + '\n'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
