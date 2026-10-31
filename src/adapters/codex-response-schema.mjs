import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string, any>} Value */
const ajv = new Ajv({ allErrors: false, strictSchema: true, strictTypes: false, ownProperties: true, coerceTypes: false, useDefaults: false });
const installFormats = /** @type {(validator:Ajv)=>void} */ (/** @type {unknown} */ (addFormats));
installNativeFormats(ajv);
const files = { 'user-input': 'ToolRequestUserInputResponse', permissions: 'PermissionsRequestApprovalResponse', elicitation: 'McpServerElicitationRequestResponse' };
/** @type {Promise<Map<string,import('ajv').ValidateFunction>>|null} */ let loading = null;
/** @type {Map<string,import('ajv').ValidateFunction>|null} */ let loadedValidators = null;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

/** Rust schemars numeric formats must retain bounds rather than be silently ignored.
 * @param {Ajv} validator */
function installNativeFormats(validator) {
  installFormats(validator);
  for (const name of ['uint', 'uint64']) validator.addFormat(name, { type: 'number', validate: (value) => Number.isSafeInteger(value) && value >= 0 });
  validator.addFormat('uint32', { type: 'number', validate: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 4294967295 });
  for (const name of ['int64', 'int']) validator.addFormat(name, { type: 'number', validate: Number.isSafeInteger });
  validator.addFormat('int32', { type: 'number', validate: (value) => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647 });
  validator.addFormat('double', { type: 'number', validate: Number.isFinite });
}

/** @param {unknown} value @returns {value is Value} */
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** Reject non-JSON or prototype-bearing response data before validation or forwarding.
 * @param {unknown} value @returns {any} */
export function safeResponseJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.map(safeResponseJson);
  if (!record(value)) throw new BridgeError('invalid-response', 'Native response must contain JSON values only.');
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new BridgeError('invalid-response', 'Unsafe native response key.');
    Object.defineProperty(result, key, { enumerable: true, writable: true, configurable: true, value: safeResponseJson(child) });
  }
  return result;
}

/** Generated serde schemas permit ignored fields; the bridge rejects them explicitly.
 * @param {Value} schema @returns {Value} */
function strictObjects(schema) {
  const output = structuredClone(schema);
  /** @param {any} value */
  const walk = (value) => {
    if (Array.isArray(value)) { for (const child of value) walk(child); return; }
    if (!record(value)) return;
    if (value.type === 'object' && value.properties && value.additionalProperties === undefined) value.additionalProperties = false;
    for (const child of Object.values(value)) walk(child);
  };
  walk(output);
  return output;
}

async function validators() {
  loading ??= (async () => {
    const result = new Map();
    for (const [kind, filename] of Object.entries(files)) {
      const schema = JSON.parse(await readFile(new URL(`./codex-schemas/${filename}.json`, import.meta.url), 'utf8'));
      result.set(kind, ajv.compile(strictObjects(schema)));
    }
    loadedValidators = result;
    return result;
  })();
  return loading;
}

/** Warm the shipped schema validators before native state is projected. */
export async function prepareNativeSchemas() { await validators(); }

/** @param {unknown} profile */
export function supportsNativePermissions(profile) {
  const validate = loadedValidators?.get('permissions');
  return record(profile) && validate?.({ permissions: profile }) === true;
}

/** @param {'user-input'|'permissions'|'elicitation'} kind @param {unknown} response @returns {Promise<Value>} */
export async function validateNativeResponse(kind, response) {
  const value = safeResponseJson(response);
  const validate = (await validators()).get(kind);
  if (!validate || !validate(value)) throw new BridgeError('invalid-response', `Response does not match the installed Codex ${kind} schema.`);
  return value;
}

/** @param {unknown} schema */
export function supportsForm(schema) {
  try { if (!record(schema)) return false; formValidator(schema); return true; }
  catch { return false; }
}

/** @param {Value} request @param {Value} response */
export function validateFormResponse(request, response) {
  if (request.mode === 'openai/userVerification') {
    if (response.action === 'accept') throw new BridgeError('native-verification-required', 'Acceptance requires the existing OS-protected verification flow.');
    if (response.content != null || response._meta != null) throw new BridgeError('invalid-response', 'Verification decline/cancel has no content.');
    return;
  }
  if (request.mode === 'url') {
    if (response.content != null) throw new BridgeError('invalid-response', 'URL elicitations have no form content.');
    return;
  }
  if (!['form', 'openai/form', 'openaiForm'].includes(request.mode)) throw new BridgeError('unsupported-elicitation', 'This native elicitation mode is unsupported.');
  if (response.action !== 'accept') {
    if (response.content != null) throw new BridgeError('invalid-response', 'Decline/cancel must not include accepted form content.');
    return;
  }
  let validate;
  try { validate = formValidator(request.requestedSchema); }
  catch { throw new BridgeError('unsupported-form-schema', 'The native form schema version or keywords are unsupported.'); }
  if (!validate(response.content)) throw new BridgeError('invalid-form-response', 'Response content did not match the pending native form.');
}

/** @type {Map<string,import('ajv').ValidateFunction>} */ const forms = new Map();
/** @param {unknown} schema */
function formValidator(schema) {
  const value = safeResponseJson(schema);
  const key = JSON.stringify(value);
  const cached = forms.get(key);
  if (cached) return cached;
  const validator = new Ajv({ strictSchema: true, strictTypes: false, ownProperties: true, coerceTypes: false, useDefaults: false });
  installNativeFormats(validator);
  const validate = validator.compile(value);
  if (forms.size >= 64) forms.delete(forms.keys().next().value ?? '');
  forms.set(key, validate);
  return validate;
}

/** @param {Value} request @param {Value} response */
export function validateQuestionResponse(request, response) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const ids = questions.map((question) => question.id);
  if (!ids.length || ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length ||
    Object.keys(response.answers).length !== ids.length || Object.keys(response.answers).some((id) => !ids.includes(id))) {
    throw new BridgeError('invalid-answer-identity', 'Answers must match the pending question identities exactly.');
  }
}

/** @param {Value} requested @param {Value} response */
export function validatePermissionSubset(requested, response) {
  const granted = response.permissions;
  if (granted.network?.enabled === true && requested.network?.enabled !== true) throw new BridgeError('permission-expansion', 'The grant exceeds the pending network request.');
  if (granted.fileSystem == null) return;
  const offered = requested.fileSystem ?? {};
  for (const key of ['read', 'write', 'entries']) {
    if (granted.fileSystem[key] == null) continue;
    const choices = Array.isArray(offered[key]) ? offered[key].map(canonical) : [];
    if (granted.fileSystem[key].some((/** @type {unknown} */ choice) => !choices.includes(canonical(choice)))) throw new BridgeError('permission-expansion', 'The grant exceeds the pending filesystem request.');
  }
  if (granted.fileSystem.globScanMaxDepth != null && (!Number.isSafeInteger(offered.globScanMaxDepth) || granted.fileSystem.globScanMaxDepth > offered.globScanMaxDepth)) {
    throw new BridgeError('permission-expansion', 'The grant exceeds the pending glob scan depth.');
  }
}

/** @param {any} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
