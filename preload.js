/*
 * Bruecke zwischen Main- und Renderer-Prozess.
 * Der Renderer bekommt bewusst nur diese schmale, geprueft Oberflaeche.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  isElectron: true,
  getConfig: () => ipcRenderer.invoke('app:config'),
  getSettings: () => ipcRenderer.invoke('app:settings'),
  saveSettings: (patch) => ipcRenderer.invoke('app:save-settings', patch),
  refresh: (reason) => ipcRenderer.invoke('flight:refresh', reason),
  getLast: () => ipcRenderer.invoke('flight:last'),
  onUpdate: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('flight:update', listener);
    return () => ipcRenderer.removeListener('flight:update', listener);
  },
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  toggleAlwaysOnTop: () => ipcRenderer.send('window:toggle-always-on-top'),
  onAlwaysOnTopChanged: (callback) => {
    const listener = (_evt, value) => callback(value);
    ipcRenderer.on('window:always-on-top-changed', listener);
    return () => ipcRenderer.removeListener('window:always-on-top-changed', listener);
  },
  setOpacity: (value) => ipcRenderer.send('window:set-opacity', value),
  setSize: (size) => ipcRenderer.send('window:set-size', size)
});
