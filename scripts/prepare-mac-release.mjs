import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, stat, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { validatePublicArtifact } from '../src/release/public-artifact.mjs';

const run = promisify(execFile), flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--app', '--notary-status', '--output', '--team'].includes(key) || !value) throw Error('Use --app, --notary-status, --output and --team.');
  flags.set(key, value);
}
if (!flags.has('--app') || !flags.has('--notary-status') || !flags.has('--output') || !flags.has('--team')) throw Error('All four release options are required.');
const app = resolve(flags.get('--app')), directory = resolve(flags.get('--output')), team = flags.get('--team');
const plist = join(app, 'Contents/Info.plist');
const identifier = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', plist])).stdout.trim();
if (identifier !== 'com.learnings.codelight.mac') throw Error('Release operations are restricted to the CodeLight Mac bundle.');
const version = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plist])).stdout.trim();
await run('codesign', ['--verify', '--deep', '--strict', app]);
const details = (await run('codesign', ['--display', '--verbose=4', app])).stderr;
if (!details.includes(`TeamIdentifier=${team}\n`) || !details.includes('Authority=Developer ID Application:') || !details.includes('Timestamp=')) throw Error('Expected timestamped Developer ID signing was not verified.');
const notary = JSON.parse(await readFile(resolve(flags.get('--notary-status')), 'utf8'));
if (notary.status !== 'Accepted' || typeof notary.id !== 'string') throw Error('Apple notarization must be Accepted before publication.');
await run('xcrun', ['stapler', 'staple', app]);
await run('xcrun', ['stapler', 'validate', app]);
await run('codesign', ['--verify', '--deep', '--strict', app]);
await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
await mkdir(directory, { recursive: true });
const filename = `CodeLight-${version}-macos-arm64.zip`, archive = join(directory, filename);
await access(archive).then(() => { throw Error('An immutable release archive already exists.'); }, () => {});
await run('ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', app, archive]);
await run('unzip', ['-tq', archive]);
const digest = createHash('sha256'); for await (const chunk of createReadStream(archive)) digest.update(chunk);
const metadata = validatePublicArtifact({ version, filename, bytes: (await stat(archive)).size, sha256: digest.digest('hex'), notarization: 'Accepted', stapled: true, gatekeeperAccepted: true });
await writeFile(join(directory, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(join(directory, filename + '.sha256'), metadata.sha256 + '  ' + filename + '\n');
console.log(JSON.stringify({ ...metadata, notarizationId: notary.id, output: directory }));
