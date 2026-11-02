const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('tiroir', {
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (data) => ipcRenderer.invoke('store:save', data),
  listShells: () => ipcRenderer.invoke('shells:list'),
  info: () => ipcRenderer.invoke('app:info'),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:folder', defaultPath),
  spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('pty:kill', id),
  onData: (fn) => ipcRenderer.on('pty:data', (_e, id, data) => fn(id, data)),
  onExit: (fn) => ipcRenderer.on('pty:exit', (_e, id, code) => fn(id, code)),
  copy: (text) => clipboard.writeText(text),
  paste: () => clipboard.readText(),
});
