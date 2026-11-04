'use strict';

const $ = (id) => document.getElementById(id);
const api = window.spider;
let view = null;
let busy = false;
let uninstallInfo = null;
let countdownTimer = null;

function setBusy(active, message) {
  busy = active;
  $('busy-bar').classList.toggle('visible', active);
  if (message) $('busy-bar').textContent = message;
  document.querySelectorAll('button').forEach((button) => { button.disabled = active; });
  if (!active) renderSession();
}

function errorText(error) {
  return error && error.message ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
}

async function run(action, message) {
  if (busy) return null;
  setBusy(true, message || 'Spider 正在处理，请稍候…');
  try {
    return await action();
  } finally {
    setBusy(false);
  }
}

function applyView(next) {
  view = next;
  renderSummary();
  renderTodos();
  renderSession();
  $('document-directory').textContent = view.documentDirectory || '尚未设置';
}

function renderSummary() {
  if (!view) return;
  $('summary-minutes').textContent = view.summary.focusMinutes || 0;
  $('summary-sessions').textContent = view.summary.focusSessions || 0;
  $('summary-tasks').textContent = view.summary.completedTasks || 0;
}

function renderTodos() {
  if (!view) return;
  const selected = $('focus-todo').value;
  const todos = Array.isArray(view.todos) ? view.todos : [];
  const unfinished = todos.filter((todo) => !todo.done);
  $('focus-todo').replaceChildren(new Option('不关联待办', ''));
  unfinished.forEach((todo) => $('focus-todo').add(new Option(todo.text, String(todo.id))));
  if (unfinished.some((todo) => String(todo.id) === selected)) $('focus-todo').value = selected;

  $('todo-count').textContent = `${unfinished.length} 项未完成`;
  const list = $('todo-list');
  list.replaceChildren();
  if (!todos.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有待办，先写下一件小事吧';
    list.appendChild(empty);
    return;
  }
  todos.slice().reverse().forEach((todo) => {
    const row = document.createElement('div');
    row.className = `todo${todo.done ? ' done' : ''}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(todo.done);
    checkbox.setAttribute('aria-label', todo.done ? '恢复待办' : '完成待办');
    checkbox.addEventListener('change', async () => {
      try {
        const result = await run(() => api.buddyToggleTodo(todo.id), '正在更新待办…');
        if (result) applyView(result);
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        window.alert(errorText(error));
      }
    });
    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = todo.text;
    const remove = document.createElement('button');
    remove.className = 'icon-btn';
    remove.textContent = '×';
    remove.title = '删除这条待办';
    remove.setAttribute('aria-label', `删除待办：${todo.text}`);
    remove.addEventListener('click', async () => {
      try {
        const result = await run(() => api.buddyDeleteTodo(todo.id), '正在删除待办…');
        if (result) applyView(result);
      } catch (error) { window.alert(errorText(error)); }
    });
    row.append(checkbox, text, remove);
    list.appendChild(row);
  });
}

function remainingMs() {
  if (!view || !view.state.current) return Number($('focus-minutes').value) * 60000;
  const current = view.state.current;
  if (view.state.status === 'running' && current.endAt) {
    return Math.max(0, Date.parse(current.endAt) - Date.now());
  }
  return Math.max(0, Number(current.remainingMs) || 0);
}

function updateCountdown() {
  if (!view) return;
  const ms = remainingMs();
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  $('timer').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function renderSession() {
  if (!view) return;
  const { state } = view;
  const active = state.status === 'running' || state.status === 'paused';
  const focus = state.mode !== 'break';
  $('session-label').textContent = {
    idle: '准备好开始了吗？', running: focus ? '正在专注 · Spider 陪你工作' : '正在休息 · 放松一下',
    paused: '已暂停 · 时间已保留', completed: focus ? '本轮专注完成，做得好！' : '休息结束，欢迎回来',
  }[state.status] || '准备好开始了吗？';

  const linked = state.current && state.current.todoId !== null && view.todos
    ? view.todos.find((todo) => String(todo.id) === String(state.current.todoId)) : null;
  $('linked-task').textContent = active || state.status === 'completed'
    ? (linked ? `当前目标：${linked.text}` : (focus ? '这一轮没有关联待办' : '短休息不能代替睡眠，记得让 Spider 好好睡觉'))
    : '选择一项待办，给这段时间一个目标';

  $('start-focus').hidden = active;
  $('start-break').hidden = active;
  $('pause-focus').hidden = !(state.status === 'running');
  $('resume-focus').hidden = !(state.status === 'paused');
  $('stop-session').hidden = !active;
  $('focus-minutes').disabled = busy || active;
  $('focus-todo').disabled = busy || active;
  $('start-break').textContent = focus ? '休息 5 分钟' : '开始 25 分钟专注';
  updateCountdown();
}

async function refresh() {
  try { applyView(await api.buddyGet()); }
  catch (error) { $('session-label').textContent = errorText(error); }
}

async function addTodo() {
  const input = $('new-todo');
  const text = input.value.trim();
  if (!text) return;
  try {
    const result = await run(() => api.buddyAddTodo(text), '正在添加待办…');
    if (result) { input.value = ''; applyView(result); }
  } catch (error) { window.alert(errorText(error)); }
}

async function loadUninstallInfo() {
  if (uninstallInfo) return;
  $('app-root').textContent = '正在核对应用目录…';
  try {
    uninstallInfo = await api.uninstallInfo();
    $('app-root').textContent = uninstallInfo.root;
    $('uninstall-phrase').placeholder = uninstallInfo.confirmPhrase;
  } catch (error) {
    $('app-root').textContent = `无法核对目录，移除功能已停用：${errorText(error)}`;
    $('uninstall-button').disabled = true;
  }
}

document.querySelectorAll('nav button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${button.dataset.tab}`));
    if (button.dataset.tab === 'settings') loadUninstallInfo();
  });
});

