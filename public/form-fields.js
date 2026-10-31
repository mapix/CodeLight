/** @typedef {Record<string, any>} Schema */
/** @typedef {{node:HTMLElement,value:()=>any}} Field */
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
let nextId = 0;

/** @param {string} tag @param {string} [text] @param {string} [className] @returns {any} */
function node(tag, text = '', className = '') {
  const value = document.createElement(tag); value.textContent = text; if (className) value.className = className; return value;
}
/** @param {string} label @param {string} value */
function option(label, value) { const choice = document.createElement('option'); choice.textContent = label; choice.value = value; return choice; }
/** @param {HTMLElement} root */
function syncDisabled(root) {
  for (const control of root.querySelectorAll('input,select,textarea,button')) {
    let parent = control.parentElement; let disabled = false;
    while (parent) { if (parent.tagName === 'FIELDSET' && /** @type {any} */ (parent).disabled) { disabled = true; break; } parent = parent.parentElement; }
    /** @type {any} */ (control).disabled = disabled;
  }
}
/** @param {unknown} value @returns {value is Schema} */
const object = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {Schema} root @param {any} schema @param {string[]} [seen] @returns {Schema} */
function resolve(root, schema, seen = []) {
  if (schema === true) return { type: 'string' };
  if (!object(schema)) throw Error('这个字段需要在桌面填写。');
  if (seen.length > 24) throw Error('嵌套表单过深，请在桌面填写。');
  let value = { ...schema };
  if (value.$ref) {
    if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#') || seen.includes(value.$ref)) throw Error('这个引用表单需要在桌面填写。');
    let target = root;
    for (const part of value.$ref.slice(1).split('/').slice(1)) {
      const key = decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~');
      if (forbidden.has(key) || (!object(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) throw Error('表单引用不存在。');
      target = target[key];
    }
    value = { ...resolve(root, target, [...seen, value.$ref]), ...value }; delete value.$ref;
  }
  if (Array.isArray(value.allOf)) {
    const branches = value.allOf.map((/** @type {Schema} */ branch) => resolve(root, branch, seen));
    for (const branch of branches) {
      value = { ...value, ...branch, properties: { ...value.properties, ...branch.properties }, required: [...new Set([...(value.required ?? []), ...(branch.required ?? [])])] };
    }
    delete value.allOf;
  }
  return value;
}

/** @param {Schema} schema */
function choices(schema) {
  if (Array.isArray(schema.enum)) return schema.enum.map((/** @type {any} */ value, /** @type {number} */ index) => ({ value, label: schema.enumNames?.[index] ?? String(value) }));
  const variants = schema.oneOf ?? schema.anyOf;
  return Array.isArray(variants) && variants.length && variants.every((/** @type {Schema} */ option) => object(option) && Object.hasOwn(option, 'const'))
    ? variants.map((/** @type {Schema} */ option) => ({ value: option.const, label: option.title ?? String(option.const) })) : null;
}

/** @param {Schema} root @param {any} source @param {string} label @param {boolean} required @param {any} initial @param {number} depth @returns {Field} */
function build(root, source, label, required, initial, depth) {
  if (depth > 24) throw Error('嵌套表单过深，请在桌面填写。');
  const schema = resolve(root, source);
  const hasDefault = initial !== undefined || Object.hasOwn(schema, 'default');
  const value = initial === undefined ? schema.default : initial;
  const enumChoices = choices(schema);
  if (Object.hasOwn(schema, 'const')) return { node: node('p', `${schema.title ?? label}：${String(schema.const)}`), value: () => structuredClone(schema.const) };
  let type = schema.type ?? (schema.properties ? 'object' : enumChoices ? typeof enumChoices[0].value : 'string');
  if (type === 'null') return { node: node('p', `${schema.title ?? label}：空值`), value: () => null };
  if (Array.isArray(type)) {
    const nonNull = type.filter((/** @type {string} */ item) => item !== 'null');
    if (type.includes('null') && nonNull.length === 1) {
      const wrap = node('fieldset'); wrap.append(node('legend', schema.title ?? label));
      const choice = document.createElement('select'); choice.setAttribute('aria-label', `${label} 值类型`);
      choice.append(option('填写', 'value'), option('空值', 'null')); choice.value = value === null ? 'null' : 'value';
      const body = node('fieldset'); const inner = build(root, { ...schema, type: nonNull[0], default: value === null ? undefined : value }, label, required, value === null ? undefined : value, depth + 1);
      body.append(inner.node); body.disabled = choice.value === 'null'; choice.addEventListener('change', () => { body.disabled = choice.value === 'null'; syncDisabled(wrap); });
      wrap.append(choice, body); return { node: wrap, value: () => choice.value === 'null' ? null : inner.value() };
    }
    throw Error('这个多类型字段需要在桌面填写。');
  }
  if (!enumChoices && (schema.oneOf || schema.anyOf)) {
    const variants = schema.oneOf ?? schema.anyOf;
    if (!Array.isArray(variants) || !variants.length) throw Error('表单分支无效。');
    const wrap = node('fieldset'); wrap.append(node('legend', schema.title ?? label));
    const select = document.createElement('select'); select.setAttribute('aria-label', `${label} 类型`);
    variants.forEach((/** @type {Schema} */ variant, /** @type {number} */ index) => select.append(option(variant.title ?? variant.type ?? `选项 ${index + 1}`, String(index))));
    const body = node('div');
    /** @type {Field} */
    let inner;
    const update = () => { const base = { ...schema }; delete base.oneOf; delete base.anyOf; inner = build(root, { ...base, ...variants[Number(select.value || 0)] }, label, required, value, depth + 1); body.replaceChildren(inner.node); };
    update(); select.addEventListener('change', update); wrap.append(select, body); return { node: wrap, value: () => inner.value() };
  }
  if (type === 'object') {
    if (!object(schema.properties ?? {})) throw Error('对象字段无效。');
    const wrap = node('fieldset'); wrap.append(node('legend', schema.title ?? label)); const body = node('fieldset');
    /** @type {Array<[string,Field]>} */ const fields = [];
    for (const [name, definition] of Object.entries(schema.properties ?? {})) {
      if (forbidden.has(name)) throw Error('这个字段名称不受支持。');
      const field = build(root, definition, name, (schema.required ?? []).includes(name), object(value) && Object.hasOwn(value, name) ? value[name] : undefined, depth + 1);
      fields.push([name, field]); body.append(field.node);
    }
    let enabled = true;
    if (!required) {
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = hasDefault;
      const title = node('label', `填写 ${schema.title ?? label}`, 'request-field'); title.prepend(toggle); wrap.append(title);
      enabled = toggle.checked; body.disabled = !enabled; toggle.addEventListener('change', () => { enabled = toggle.checked; body.disabled = !enabled; syncDisabled(wrap); });
    }
    wrap.append(body); return { node: wrap, value: () => enabled ? Object.fromEntries(fields.map(([name, field]) => [name, field.value()]).filter(([, value]) => value !== undefined)) : undefined };
  }
  if (type === 'array') {
    const wrap = node('fieldset'); wrap.append(node('legend', schema.title ?? label));
    const arrayBody = node('fieldset'); let enabled = true;
    if (!required) { const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = hasDefault; const title = node('label', `填写 ${schema.title ?? label}`, 'request-field'); title.prepend(toggle); wrap.append(title); enabled = toggle.checked; arrayBody.disabled = !enabled; toggle.addEventListener('change', () => { enabled = toggle.checked; arrayBody.disabled = !enabled; syncDisabled(wrap); }); }
    wrap.append(arrayBody);
    const itemSchema = resolve(root, schema.items ?? true); const enumItems = choices(itemSchema);
    if (enumItems) {
      const controls = enumItems.map((option) => {
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = Array.isArray(value) && value.some((item) => JSON.stringify(item) === JSON.stringify(option.value));
        const title = node('label', option.label, 'request-field'); title.prepend(check); arrayBody.append(title);
        return { check, value: option.value };
      });
      return { node: wrap, value: () => {
        if (!enabled) return undefined;
        const values = controls.filter((item) => item.check.checked).map((item) => item.value); checkArrayBounds(schema, values, label); return values;
      } };
    }
    const body = node('div');
    /** @type {Field[]} */
    const entries = [];
    const append = (/** @type {any} */ value) => {
      const entry = build(root, schema.items ?? true, `${label} 第 ${entries.length + 1} 项`, true, value, depth + 1); entries.push(entry);
      const row = node('fieldset'); const remove = node('button', '移除这项', 'request-secondary'); remove.type = 'button';
      remove.addEventListener('click', () => { const index = entries.indexOf(entry); if (index >= 0) entries.splice(index, 1); row.remove(); });
      row.append(entry.node, remove); body.append(row);
    };
    const defaults = Array.isArray(value) ? value : Array.from({ length: schema.minItems ?? 0 }, () => undefined); defaults.forEach(append);
    const add = node('button', '新增一项', 'request-secondary'); add.type = 'button'; add.addEventListener('click', () => { if (schema.maxItems !== undefined && entries.length >= schema.maxItems) return; append(undefined); syncDisabled(wrap); });
    arrayBody.append(body, add); return { node: wrap, value: () => {
      if (!enabled) return undefined;
      const result = entries.map((entry) => entry.value()); checkArrayBounds(schema, result, label); return result;
    } };
  }
  const wrap = node('label', '', 'request-field'); const id = `form-field-${++nextId}`; wrap.htmlFor = id; wrap.append(node('span', schema.title ?? label));
  if (schema.description) wrap.append(node('small', schema.description));
  const control = /** @type {any} */ (enumChoices ? document.createElement('select') : document.createElement('input')); control.id = id; control.setAttribute('data-field-name', label); control.setAttribute('aria-label', schema.title ?? label);
  let dirty = false; control.addEventListener('input', () => { dirty = true; }); control.addEventListener('change', () => { dirty = true; });
  if (enumChoices) {
    control.append(option('请选择', ''));
    enumChoices.forEach((choice, index) => control.append(option(choice.label, String(index))));
    const index = enumChoices.findIndex((option) => JSON.stringify(option.value) === JSON.stringify(value)); if (index >= 0) control.value = String(index);
  } else {
    control.type = type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(type) ? 'number' : schema.format === 'email' ? 'email' : schema.format === 'uri' ? 'url' : 'text';
    if (!['boolean', 'number', 'integer', 'string'].includes(type)) throw Error('这个字段类型需要在桌面填写。');
    if (type === 'boolean') control.checked = value === true;
    else if (value !== undefined && value !== null) control.value = String(value);
    if (type === 'number' || type === 'integer') { control.step = type === 'integer' ? '1' : 'any'; if (schema.minimum != null) control.min = String(schema.minimum); if (schema.maximum != null) control.max = String(schema.maximum); }
    if (schema.minLength != null) control.minLength = schema.minLength; if (schema.maxLength != null) control.maxLength = schema.maxLength; if (schema.pattern) control.pattern = schema.pattern;
  }
  control.required = required && type !== 'boolean'; wrap.append(control);
  return { node: wrap, value: () => {
    if (type === 'boolean' && !enumChoices) return !required && !hasDefault && !dirty ? undefined : control.checked;
    if (control.value === '') { if (required) throw Error(`请填写 ${schema.title ?? label}。`); return undefined; }
    if (enumChoices) return enumChoices[Number(control.value)].value;
    if (type === 'number' || type === 'integer') { const value = Number(control.value); if (!Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) throw Error(`请填写有效的 ${label}。`); return value; }
    return control.value;
  } };
}

/** @param {Schema} schema @param {any[]} value @param {string} label */
function checkArrayBounds(schema, value, label) {
  if (schema.minItems != null && value.length < schema.minItems) throw Error(`${label} 至少需要 ${schema.minItems} 项。`);
  if (schema.maxItems != null && value.length > schema.maxItems) throw Error(`${label} 最多允许 ${schema.maxItems} 项。`);
}

/** Assemble an actual DOM form; caller validates the returned JSON against the native requested schema.
 * @param {Schema} schema @returns {Field} */
export function createSchemaForm(schema) { const field = build(schema, schema, '表单', true, undefined, 0); syncDisabled(field.node); return field; }
