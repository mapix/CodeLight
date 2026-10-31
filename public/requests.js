import { createSchemaForm } from './form-fields.js';

/** @typedef {Record<string,any>} Value */
const titles = { command: '允许执行这条命令？', file: '允许修改文件？', permissions: '这一步需要额外权限', 'user-input': '桌面会话需要你的回答', elicitation: '请补充这些信息' };
/** @param {string} tag @param {string} [text] @param {string} [className] @returns {any} */
function element(tag, text = '', className = '') { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
/** @param {string} label @param {string} value */
function option(label, value) { const node = document.createElement('option'); node.textContent = label; node.value = value; return node; }
/** @param {Value} request @param {string} action */
function allowed(request, action) { return request.operable === true && (!request.allowedActions || request.allowedActions.includes(action)); }

/** @param {HTMLElement} container @param {Value[]} requests @param {(action:string,payload:Value)=>Promise<boolean>} onCommand @param {Value[]} [rows] */
export function renderRequests(container, requests, onCommand, rows = []) {
  container.replaceChildren();
  for (const request of requests) renderRequest(container, request, onCommand);
  for (const row of rows) for (const question of row.asyncQuestions ?? []) if (!question.answered) renderAsyncQuestion(container, question, onCommand);
}

/** @param {HTMLElement} container @param {Value} request @param {(action:string,payload:Value)=>Promise<boolean>} onCommand */
function renderRequest(container, request, onCommand) {
  const card = element('section', '', 'request-card');
  card.append(element('h2', request.nativeKind === 'writeStdin' ? '允许向终端发送这段输入？' : titles[/** @type {keyof typeof titles} */ (request.kind)] ?? '请在桌面继续这一步'));
  if (request.reason || request.message) card.append(element('p', request.reason || request.message));
  if (request.command) card.append(element('pre', request.command));
  const form = document.createElement('form'); const actions = element('div', '', 'request-actions');
  const status = element('p', '', 'error'); status.setAttribute('role', 'alert'); let busy = false;
  /** @param {string} action @param {()=>Value} payload @param {HTMLButtonElement} button */
  const run = async (action, payload, button) => {
    if (busy || !allowed(request, action)) return;
    busy = true; form.querySelectorAll('button').forEach((control) => { control.disabled = true; }); status.textContent = '';
    try { const ok = await onCommand('approval', payload()); status.textContent = ok ? '已提交到桌面会话。' : '未确认成功，请查看下方提示。'; }
    catch (error) { status.textContent = error instanceof Error ? error.message : '提交未完成，请重试。'; }
    finally { busy = false; form.querySelectorAll('button').forEach((control) => { control.disabled = !allowed(request, control.dataset.nativeAction ?? 'accept'); }); button.disabled = !allowed(request, action); }
  };
  /** @param {string} label @param {string} action @param {()=>Value} payload */
  const action = (label, action, payload) => {
    const button = element('button', label, 'request-secondary'); button.type = 'button'; button.dataset.nativeAction = action; button.disabled = !allowed(request, action);
    button.addEventListener('click', () => { void run(action, payload, button); }); actions.append(button); return button;
  };
  /** @param {string} label @param {()=>Value} payload @param {boolean} [supported] */
  const confirm = (label, payload, supported = true) => {
    const button = element('button', label, 'primary'); button.type = 'submit'; button.dataset.nativeAction = 'accept'; button.disabled = !supported || !allowed(request, 'accept');
    form.addEventListener('submit', (event) => { event.preventDefault(); if (supported) void run('accept', payload, button); }); form.append(button);
  };
  if (request.kind === 'command' || request.kind === 'file') {
    if (request.cwd) card.append(element('p', `工作目录：${request.cwd}`));
    if (request.networkApprovalContext) card.append(element('p', `网络访问：${request.networkApprovalContext.host} · ${request.networkApprovalContext.protocol}`));
    if (request.grantRoot) card.append(element('p', `申请写入范围：${request.grantRoot}${request.grantRootHonored === 'unverified' ? '（原生会话申请了会话范围，具体生效范围尚未验证）' : ''}`));
    for (const change of request.changes ?? []) {
      const details = element('details', '', 'tool-output'); details.append(element('summary', `${change.kind} · ${change.path}`));
      if (change.movePath) details.append(element('p', `移动到：${change.movePath}`)); if (change.diff) details.append(element('pre', change.diff)); card.append(details);
    }
    action('不允许', 'decline', () => ({ kind: request.kind, requestId: request.requestId, decision: 'decline' }));
    if (request.acceptSupported !== false && allowed(request, 'accept')) confirm(request.grantRoot ? '允许申请的变更' : '允许这一次', () => ({ kind: request.kind, requestId: request.requestId, decision: 'accept' }));
    else card.append(element('p', '请在桌面查看完整详情后决定是否允许。'));
  } else if (request.kind === 'permissions') {
    const permissions = request.requestedPermissions ?? {};
    const summary = [];
    if (permissions.network?.enabled === true) summary.push('访问网络');
    for (const key of ['read', 'write']) if (permissions.fileSystem?.[key]?.length) summary.push(`${key === 'read' ? '读取' : '写入'}：${permissions.fileSystem[key].join('、')}`);
    for (const entry of permissions.fileSystem?.entries ?? []) summary.push(`${{ read: '读取', write: '写入', deny: '禁止' }[/** @type {'read'|'write'|'deny'} */ (entry.access)] ?? entry.access}：${permissionPath(entry.path)}`);
    if (permissions.fileSystem?.globScanMaxDepth != null) summary.push(`匹配扫描深度：${permissions.fileSystem.globScanMaxDepth}`);
    card.append(element('p', summary.join('\n')));
    action('不授予', 'decline', () => ({ kind: request.kind, requestId: request.requestId, response: { permissions: {}, scope: 'turn' } }));
    confirm('仅允许当前这轮', () => ({ kind: request.kind, requestId: request.requestId, response: { permissions, scope: 'turn' } }));
  } else if (request.kind === 'user-input') {
    /** @type {Array<[string,()=>string]>} */ const answers = [];
    for (const question of request.questions ?? []) {
      const entry = questionField(question.question ?? question.header ?? '回答', question.options ?? [], question.secret);
      answers.push([question.id, entry.value]); form.append(entry.node);
    }
    confirm('提交回答', () => {
      const data = Object.fromEntries(answers.map(([id, value]) => [id, { answers: [value()] }]));
      if (!answers.length || Object.values(data).some((answer) => !answer.answers[0])) throw Error('请回答每个问题。');
      return { kind: request.kind, requestId: request.requestId, response: { answers: data } };
    });
  } else if (request.kind === 'elicitation') {
    /** @type {ReturnType<typeof createSchemaForm>|null} */ let fields = null; let canConfirm = request.acceptSupported === true;
    if (request.mode === 'url') {
      try {
        const url = new URL(request.url); if (!['http:', 'https:'].includes(url.protocol)) throw Error('unsupported-url');
        const link = element('a', '打开验证页面'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; form.append(link);
      } catch { canConfirm = false; form.append(element('p', '验证链接无效，请在桌面继续。')); }
    } else if (canConfirm) {
      try { fields = createSchemaForm(request.requestedSchema); form.append(fields.node); }
      catch (error) { canConfirm = false; form.append(element('p', error instanceof Error ? error.message : '请在桌面填写这个表单。')); }
    } else form.append(element('p', request.unsupportedReason === 'native-verification-required' ? '这一步需要在桌面完成系统验证。' : '请在桌面继续这个表单。'));
    if (allowed(request, 'decline')) action('不填写', 'decline', () => ({ kind: request.kind, requestId: request.requestId, response: { action: 'decline' } }));
    action('取消', 'cancel', () => ({ kind: request.kind, requestId: request.requestId, response: { action: 'cancel' } }));
    if (canConfirm && allowed(request, 'accept')) confirm('确认', () => ({ kind: request.kind, requestId: request.requestId, response: fields ? { action: 'accept', content: fields.value() } : { action: 'accept' } }));
  } else card.append(element('p', '这个步骤暂时需要在桌面完成。'));
  form.append(actions, status); card.append(form); container.append(card);
}

/** @param {string} title @param {Array<string|Value>} options @param {boolean} [secret] @param {boolean} [preselect] */
function questionField(title, options, secret = false, preselect = false) {
  const group = element('fieldset'); group.append(element('legend', title));
  let choice = null;
  if (options.length) {
    choice = document.createElement('select'); choice.append(option('请选择', ''));
    for (const entry of options) {
      const label = typeof entry === 'string' ? entry : entry.label; choice.append(option(label, label));
      if (typeof entry !== 'string' && entry.description) group.append(element('small', `${label}：${entry.description}`));
    }
    if (preselect) choice.value = typeof options[0] === 'string' ? options[0] : options[0].label;
    group.append(choice);
  }
  const input = document.createElement('input'); input.type = secret ? 'password' : 'text'; input.placeholder = choice ? '或输入其他回答' : '输入回答'; input.setAttribute('aria-label', `${title} 自由回答`); group.append(input);
  return { node: group, value: () => input.value.trim() || choice?.value || '' };
}

/** @param {HTMLElement} container @param {Value} question @param {(action:string,payload:Value)=>Promise<boolean>} onCommand */
function renderAsyncQuestion(container, question, onCommand) {
  const card = element('section', '', 'request-card'); card.append(element('h2', '原会话向你提问'));
  const form = document.createElement('form'); const field = questionField(question.title, question.options ?? [], false, true); form.append(field.node);
  const status = element('p', '', 'error'); status.setAttribute('role', 'alert'); const submit = element('button', '回复原会话', 'primary'); submit.type = 'submit'; form.append(submit, status); let busy = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || question.answered) return; const answer = field.value(); if (!answer) { status.textContent = '请输入或选择回答。'; return; }
    busy = true; submit.disabled = true;
    try { const ok = await onCommand('answer-question', { questionItemId: question.questionItemId, answer }); status.textContent = ok ? '已提交到原会话。' : '未确认成功，请查看提示。'; }
    catch (error) { status.textContent = error instanceof Error ? error.message : '回复未完成，请重试。'; }
    finally { busy = false; submit.disabled = false; }
  }); card.append(form); container.append(card);
}

/** @param {Value} path */
export function permissionPath(path) {
  if (path?.type === 'path') return path.path;
  if (path?.type === 'glob_pattern') return `匹配 ${path.pattern}`;
  if (path?.type !== 'special') return '无法识别的文件范围';
  const value = path.value ?? {}; const names = { root: '整个文件系统', minimal: '最小系统范围', project_roots: '项目根目录', tmpdir: '系统临时目录', slash_tmp: '/tmp', unknown: `原生范围 ${value.path ?? '未知'}` };
  return `${names[/** @type {keyof typeof names} */ (value.kind)] ?? '未知原生范围'}${value.subpath ? ` / ${value.subpath}` : ''}`;
}
