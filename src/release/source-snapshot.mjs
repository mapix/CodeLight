import { lstat, mkdir, copyFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SOURCE_ROOTS = new Set(['src', 'scripts', 'spec', 'test', 'native', 'public', 'apps', 'packages', 'assets', 'licenses', 'patches', 'docs', 'website', 'deploy', '.github']);
const ROOT_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'AGENTS.md', 'tsconfig.json', 'eslint.config.mjs', '.nvmrc', '.npmrc', '.gitignore', '.gitleaks.toml']);
const PRIVATE_DIRS = new Set(['private', 'evidence', 'data', 'research', 'deliverables', 'output', 'node_modules', 'Pods', 'Build', 'build', 'dist', '.git', '.runtime', '.venv', '.module-cache', '.build', '.expo', '.gradle', 'trash', 'xcuserdata', 'DerivedData', 'coverage']);
const PRIVATE_FILES = new Set(['account.json', 'devices.json', 'relay-key.json', 'mac-box-key.json', 'apns.json', 'network-access.json', 'network-identity.json', 'credentials.json', 'command-receipts.json', '.xcode.env.local', '.DS_Store', '.cursorrules', '.windsurfrules']);
const OBSOLETE = new Set(['scripts/package.mjs', 'spec/delivery.md', 'spec/native-mobile-app.md', 'spec/native-mobile-transport.md', 'apps/mobile/google-services.json']);

/** The current source distribution uses explicit roots and independently excludes private state.
 * @param {string} name */
export function publicSourcePath(name) {
  const parts = name.split('/');
  if (!name || name.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) return false;
  if (!(parts.length === 1 ? ROOT_FILES.has(name) : SOURCE_ROOTS.has(parts[0]))) return false;
  if (OBSOLETE.has(name) || /^(?:native\/(?:bin|codelight-qa|codelight-native-worker-qa)|website\/(?:downloads|release\.json))(?:\/|$)/u.test(name)) return false;
  return !parts.some(part => PRIVATE_DIRS.has(part) || PRIVATE_FILES.has(part)
    || part.startsWith('.env') && part !== '.env.example' || /^WORKLOG.*\.md$/iu.test(part)
    || /\.(?:app|framework|xcframework|xcarchive|bundle|xcresult)$/iu.test(part))
    && !/\.(?:p8|p12|pem|key|mobileprovision|keystore|jks|ipa|apk|log|sqlite(?:-wal|-shm)?|db|pcap|pcapng|tsbuildinfo)$/iu.test(name);
}

/** Copy the same reviewed file selection into an archive stage or clean public Git snapshot.
 * @param {string} root @param {string} staging @param {string[]} names */
export async function copyPublicSourceSnapshot(root, staging, names) {
  const files = [];
  const checkedDirectories = new Set();
  for (const name of [...new Set(names)].sort()) {
    if (!publicSourcePath(name)) continue;
    const parents = name.split('/').slice(0, -1);
    for (let length = 1; length <= parents.length; length++) {
      const parent = parents.slice(0, length).join('/');
      if (checkedDirectories.has(parent)) continue;
      let directory;
      try { directory = await lstat(join(root, parent)); }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') break; throw error; }
      if (directory.isSymbolicLink()) throw Error(`Source symlink refused: ${parent}`);
      checkedDirectories.add(parent);
    }
    let info;
    // Git's cached list includes task-owned deletions; publishing must keep them deleted.
    // 已删除的跟踪文件仍在 Git 索引里，发行副本只能略过，不能复活旧配置或验收脚本。
    try { info = await lstat(join(root, name)); }
    catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) throw Error(`Source symlink refused: ${name}`);
    if (!info.isFile()) continue;
    const target = join(staging, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, name), target);
    await chmod(target, info.mode & 0o111 ? 0o755 : 0o644);
    files.push(name);
  }
  return files;
}