$('focus-minutes').addEventListener('change', () => {
  if (view && view.state.status === 'idle') updateCountdown();
});
$('start-focus').addEventListener('click', async () => {
  const minutes = Number($('focus-minutes').value);
  const todoId = $('focus-todo').value || null;
  try {
    const result = await run(() => api.buddyStartFocus(minutes, todoId), '正在开始专注…');
    if (result) applyView(result);
  } catch (error) { window.alert(errorText(error)); }
});
$('pause-focus').addEventListener('click', async () => {
  try { applyView(await run(() => api.buddyPause(), '正在暂停…')); }
  catch (error) { window.alert(errorText(error)); }
});
$('resume-focus').addEventListener('click', async () => {
  try { applyView(await run(() => api.buddyResume(), '正在继续…')); }
  catch (error) { window.alert(errorText(error)); }
});
$('stop-session').addEventListener('click', async () => {
  try { applyView(await run(() => api.buddyStop(), '正在结束本轮…')); }
  catch (error) { window.alert(errorText(error)); }
});
$('start-break').addEventListener('click', async () => {
  try {
    const startingFocus = view && view.state.mode === 'break';
    const result = await run(() => startingFocus ? api.buddyStartFocus(25, null) : api.buddyStartBreak(5), '正在开始计时…');
    if (result) applyView(result);
  } catch (error) { window.alert(errorText(error)); }
});
$('add-todo').addEventListener('click', addTodo);
$('new-todo').addEventListener('keydown', (event) => { if (event.key === 'Enter') addTodo(); });

$('choose-directory').addEventListener('click', async () => {
  try {
    const result = await run(() => api.chooseDocumentDirectory(), '正在选择目录…');
    if (result && !result.canceled) $('document-directory').textContent = result.directory;
  } catch (error) { $('document-result').textContent = errorText(error); $('document-result').className = 'notice error'; }
});
$('open-directory').addEventListener('click', async () => {
  try { await run(() => api.openDocumentDirectory(), '正在打开文档目录…'); }
  catch (error) { $('document-result').textContent = errorText(error); $('document-result').className = 'notice error'; }
});
$('create-document').addEventListener('click', async () => {
  const topic = $('document-topic').value.trim();
  if (topic.length < 4) {
    $('document-result').textContent = '请再具体描述一下文档主题和要求。';
    $('document-result').className = 'notice error';
    return;
  }
  $('document-result').textContent = 'Spider 正在规划、撰写并调用文档工具。工作期间会消耗少量精力，请稍候…';
  $('document-result').className = 'notice';
  try {
    const result = await run(() => api.buddyCreateDocument(topic, $('document-format').value), '正在撰写文档，请勿重复提交…');
    $('document-result').textContent = result && result.ok ? result.reply : (result && result.error) || '文档创建失败';
    $('document-result').className = result && result.ok ? 'notice' : 'notice error';
  } catch (error) {
    $('document-result').textContent = errorText(error);
    $('document-result').className = 'notice error';
  }
});

$('uninstall-button').addEventListener('click', async () => {
  const phrase = $('uninstall-phrase').value;
  if (!uninstallInfo || phrase !== uninstallInfo.confirmPhrase) {
    $('uninstall-result').textContent = `请输入完整确认短语：${uninstallInfo ? uninstallInfo.confirmPhrase : '删除喵伴'}`;
    $('uninstall-result').className = 'notice error';
    return;
  }
  $('uninstall-result').textContent = '接下来由你选择备份位置；备份后还有原生最终确认，当前尚未移除任何文件。';
  $('uninstall-result').className = 'notice';
  try {
    const result = await run(() => api.requestUninstall(phrase), '等待备份位置与原生最终确认…');
    if (result && result.ok) {
      $('uninstall-result').textContent = `已启动回收站辅助流程，Spider 即将退出。备份：${result.backupPath}`;
    } else if (result && result.canceled) {
      $('uninstall-result').textContent = result.backupPath
        ? `已取消移除，Spider 仍在原位置。数据备份已保留：${result.backupPath}`
        : '已取消，没有移除任何文件。';
    }
  } catch (error) {
    $('uninstall-result').textContent = errorText(error);
    $('uninstall-result').className = 'notice error';
  } finally {
    $('uninstall-phrase').value = '';
  }
});

api.onBuddyState((next) => { if (!busy) applyView(next); else view = next; });
countdownTimer = setInterval(updateCountdown, 250);
window.addEventListener('beforeunload', () => clearInterval(countdownTimer));
refresh();
