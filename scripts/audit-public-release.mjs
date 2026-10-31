import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile), root = resolve(fileURLToPath(new URL('..', import.meta.url)));
let stdout;
try { stdout = (await run('pnpm', ['audit', '--prod', '--json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout; }
catch (error) {
  const result = /** @type {Error & {stdout?:string}} */ (error);
  if (!result.stdout) throw error;
  stdout = result.stdout;
}
const audit = JSON.parse(stdout);
if (!audit.metadata?.vulnerabilities || audit.error || !audit.advisories) throw Error('Dependency audit did not return a complete report.');
const advisories = /** @type {Record<string,any>[]} */ (Object.values(audit.advisories));
const patchedIds = new Set([1239765, 1239766]);
const patched = advisories.filter(row => patchedIds.has(row.id) && row.module_name === 'image-size');
if (patched.length) {
  // 只允许这两条已回归的容器死循环告警；保留扫描原始计数，其他高危不因同包名被放行。
  const workspace = await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
  if (!workspace.includes('image-size@1.2.1:') || !workspace.includes('patches/image-size@1.2.1.patch')) throw Error('Required image parser patch is not configured.');
  await run(process.execPath, ['--test', 'test/image-container-security.test.mjs'], { cwd: root });
}
const blocked = advisories.filter(row => ['high', 'critical'].includes(row.severity) && !patched.includes(row));
const report = {
  generatedAt: new Date().toISOString(), rawCounts: audit.metadata.vulnerabilities,
  patchedContainerAdvisories: patched.map(row => ({ id: row.id, url: row.url, regression: 'passed' })),
  blocked: blocked.map(row => ({ id: row.id, module: row.module_name, severity: row.severity, url: row.url })),
  remaining: advisories.filter(row => !patched.includes(row)).map(row => ({ id: row.id, module: row.module_name, severity: row.severity, url: row.url })),
};
await mkdir(resolve(root, 'evidence/private'), { recursive: true, mode: 0o700 });
await writeFile(resolve(root, 'evidence/private/public-release-dependency-gate.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report));
if (blocked.length) throw Error('Unreviewed high/critical dependency advisories block publication.');
