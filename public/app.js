import { renderRequests } from './requests.js';
import { WindowMirror } from './window.js';
const $ = (id) => document.getElementById(id);
const initialParams = new URLSearchParams(location.search);
let application = initialParams.get('app') === 'zcode' ? 'zcode' : 'codex';
let sessions = [];
let selected = null;
let instanceId = null;
let source = null;
let flight = 0;
let offset = 0;
let appStates = [];
let sending = false;
let historyRows = [];
let currentView = null;
const renderedRows = new Map();
let requestSignature = '';
let pendingOperation = null;
const draftKey = (session) => `bridge_draft:${session.app}:${session.id}`;
const pendingKey = (session) => `bridge_pending:${session.app}:${session.id}`;
const saveDraft = () => { if (selected) sessionStorage.setItem(draftKey(selected), $('prompt').value); };
const windowMirror = new WindowMirror($('window-mirror'), command);

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (response.status === 401) { showPair(); const error = Error(data.message); error.code = data.error; error.status = response.status; throw error; }
  if (!response.ok) { const error = Error(data.message || '连接失败，请重试。'); error.code = data.error; error.status = response.status; throw error; }
  return data;
}

function showPair() { $('pair').hidden = false; $('workspace').hidden = true; source?.close(); }
function showWorkspace() { $('pair').hidden = true; $('workspace').hidden = false; }
function addressQuery() { return `app=${encodeURIComponent(selected.app)}&id=${encodeURIComponent(selected.id)}`; }

async function refresh() {
  try {
    const data = await api('/api/status');
    instanceId = data.instanceId;
    appStates = data.apps;
    showWorkspace();
    updateStatus();
    await loadSessions(true);
    const restore = initialParams.get('session');
    const session = sessions.find((item) => item.id === restore && item.app === application);
    if (!selected && session) await openSession(session);
  } catch (error) { $('list-error').textContent = error.message; }
}

function updateStatus() {
  const status = appStates.find((item) => item.app === application);
  const reasons = { 'zcode-not-running': '请在电脑打开 ZCode', 'screen-locked': '请在电脑解锁 Mac', 'screen_locked': '请在电脑解锁 Mac', 'screen-capture-required': '请在电脑允许窗口录制', 'window-ui-unavailable': '窗口暂不可见，请显示 ZCode', 'gui-session-unavailable': '暂无法读取桌面界面' };
  $('connection').textContent = status?.connected ? status.mode === 'fixture' ? '专用界面验证样本' : (application === 'zcode' ? '已连接 ZCode 桌面窗口' : '已连接原桌面应用') : reasons[status?.reason] || '控制尚未连接，请检查桌面应用';
  $('connection-dot').classList.toggle('online', !!status?.connected);
  document.querySelectorAll('[data-app]').forEach((button) => button.classList.toggle('selected', button.dataset.app === application));
  $('send').disabled = !selected || !status?.connected || sending || !!pendingOperation;
  $('stop').disabled = !selected || !status?.connected || sending || !currentView?.currentTurnId;
  $('delivery').hidden = selected?.app === 'zcode';
  $('delivery').querySelector('[value=steer]').disabled = !currentView?.currentTurnId;
  if (!currentView?.currentTurnId) $('delivery').value = 'send';
  $('launch-zcode').hidden = application !== 'zcode' || status?.running !== false;
  $('show-zcode').hidden = application !== 'zcode' || !status?.running || status?.screenLocked === true;
}

async function loadSessions(reset = false) {
  const version = ++flight;
  $('list-error').textContent = '';
  if (reset) { offset = 0; sessions = []; }
  try {
    const data = await api(`/api/sessions?app=${application}&offset=${offset}`);
    if (version !== flight) return;
    sessions.push(...data.sessions);
    offset = sessions.length;
    $('more').hidden = data.sessions.length < 100;
    drawSessions();
  } catch (error) { if (version === flight) $('list-error').textContent = error.message; }
}

