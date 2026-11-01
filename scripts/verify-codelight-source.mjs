import { mkdtemp, rm, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Source verification requires Node 24 or newer; use the version in .nvmrc.');
const run = promisify(execFile), repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archive = resolve(process.argv.find((arg, index) => index > 1 && !arg.startsWith('--')) ?? join(repository, 'deliverables/CodeLight-Source.zip'));
const directory = await mkdtemp(join(tmpdir(), 'codelight-source-smoke-'));
/** @param {string} command @param {string[]} args @param {string} cwd */
async function execute(command, args, cwd) {
  const child = spawn(command, args, { cwd, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, stdio: 'inherit' });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code !== 0) throw Error(`${command} exited ${code}`);
}
try {
  await run('ditto', ['-x', '-k', archive, directory]);
  const root = join(directory, 'codelight');
  const product = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (product.name !== 'codelight' || product.packageManager !== 'pnpm@10.11.0') throw Error('The source workspace/toolchain contract did not match.');
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/mac/CodeLight.swift', 'apps/mobile/package.json', 'packages/relay/sources/standalone.ts',
    'packages/wire/package.json', 'src/happy/mac-app-service.mjs', 'native/codelight-simulator.entitlements', 'native/codelight-development.entitlements', 'assets/branding/generation.json', 'licenses/Happy-LICENSE']) await readFile(join(root, path));
  let files = 0;
  /** @param {string} folder @param {string} [prefix] */
  async function inspect(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (/(^|\/)(node_modules|Pods|\.runtime|deliverables|xcuserdata|\.module-cache)(\/|$)/u.test(name)
        || /evidence\/private/u.test(name) || /(^|\/)(account|devices|relay-key|mac-box-key|network-access|network-identity|connection-channels)\.json$/u.test(name)
        || /\.(p8|p12|pem|mobileprovision|ipa|sqlite|db|log|tsbuildinfo)$/u.test(name) || /(^|\/)\.env(\.|$)/u.test(name) && !name.endsWith('.env.example')) throw Error(`Private/generated path in source export: ${name}`);
      if (entry.isSymbolicLink()) throw Error(`Source export must not depend on external symlinks: ${name}`);
      if (entry.isDirectory()) await inspect(join(folder, entry.name), name + '/'); else files++;
    }
  }
  await inspect(root);
  if (!(await readFile(join(root, 'scripts/codelight-daemon.mjs'), 'utf8')).includes('CodeLight Mac:')) throw Error('Current daemon help contract is missing.');
  const plan = await run(process.execPath, ['scripts/build-mobile.mjs', '--simulator', 'fixture-simulator', '--dry-run'], { cwd: root });
  if (!JSON.parse(plan.stdout).entitlements.startsWith(await realpath(root))) throw Error('Native paths escaped the extracted project.');
  if (process.argv.includes('--install')) {
    await execute('pnpm', ['install', '--frozen-lockfile'], root);
    const help = await run(process.execPath, ['scripts/codelight-daemon.mjs', '--help'], { cwd: root });
    if (!help.stdout.includes('CodeLight Mac')) throw Error('Fresh-source daemon help failed.');
    const preset = await run(process.execPath, ['-e', "process.stdout.write(require.resolve('babel-preset-expo'))"], { cwd: join(root, 'apps/mobile') });
    if (!(await realpath(preset.stdout)).startsWith(await realpath(root))) throw Error('Expo Babel preset escaped the standalone workspace.');
    await execute('pnpm', ['typecheck:all'], root);
  }
  console.log(JSON.stringify({ archive, sourceFiles: files, sourceContractVerified: true, privatePathsExcluded: true, freshInstallVerified: process.argv.includes('--install') }));
} finally { await rm(directory, { recursive: true, force: true }); }
