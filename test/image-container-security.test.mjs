import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const mobile = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
const expo = createRequire(mobile.resolve('expo/package.json'));
const cli = createRequire(expo.resolve('@expo/cli/package.json'));
const config = createRequire(cli.resolve('@expo/metro-config/package.json'));
const wrapper = createRequire(config.resolve('@expo/metro/package.json'));
const metro = createRequire(wrapper.resolve('metro/package.json'));
const parser = metro.resolve('image-size');
const run = promisify(execFile);
const program = "const sizeOf=require(process.argv[1]);try{process.stdout.write(JSON.stringify({result:sizeOf(Buffer.from(process.argv[2],'base64'))}));}catch{process.stdout.write(JSON.stringify({rejected:true}));}";
/** A child timeout is a test isolation guard; parser progress must come from the patch.
 * @param {Buffer} input */
async function parse(input) { const reply = await run(process.execPath, ['-e', program, parser, input.toString('base64')], { timeout: 2000 }); return JSON.parse(reply.stdout); }
/** @param {string} type @param {number} size */
function entry(type, size) { const result = Buffer.alloc(8); result.write(type, 0, 4, 'ascii'); result.writeUInt32BE(size, 4); return result; }

test('legacy Metro parser rejects zero-length ICNS entries without spinning and preserves valid dimensions', async () => {
  const header = Buffer.alloc(8); header.write('icns', 0, 4, 'ascii'); header.writeUInt32BE(24, 4);
  const malformed = Buffer.concat([header, entry('icp4', 8), entry('icp5', 0)]);
  assert.equal((await parse(malformed)).rejected, true);
  const valid = Buffer.concat([header, entry('icp4', 8), entry('icp5', 8)]);
  const dimensions = (await parse(valid)).result;
  assert.equal(dimensions.width, 16); assert.equal(dimensions.height, 16); assert.equal(dimensions.images.length, 2);
});
test('zero-sized JXL/BMFF boxes advance to end rather than repeating a partial stream indefinitely', async () => {
  const signature = Buffer.from('0000000c4a584c200d0a870a', 'hex');
  const ftyp = Buffer.alloc(20); ftyp.writeUInt32BE(20, 0); ftyp.write('ftyp', 4, 4, 'ascii'); ftyp.write('jxl ', 8, 4, 'ascii');
  const partial = Buffer.alloc(12); partial.write('jxlp', 4, 4, 'ascii');
  assert.equal((await parse(Buffer.concat([signature, ftyp, partial]))).rejected, true);
});