function drawSessions() {
  $('session-list').replaceChildren();
  const query = $('search').value.trim().toLowerCase();
  for (const session of sessions.filter((item) => `${item.title} ${item.workspace}`.toLowerCase().includes(query))) {
    const row = document.createElement('button'); row.className = 'session-row';
    row.dataset.sessionId = session.id;
    row.classList.toggle('selected', session.id === selected?.id && session.app === selected?.app);
    const title = document.createElement('strong'); title.textContent = session.title || '未命名会话';
    const metadata = document.createElement('small');
    const folder = document.createElement('span'); folder.className = 'folder'; folder.textContent = session.workspace?.split(/[\\/]/).filter(Boolean).at(-1) || '';
    const date = document.createElement('span'); date.textContent = new Date(session.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    metadata.append(folder, date); row.append(title, metadata);
    row.addEventListener('click', () => { void openSession(session); });
    $('session-list').append(row);
  }
  if (!sessions.length) { const empty = document.createElement('p'); empty.textContent = application === 'zcode' ? 'ZCode 窗口暂不可用。请在电脑打开应用并解锁屏幕。' : '这里还没有会话。请先在桌面应用中创建一个。'; empty.className = 'source-status'; $('session-list').append(empty); }
}

async function openSession(session) {
  saveDraft();
  selected = session; source?.close(); source = null; $('messages').replaceChildren(); currentView = null; historyRows = [];
  renderedRows.clear();
  requestSignature = ''; $('requests').replaceChildren();
  windowMirror.reset(); windowMirror.selectWindow(session);
  $('window-mirror').hidden = session.kind !== 'window'; $('messages').hidden = session.kind === 'window';
  try { pendingOperation = JSON.parse(sessionStorage.getItem(pendingKey(session)) || 'null'); } catch { pendingOperation = null; }
  $('prompt').value = sessionStorage.getItem(draftKey(session)) || pendingOperation?.text || '';
  $('check-receipt').hidden = !pendingOperation;
  history.replaceState({ app: session.app, session: session.id }, '', `/?app=${encodeURIComponent(session.app)}&session=${encodeURIComponent(session.id)}`);
  $('workspace').classList.add('chat-open'); $('back').hidden = false; $('empty').hidden = true; $('chat').hidden = false;
  $('session-title').textContent = session.title || '未命名会话'; $('session-workspace').textContent = session.workspace || '';
  $('live-status').textContent = '读取中'; $('action-error').textContent = ''; $('native-details').hidden = true;
  drawSessions(); updateStatus();
  const id = session.id; const app = session.app;
  try {
    const data = await api(`/api/snapshot?${addressQuery()}`);
    if (selected?.id !== id || selected?.app !== app) return;
    if (data.persisted) drawHistory(data.persisted);
    $('live-status').textContent = data.live ? '已同步桌面状态' : '已落盘记录';
    if (data.native) drawNative(data.native);
    if (pendingOperation) void checkReceipt();
    source = new EventSource(`/api/events?${addressQuery()}`);
    source.addEventListener('native', (event) => {
      if (selected?.id !== id || selected?.app !== app) return;
      const view = JSON.parse(event.data).frame; drawNative(view);
      $('live-status').textContent = view.status === 'unavailable' || view.status === 'disconnected' ? '窗口暂不可用' : view.requests?.length ? '等待你确认' : view.currentTurnId ? '正在运行 · 实时同步' : view.kind === 'window' ? '窗口实时共享' : '会话已同步';
    });
    source.addEventListener('unavailable', () => { $('live-status').textContent = '实时连接不可用'; });
    source.onerror = () => { $('live-status').textContent = '正在恢复连接…'; };
    source.onopen = () => {
      $('live-status').textContent = '已连接，等待桌面状态';
      void api('/api/status').then((status) => { instanceId = status.instanceId; appStates = status.apps; updateStatus(); }).catch(() => {});
    };
  } catch (error) { $('action-error').textContent = error.message; }
}

function appendMessage(role, text, tools = [], id = null) {
  if (!text && !tools.length) return null;
  if (role === 'reasoning') return null;
  const row = document.createElement('article'); row.className = `message ${role === 'user' ? 'user' : 'assistant'}`;
  if (id) row.dataset.messageId = id;
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'user' ? '你' : role === 'reasoning' ? '思考' : role === 'tool' ? '工具' : selected.app === 'codex' ? 'Codex' : 'ZCode';
  const body = document.createElement('div'); body.className = 'message-body'; body.textContent = text;
  row.append(label, body);
  for (const tool of tools) {
    const details = document.createElement('details'); details.className = 'tool-output';
    const summary = document.createElement('summary'); summary.textContent = tool.name || '工具调用';
    const pre = document.createElement('pre'); pre.textContent = typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output ?? tool.data ?? tool, null, 2);
    details.append(summary, pre); row.append(details);
  }
  $('messages').append(row);
  return row;
}

function drawHistory(history) {
  historyRows = [];
  if (history.messages) {
    for (const message of history.messages) {
      const parts = message.parts.map((part) => part.data);
      const text = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
      const tools = parts.filter((part) => part.type === 'tool').map((part) => ({ name: part.tool, output: part.state?.output ?? part.state?.input }));
      historyRows.push({ id: message.id, role: message.data.role || 'assistant', text, tools });
    }
  } else for (const item of history.items || []) {
    const value = item.data;
    if (value.type === 'message' || value.type === 'userMessage' || value.type === 'agentMessage') {
      const text = value.text || (value.content || []).map((content) => content.text || '').join('\n');
      historyRows.push({ id: item.id || value.id, role: value.role || (value.type === 'userMessage' ? 'user' : 'assistant'), text, tools: [] });
    } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'function_call', 'function_call_output'].includes(value.type)) historyRows.push({ id: item.id || value.id, role: 'tool', text: '', tools: [{ name: value.command || value.name || value.type, data: value }] });
  }
  drawRows();
}

