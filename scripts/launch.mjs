import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { startBridge } from '../src/server.mjs';
import { PhoneAuth } from '../src/auth.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { writePrivateJson } from '../src/private-json.mjs';

const directory = process.env.BRIDGE_DATA_DIR ?? join(homedir(), '.agent-session-bridge');
if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Select an existing Node.js 24 or newer, then run npm run start:legacy.');
const runtimePath = join(directory, 'runtime.json');
await mkdir(directory, { recursive: true, mode: 0o700 });
/** @type {{pid:number,port:number,instanceId:string,adminToken:string,addresses:string[],lan:boolean}|null} */
let existing = null;
try {
  const saved = JSON.parse(await readFile(runtimePath, 'utf8'));
  const health = await fetch(`http://127.0.0.1:${saved.port}/healthz`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json());
  if (health.service === 'agent-session-bridge' && health.instanceId === saved.instanceId) existing = saved;
} catch { /* Only a verified live bridge is reused; target agents are never stopped. */ }

/** @param {{port:number,addresses:string[],lan:boolean}} runtime @param {string} code */
function show(runtime, code) {
  process.stdout.write(`随行 · 桌面会话\n本机：http://localhost:${runtime.port}\n一次性配对码：${code}\n`);
  if (runtime.lan) for (const address of runtime.addresses.filter((item) => item !== 'localhost' && item !== '127.0.0.1')) process.stdout.write(`手机：http://${address}:${runtime.port}\n`);
}

if (existing) {
  const origin = `http://127.0.0.1:${existing.port}`;
  const response = await fetch(`${origin}/admin/pair-code`, { method: 'POST', headers: { Origin: origin, 'X-Bridge-Admin': existing.adminToken } });
  if (!response.ok) throw Error('Existing bridge could not issue a new pairing code.');
  const result = await response.json();
  show(existing, result.code);
  process.stdout.write('独立服务已在运行，未重启任何桌面应用。\n');
} else {
  const portArgument = process.argv.find((item) => item.startsWith('--port='));
  const port = Number(portArgument?.slice(7) ?? 9089);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Invalid --port.');
  const lan = process.argv.includes('--lan');
  const auth = await PhoneAuth.load(join(directory, 'paired-clients.json'));
  const receipts = await CommandReceipts.load(join(directory, 'command-receipts.json'));
  const bridge = await startBridge({ port, lan, relayOrigin: process.env.BRIDGE_PUBLIC_ORIGIN, auth, receipts });
  const runtime = { pid: process.pid, port: bridge.port, instanceId: bridge.instanceId, adminToken: bridge.adminToken, addresses: bridge.addresses, lan };
  await writePrivateJson(runtimePath, runtime);
  show(runtime, bridge.auth.pairCode);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    void bridge.close().then(async () => {
      try { const current = JSON.parse(await readFile(runtimePath, 'utf8')); if (current.instanceId === bridge.instanceId) await unlink(runtimePath); } catch { /* A newer bridge owns its receipt. */ }
      process.exit(0);
    });
  });
}
