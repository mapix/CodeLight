/** @typedef {Record<string,any>} Value */

/** @param {unknown} value @returns {value is Value} */
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** Product scope only; native owner, identity and lease checks remain separate.
 * @param {unknown} source @param {unknown} [metadata] */
export function isCodeLightCodexSource(source, metadata) {
  if (!record(source) || source.app !== 'codex' || source.kind === 'window') return false;
  const value = record(metadata) ? metadata : {};
  const bridgeMode = record(value.bridge) ? value.bridge.controlMode : undefined;
  // 旧记录未声明 mode 时保留原生回退；显式非 session 值不能被恢复为 Codex 支持。
  return (bridgeMode === undefined || bridgeMode === 'session') &&
    (value.controlMode === undefined || value.controlMode === 'session');
}
