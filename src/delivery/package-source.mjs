import { readdir, lstat, mkdir, copyFile, chmod, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';

export const ROOT_ENTRIES = ['src', 'scripts', 'spec', 'test', 'native', 'public', 'deployments', 'package.json', 'package-lock.json',
  'README.md', 'CODELIGHT-MAC.md', 'CODELIGHT-DELIVERY.md', 'THIRD-PARTY-NOTICES.md', 'start-codelight.sh', 'tsconfig.json', 'eslint.config.mjs'];
export const HAPPY_PACKAGES = new Set(['happy-app', 'happy-agent', 'happy-cli', 'happy-server', 'happy-server-self-host', 'happy-wire', 'happy-app-logs', 'happy-mobile-gym', 'expo-tailcat']);
export const HAPPY_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.gitignore', 'LICENSE', 'AGENTS.md', 'Dockerfile', 'tsconfig.json'];
const EXCLUDED_DIRS = new Set(['private', 'evidence', 'data', 'research', 'deliverables', 'mobile', 'trash', '.trash', 'node_modules', 'Pods', 'build', 'dist', 'target', 'out', 'DerivedData', '.git', '.gradle', '.expo', '.cxx', '.module-cache', '.build', '__pycache__', 'xcuserdata', '.environments', '.context', '.claude', '.cache', '.turbo', 'coverage', 'logs', 'archives']);
const FORBIDDEN_EXTENSIONS = /\.(?:log|sqlite(?:-wal|-shm)?|db|pcap|pcapng|xcresult|ipa|apk|mobileprovision|p8|p12|jks|pem|key|tsbuildinfo|xcuserstate)$/iu;
const PRIVATE_NAMES = new Set(['account.json', 'machine.json', 'paired-clients.json', 'command-receipts.json', 'credentials.json', '.DS_Store', '.xcode.env.local', 'server.env', 'client.env', '.cursorrules', '.windsurfrules']);
const OBSOLETE_PRODUCT_SPECS = new Set(['spec/delivery.md', 'spec/native-mobile-app.md', 'spec/native-mobile-transport.md']);

/** @param {string} name */
export function forbiddenSourcePath(name) {
  const parts = name.replaceAll('\\', '/').split('/');
  const normalized = parts.join('/');
  if (OBSOLETE_PRODUCT_SPECS.has(normalized) || normalized.startsWith('CodeLight/') && OBSOLETE_PRODUCT_SPECS.has(normalized.slice('CodeLight/'.length))) return true;
  if (/(?:^|\/)native\/(?:codelight-native-worker-qa|codelight-qa)(?:\/|$)|(?:^|\/)scripts\/package\.mjs$/u.test(normalized)) return true;
  return parts.some(part => EXCLUDED_DIRS.has(part) || part.startsWith('.env') || /^WORKLOG.*\.md$/iu.test(part) || PRIVATE_NAMES.has(part) || part.endsWith('-binding.json') || /\.(?:app|framework|xcframework|xcarchive|bundle|xcresult)$/iu.test(part)) || FORBIDDEN_EXTENSIONS.test(name);
}

/** Positive allowlist copy. Symlinks are rejected instead of following a path out of the source root.
 * @param {string} root @param {string} staging @param {{happyFiles?:string[]}} [options] */
export async function copyCodeLightSource(root, staging, options = {}) {
  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const skipped = [];
  /** @type {{file:string, removedScripts:string[]}[]} */ const transformations = [];
  /** @param {string} name */
  const copy = async name => {
    if (forbiddenSourcePath(name)) { skipped.push(name); return; }
    const input = join(root, name); let info;
    try { info = await lstat(input); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw Error(`Source symlink refused: ${name}`);
    if (info.isDirectory()) {
      for (const child of (await readdir(input)).sort()) await copy(join(name, child));
    } else if (info.isFile()) {
      const output = join(staging, name); await mkdir(dirname(output), { recursive: true }); await copyFile(input, output);
      if (name.replaceAll('\\', '/') === 'clients/happy/package.json') {
        /** @type {{scripts?:Record<string,string>}} */ const product = JSON.parse(await readFile(output, 'utf8'));
        const scripts = product.scripts;
        const removedScripts = scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? Object.keys(scripts).filter(key => key.startsWith('env:')).sort() : [];
        if (removedScripts.length) {
          // 上游 env 命令依赖未分发的模块，只收口交付副本，不能改动当前 native 构建工作区。
          for (const key of removedScripts) delete scripts?.[key];
          await writeFile(output, `${JSON.stringify(product, null, 4)}\n`);
          transformations.push({ file: 'clients/happy/package.json', removedScripts });
        }
      }
      await chmod(output, info.mode & 0o111 ? 0o755 : 0o644); files.push(relative(staging, output).replaceAll('\\', '/'));
    }
  };
  for (const entry of ROOT_ENTRIES) await copy(entry);
  for (const entry of options.happyFiles ?? HAPPY_FILES) {
    const name = entry.replaceAll('\\', '/');
    if (name.startsWith('/') || name.split('/').includes('..')) throw Error('Invalid Happy source-list path.');
    await copy(join('clients', 'happy', name));
  }
  return { files, skipped, transformations };
}
