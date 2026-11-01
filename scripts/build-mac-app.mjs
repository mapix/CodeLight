import { mkdir, readFile, writeFile, cp, symlink, realpath, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/** @typedef {Record<string,any>} Value */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, 'deliverables/mac-app-20261031/CodeLight.app'));
const resources = join(output, 'Contents/Resources'), runtime = join(resources, 'runtime');
const happy = root;
const require = createRequire(join(happy, 'package.json'));
const inspect = promisify(execFile);
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/u.test(packageMetadata.version)) throw Error('Mac releases require a numeric three-part version.');
const appBuild = new Date().toISOString().slice(0, 10).replaceAll('-', '');
/** @param {string} command @param {string[]} args @param {string} [cwd] */
async function run(command, args, cwd = root) {
  const process = spawn(command, args, { cwd, stdio: 'inherit' });
  const code = await new Promise((resolveDone, reject) => { process.once('error', reject); process.once('exit', resolveDone); });
  if (code !== 0) throw Error(`${command} exited ${code}`);
}
/** @param {string} name @param {string} from */
async function packageRoot(name, from) {
  const req = createRequire(join(from, 'package.json'));
  let entry;
  try { entry = req.resolve(name + '/package.json'); }
  catch { entry = req.resolve(name); }
  let folder = dirname(await realpath(entry));
  while (folder !== dirname(folder)) {
    try { const data = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')); if (data.name === name) return { folder, data }; } catch { /* keep walking to the owning manifest */ }
    folder = dirname(folder);
  }
  throw Error(`Cannot resolve production dependency ${name}`);
}
/** @type {Map<string,string>} */ const copied = new Map();
/** @param {string} name @param {string} from @param {string} target */
async function copyPackage(name, from, target) {
  const source = await packageRoot(name, from), id = createHash('sha256').update(source.folder).digest('hex').slice(0, 16);
  const destination = join(runtime, 'node_modules/.codelight', id);
  if (!copied.has(source.folder)) {
    copied.set(source.folder, destination);
    await cp(source.folder, destination, { recursive: true, dereference: true, filter: path => !relative(source.folder, path).split('/').includes('node_modules') });
    for (const dependency of Object.keys(source.data.dependencies ?? {})) await copyPackage(dependency, source.folder, join(destination, 'node_modules', dependency));
    for (const dependency of Object.keys(source.data.optionalDependencies ?? {})) {
      try { await copyPackage(dependency, source.folder, join(destination, 'node_modules', dependency)); } catch { /* uninstalled foreign-platform optional dependency */ }
    }
  }
  await mkdir(dirname(target), { recursive: true });
  try { await symlink(relative(dirname(target), destination), target, 'dir'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error; }
}
await access(output).then(() => { throw Error('The output app directory already exists. Choose a fresh output path.'); }, () => {});
await mkdir(join(output, 'Contents/MacOS'), { recursive: true }); await mkdir(join(runtime, 'server'), { recursive: true }); await mkdir(join(runtime, 'src/happy'), { recursive: true });
await cp(process.env.CODELIGHT_NODE_BINARY ?? process.execPath, join(runtime, 'node'));
await cp(process.env.CODELIGHT_CLOUDFLARED_BINARY ?? join(root, '.runtime/cloudflared'), join(runtime, 'cloudflared'));
await cp(join(root, 'native/bin'), join(runtime, 'native/bin'), { recursive: true });
await cp(join(root, 'src/adapters/codex-schemas'), join(runtime, 'src/happy/codex-schemas'), { recursive: true });
await cp(join(root, 'src/happy/codex-index-worker.mjs'), join(runtime, 'src/happy/codex-index-worker.mjs'));
await cp(join(happy, 'packages/relay/prisma'), join(runtime, 'server/prisma'), { recursive: true });
const esbuild = require.resolve('esbuild/bin/esbuild');
await run(esbuild, [join(happy, 'packages/relay/sources/standalone.ts'), '--bundle', '--platform=node', '--format=esm',
  '--banner:js=import { createRequire as runtimeRequire } from "node:module"; import { fileURLToPath as runtimeFile } from "node:url"; import { dirname as runtimeDir } from "node:path"; const require = runtimeRequire(import.meta.url); const __filename = runtimeFile(import.meta.url); const __dirname = runtimeDir(__filename);',
  '--outfile=' + join(runtime, 'server/standalone.mjs'), '--tsconfig=' + join(happy, 'packages/relay/tsconfig.json'),
  '--external:@prisma/client', '--external:@electric-sql/pglite', '--external:pglite-prisma-adapter', '--external:sharp', '--external:redis']);
await run(esbuild, [join(root, 'src/happy/mac-app-service.mjs'), '--bundle', '--platform=node', '--format=esm',
  '--packages=external', '--outfile=' + join(runtime, 'src/happy/mac-app-service.mjs')]);
const serverDeps = ['@prisma/client', '@electric-sql/pglite', 'pglite-prisma-adapter', 'sharp'];
for (const name of serverDeps) await copyPackage(name, join(happy, 'packages/relay'), join(runtime, 'node_modules', name));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const name of Object.keys(pkg.dependencies)) await copyPackage(name, root, join(runtime, 'node_modules', name));
const relayRequire = createRequire(join(root, 'packages/relay/package.json'));
const prismaManifest = relayRequire.resolve('@prisma/client/package.json');
const generatedPrisma = dirname(relayRequire.resolve('.prisma/client/default', { paths: [prismaManifest] }));
await cp(generatedPrisma, join(runtime, 'node_modules/.prisma/client'), { recursive: true });
await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'codelight-mac-runtime', private: true, type: 'module' }));
await cp(join(root, 'assets/branding/CodeLight.icns'), join(resources, 'CodeLight.icns'));
await cp(join(root, 'assets/branding/app-icon-v1.png'), join(resources, 'brand-icon.png'));
await run('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', 'arm64-apple-macosx14.0', join(root, 'apps/mac/CodeLight.swift'), '-o', join(output, 'Contents/MacOS/CodeLight')]);
await writeFile(join(output, 'Contents/Info.plist'), `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.learnings.codelight.mac</string><key>CFBundleName</key><string>CodeLight</string><key>CFBundleDisplayName</key><string>CodeLight</string>
<key>CFBundleIconFile</key><string>CodeLight.icns</string><key>CFBundleExecutable</key><string>CodeLight</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${packageMetadata.version}</string><key>CFBundleVersion</key><string>${appBuild}</string>
<key>NSLocalNetworkUsageDescription</key><string>Connect your paired phone to CodeLight on the local network.</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/><key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>`);
const chinese = {
  "Start": "开始",
  "Pause": "暂停",
  "Paused": "已暂停",
  "Pausing…": "正在暂停…",
  "Connections": "连接方式",
  "Local network": "本地网络",
  "Configure Relay": "配置 Relay",
  "Ready": "已就绪",
  "Off": "已关闭",
  "Starting…": "正在启动…",
  "Reconnecting…": "正在重连…",
  "Not verified yet": "尚未验证",
  "Unavailable": "暂不可用",
  "All connections are off": "所有连接已关闭",
  "Waiting for connection verification…": "正在等待连接验证…",
  "The phone chooses an available connection. You can switch connections there anytime.": "手机会自动选择可用连接，也可以随时在手机上切换。",
  "An address is waiting for verification. The phone can check it when connecting.": "部分地址尚未验证，手机连接时可以继续检查。",
  "Could not update connection channels. Try again.": "连接方式修改失败，请重试。",
  "Relay server address": "Relay 服务地址",
  "Access key": "访问密钥",
  "Saved key will be reused for this server.": "已保存密钥，仅复用到同一服务地址。",
  "Validate & save Relay": "校验并保存 Relay",
  "Validating Relay…": "正在校验 Relay…",
  "Could not validate the Relay connection. Check address, access key and network.": "Relay 连接校验失败，请检查地址、访问密钥和网络。",
  "The phone keeps all enabled addresses. If addresses change and reconnection fails, scan the current QR code.": "手机会保存所有已启用地址。地址改变且无法重连时，请扫描当前二维码。",
 'Starting CodeLight…': '正在启动 CodeLight…', 'Connecting from anywhere…': '正在连接公网入口…', 'Ready to scan': '可以扫码连接', 'Connection unavailable': '连接暂不可用', 'Your existing Codex sessions on your phone': '在手机上使用电脑已有的 Codex 会话', 'Open CodeLight on your phone and scan this code. No registration or VPN needed.': '打开手机 CodeLight 扫描二维码，无需注册或安装 VPN。', 'Copy pairing link': '复制配对链接', 'Refresh QR': '刷新二维码', 'Retry': '重试', 'Paired devices': '连接的设备', 'No devices yet': '尚未连接设备', 'Disconnect': '解除连接', 'Connected': '已连接', 'Offline': '离线', 'Access removed': '已解除连接', 'Notifications configured': '已配置通知', 'Notifications need setup': '通知尚未配置', 'Copied': '已复制', 'Could not update device. Try again.': '设备操作暂未成功，请重试。',
  "Connection ready": "连接已就绪",
  "Only desktop Codex connected through gateway mode is supported.": "只支持使用网关模式接入的桌面Codex",
  "View": "视图",
  "Statistics": "统计",
  "Pairing": "扫码配对",
  "Gateway traffic": "网关流量",
  "Receiving": "接收速率",
  "Sending": "发送速率",
  "This connection": "本次连接",
  "All time": "累计流量",
  "Received": "已接收",
  "Sent": "已发送",
  "HTTP requests": "HTTP 请求",
  "RPC calls": "RPC 调用",
  "Connected devices": "在线设备",
  "Uptime": "运行时长",
  "Gateway traffic measured by CodeLight. — means not measured.": "统计 CodeLight 网关流量。「—」表示尚未测量。",
  "Waiting for gateway measurements…": "正在等待网关统计数据…",
  "/s": "/秒"
};
await mkdir(join(resources, 'zh-Hans.lproj'), { recursive: true });
await writeFile(join(resources, 'zh-Hans.lproj/Localizable.strings'), Object.entries(chinese).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)};`).join('\n'));
await cp(join(root, 'THIRD-PARTY-NOTICES.md'), join(resources, 'THIRD-PARTY-NOTICES.md'));
await mkdir(join(resources, 'licenses'), { recursive: true });
await cp(process.env.CODELIGHT_NODE_LICENSE ?? join(root, 'licenses/Node.js-LICENSE'), join(resources, 'licenses/Node.js-LICENSE'));
await cp(join(root, 'apps/mac/cloudflared-LICENSE.txt'), join(resources, 'licenses/cloudflared-LICENSE.txt'));
const nodeVersion = (await inspect(join(runtime, 'node'), ['--version'])).stdout.trim();
const cloudflaredVersion = (await inspect(join(runtime, 'cloudflared'), ['--version'])).stdout.trim();
console.log(JSON.stringify({ app: output, version: packageMetadata.version, productionPackages: copied.size, cloudflared: cloudflaredVersion, node: nodeVersion }));
