import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { copyPublicSourceSnapshot } from '../src/release/source-snapshot.mjs';
const run = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'deliverables'); await mkdir(output, { recursive: true });
const { stdout } = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const files = [...new Set(stdout.split('\0').filter(Boolean))];
const temp = await mkdtemp(join(tmpdir(), 'codelight-source-')), stage = join(temp, 'codelight'); await mkdir(stage);
try {
  const copied = await copyPublicSourceSnapshot(root, stage, files);
  const archive = join(output, 'CodeLight-Source.zip'); await rm(archive, { force: true });
  await run('ditto', ['-c', '-k', '--keepParent', stage, archive]);
  await writeFile(join(output, 'source-manifest.json'), JSON.stringify({ product: 'CodeLight', sourceFiles: copied.length, files: copied, archive, privateStateExcluded: true }, null, 2));
  console.log(JSON.stringify({ archive, sourceFiles: copied.length }));
} finally { await rm(temp, { recursive: true, force: true }); }
