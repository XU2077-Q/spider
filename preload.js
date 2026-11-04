const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spider', {
  version: '0.2.0',
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  hoverCat: (hovered) => ipcRenderer.send('pet-hit-test', hovered),
  openChat: () => ipcRenderer.send('open-chat'),
  openBuddy: () => ipcRenderer.send('open-buddy'),
  chat: (msg, history) => ipcRenderer.invoke('agent-chat', { msg, history }),
  // Work Buddy 与文档创作
  buddyGet: () => ipcRenderer.invoke('buddy-get'),
  buddyStartFocus: (minutes, todoId) => ipcRenderer.invoke('buddy-start-focus', { minutes, todoId }),
  buddyPause: () => ipcRenderer.invoke('buddy-pause'),
  buddyResume: () => ipcRenderer.invoke('buddy-resume'),
  buddyStop: () => ipcRenderer.invoke('buddy-stop'),
  buddyStartBreak: (minutes) => ipcRenderer.invoke('buddy-start-break', { minutes }),
  buddyAddTodo: (text) => ipcRenderer.invoke('buddy-add-todo', { text }),
  buddyToggleTodo: (id) => ipcRenderer.invoke('buddy-toggle-todo', { id }),
  buddyDeleteTodo: (id) => ipcRenderer.invoke('buddy-delete-todo', { id }),
  buddyCreateDocument: (topic, format) => ipcRenderer.invoke('buddy-create-document', { topic, format }),
  chooseDocumentDirectory: () => ipcRenderer.invoke('document-choose-directory'),
  openDocumentDirectory: () => ipcRenderer.invoke('document-open-directory'),
  onBuddyState: (cb) => ipcRenderer.on('buddy-state', (event, state) => cb(state)),
  // 安全移除：主进程仍会要求备份和原生最终确认
  uninstallInfo: () => ipcRenderer.invoke('uninstall-info'),
  requestUninstall: (phrase) => ipcRenderer.invoke('uninstall-request', { phrase }),
  // 日记
  openDiary: () => ipcRenderer.send('open-diary'),
  listDiary: () => ipcRenderer.invoke('diary-list'),
  readDiary: (date) => ipcRenderer.invoke('diary-read', date),
  // 生理状态
  getVitals: () => ipcRenderer.invoke('vitals-get'),
  feed: () => ipcRenderer.invoke('vitals-feed'),
  pet: () => ipcRenderer.invoke('vitals-pet'),
  play: () => ipcRenderer.invoke('vitals-play'),
  wake: () => ipcRenderer.invoke('vitals-wake'),
  // 行为动画信号
  onAnim: (cb) => ipcRenderer.on('pet-anim', (e, type) => cb(type)),
  onGaze: (cb) => ipcRenderer.on('pet-gaze', (e, direction) => cb(direction)),
  // 说话气泡
  onSpeak: (cb) => ipcRenderer.on('pet-speak', (e, text) => cb(text)),
  // 调试：演示主动触发
  debugFire: (type) => ipcRenderer.invoke('debug-fire', type),
});