function drawNative(frame) {
  currentView = frame;
  if (frame.kind === 'window') {
    $('messages').hidden = true; $('window-mirror').hidden = false; windowMirror.setView(frame);
    $('send').textContent = '填入桌面 ↗'; $('prompt').maxLength = 8000;
    $('delivery-note').textContent = '填入后点击窗口中的发送'; $('stop').hidden = true;
    return;
  }
  $('stop').hidden = false; $('send').textContent = '发送 ↗'; $('prompt').maxLength = 60000;
  $('chat').dataset.revision = String(frame.revision ?? '');
  $('native-details').hidden = true;
  drawRows();
  $('stop').disabled = !frame.currentTurnId || sending;
  $('delivery').querySelector('[value=steer]').disabled = !frame.currentTurnId;
  if (!frame.currentTurnId) $('delivery').value = 'send';
  $('delivery-note').textContent = frame.currentTurnId ? '发送到桌面，由原会话接收' : '发送到原桌面会话';
  const signature = JSON.stringify({ requests: frame.requests || [], questions: (frame.rows || []).filter((row) => row.asyncQuestions?.length).map((row) => ({ id: row.id, asyncQuestions: row.asyncQuestions })) });
  if (signature !== requestSignature) { requestSignature = signature; renderRequests($('requests'), frame.requests || [], command, frame.rows || []); }
}

function drawRows() {
  const area = $('messages');
  const bottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  const previousScroll = area.scrollTop;
  const rows = historyRows.map((row) => ({ ...row }));
  const index = new Map(rows.map((row, at) => [row.id, at]));
  for (const row of currentView?.rows || []) {
    if (row.id && index.has(row.id)) rows[index.get(row.id)] = row;
    else { if (row.id) index.set(row.id, rows.length); rows.push(row); }
  }
  const retained = new Set();
  let position = 0;
  for (const row of rows) {
    const key = row.id || `history_${position}`;
    const signature = JSON.stringify({ role: row.role, text: row.text, tools: row.tools || [] });
    let record = renderedRows.get(key);
    if (!record || record.signature !== signature) {
      const opened = record ? [...record.element.querySelectorAll('details')].map((detail) => detail.open) : [];
      record?.element.remove();
      const element = appendMessage(row.role, row.text, row.tools || [], key);
      if (!element) continue;
      [...element.querySelectorAll('details')].forEach((detail, at) => { detail.open = !!opened[at]; });
      record = { signature, element }; renderedRows.set(key, record);
    }
    retained.add(key);
    if (area.children[position] !== record.element) area.insertBefore(record.element, area.children[position] || null);
    position++;
  }
  for (const [key, record] of renderedRows) if (!retained.has(key)) { record.element.remove(); renderedRows.delete(key); }
  area.scrollTop = bottom ? area.scrollHeight : previousScroll;
}

async function command(action, payload) {
  if (sending || !selected) return false;
  if (pendingOperation) { $('action-error').textContent = '原操作结果尚未确认，请先检查回执。'; return false; }
  sending = true; updateStatus(); $('action-error').textContent = '';
  const target = { ...selected }; const address = addressQuery(); const id = crypto.randomUUID();
  let confirmedRejection = false;
  const pending = { commandId: id, instanceId, action, ...(['send', 'steer'].includes(action) ? { text: payload.text } : {}) };
  sessionStorage.setItem(pendingKey(target), JSON.stringify(pending));
  try {
    const result = await api(`/api/command?${address}`, { method: 'POST', body: JSON.stringify({ commandId: id, instanceId, action, payload }) });
    if (result.receipt.status !== 'complete') {
      confirmedRejection = result.receipt.status === 'failed';
      if (confirmedRejection) sessionStorage.removeItem(pendingKey(target));
      const reasons = { draft_conflict: '桌面输入框已有草稿，请先在窗口中处理，服务不会覆盖它。', 'draft-conflict': '桌面输入框已有草稿，请先在窗口中处理，服务不会覆盖它。', stale_view: '窗口内容已更新，请等待新画面后重试。', 'stale-window': '窗口已更新，请刷新画面后重试。', 'stale-runtime': '应用状态已变化，请重新打开窗口。', 'codex-request-rejected': '原桌面会话拒绝了这个操作，输入已保留。' };
      throw Error(result.receipt.status === 'unknown' ? '操作结果尚未确认，请先在桌面检查，避免重复发送。' : reasons[result.receipt.error] || '桌面未完成这个操作，输入已保留。');
    }
    sessionStorage.removeItem(pendingKey(target));
    if (['send', 'steer'].includes(action) && selected?.id === target.id && selected?.app === target.app) { $('prompt').value = ''; saveDraft(); }
    $('delivery-note').textContent = action === 'send' ? '桌面已接收' : action === 'type' ? '已填入桌面，请点击窗口中的发送' : '窗口操作已完成';
    return true;
  } catch (error) {
    if (error.status) { confirmedRejection = true; sessionStorage.removeItem(pendingKey(target)); }
    if (selected?.id === target.id && selected?.app === target.app) {
      pendingOperation = confirmedRejection ? null : pending; $('check-receipt').hidden = confirmedRejection; $('action-error').textContent = error.message;
    }
    return false;
  }
  finally { sending = false; updateStatus(); }
}

