import { realpath, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { relative, isAbsolute } from 'node:path';
import { BridgeError } from './errors.mjs';

export class WindowFrames {
  /** @param {string} directory */
  constructor(directory) {
    this.directory = directory;
    /** @type {Map<string,{path:string,app:string,id:string,expires:number}>} */
    this.entries = new Map();
  }

  /** @param {import('./address.mjs').SessionAddress} address @param {Record<string,any>} view */
  async publish(address, view) {
    if (view.kind !== 'window' || typeof view.imagePath !== 'string') return view;
    const base = await realpath(this.directory);
    const path = await realpath(view.imagePath);
    const subpath = relative(base, path);
    if (subpath.startsWith('..') || isAbsolute(subpath) || !subpath.endsWith('.png')) throw new BridgeError('invalid-window-frame', '窗口图片不在本机服务的截图目录中。', 503);
    if ((await stat(path)).size > 8 * 1024 * 1024) throw new BridgeError('frame-too-large', '窗口图片太大，请缩小桌面窗口。', 503);
    const frameId = randomUUID();
    this.entries.set(frameId, { path, app: address.app, id: address.id, expires: Date.now() + 60_000 });
    for (const [key, entry] of this.entries) if (entry.expires < Date.now()) this.entries.delete(key);
    while (this.entries.size > 64) this.entries.delete(/** @type {string} */ (this.entries.keys().next().value));
    const output = { ...view }; delete output.imagePath;
    output.imageUrl = `/api/window-image?app=${encodeURIComponent(address.app)}&id=${encodeURIComponent(address.id)}&frame=${frameId}`;
    output.frameId = frameId;
    return output;
  }

  /** @param {import('./address.mjs').SessionAddress} address @param {string} frameId */
  async read(address, frameId) {
    const entry = this.entries.get(frameId);
    if (!entry || entry.app !== address.app || entry.id !== address.id || entry.expires < Date.now()) throw new BridgeError('frame-expired', '窗口图片已更新，请等待最新画面。', 410);
    try { return await readFile(entry.path); } catch { throw new BridgeError('frame-expired', '窗口图片已更新，请等待最新画面。', 410); }
  }
}