async function checkReceipt() {
  if (!selected || !pendingOperation) return;
  const pending = pendingOperation; const target = { ...selected };
  try {
    const result = await api(`/api/receipt?${addressQuery()}&commandId=${encodeURIComponent(pending.commandId)}`);
    if (selected?.id !== target.id || selected?.app !== target.app) return;
    if (result.receipt?.status === 'complete' || result.receipt?.status === 'failed') {
      pendingOperation = null; sessionStorage.removeItem(pendingKey(target)); $('check-receipt').hidden = true;
      if (result.receipt.status === 'complete') {
        if (['send', 'steer'].includes(pending.action) && $('prompt').value === pending.text) { $('prompt').value = ''; saveDraft(); }
        $('action-error').textContent = '桌面已确认原操作。';
      } else $('action-error').textContent = '桌面未完成原操作，输入已保留。';
      updateStatus();
    } else $('action-error').textContent = '原操作结果尚未确认，请在桌面核对；服务不会自动重发。';
  } catch (error) { $('action-error').textContent = error.message; }
}

$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('pair-error').textContent = '';
  try { await api('/api/pair', { method: 'POST', body: JSON.stringify({ code: $('pair-code').value.trim() }) }); await refresh(); }
  catch (error) { $('pair-error').textContent = error.message; }
});
document.querySelectorAll('[data-app]').forEach((button) => button.addEventListener('click', () => {
  source?.close(); selected = null; currentView = null;
  application = button.dataset.app; initialParams.delete('session');
  history.replaceState({}, '', `/?app=${encodeURIComponent(application)}`);
  $('workspace').classList.remove('chat-open'); $('back').hidden = true; $('chat').hidden = true; $('empty').hidden = false;
  updateStatus(); void loadSessions(true);
}));
$('search').addEventListener('input', drawSessions);
$('more').addEventListener('click', () => { void loadSessions(); });
$('refresh').addEventListener('click', () => { void refresh(); });
$('back').addEventListener('click', () => {
  $('workspace').classList.remove('chat-open'); $('back').hidden = true; source?.close(); selected = null; initialParams.delete('session');
  history.replaceState({}, '', `/?app=${encodeURIComponent(application)}`);
});
$('composer').addEventListener('submit', (event) => {
  event.preventDefault(); const text = $('prompt').value;
  if (!text.trim()) return;
  if (selected?.app === 'zcode') {
    const target = { ...selected };
    void windowMirror.fill(text).then((ok) => { if (ok && selected?.id === target.id && selected?.app === target.app) { $('prompt').value = ''; saveDraft(); } });
  }
  else void command($('delivery').value === 'steer' && currentView?.currentTurnId ? 'steer' : 'send', { text });
});
$('prompt').addEventListener('input', saveDraft);
$('check-receipt').addEventListener('click', () => { void checkReceipt(); });
$('stop').addEventListener('click', () => { if (currentView?.currentTurnId) void command('interrupt', { turnId: currentView.currentTurnId }); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (selected) void openSession(selected); else void refresh(); }
  else { saveDraft(); source?.close(); source = null; }
});
$('launch-zcode').addEventListener('click', async () => {
  selected = { app: 'zcode', id: 'app-window' };
  await command('launch', {}); selected = null; await refresh();
});
$('show-zcode').addEventListener('click', async () => {
  const status = appStates.find((item) => item.app === 'zcode');
  if (!status?.runtimeGeneration) return;
  saveDraft(); selected = { app: 'zcode', id: 'app-window' };
  await command('activate', { runtimeGeneration: status.runtimeGeneration }); selected = null; await refresh();
});
void refresh();
