const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bubbleApi', {
  on: (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload)),
  getState: () => ipcRenderer.invoke('get-state'),
  getScale: () => ipcRenderer.invoke('get-scale'),
  getFlip: () => ipcRenderer.invoke('get-flip'),
  getCurrency: () => ipcRenderer.invoke('get-currency'),
  setCurrency: (c) => ipcRenderer.send('set-currency', c),
  setRate: (r) => ipcRenderer.send('set-rate', r),
  getToastSec: () => ipcRenderer.invoke('get-toast-sec'),
  refresh: () => ipcRenderer.send('refresh'),
  getMask: () => ipcRenderer.invoke('get-mask'),
  dragStart: (p) => ipcRenderer.send('drag-start', p),
  dragMove: (p) => ipcRenderer.send('drag-move', p),
  dragEnd: () => ipcRenderer.send('drag-end'),
  hit: (on) => ipcRenderer.send('hit', on),
  click: () => ipcRenderer.send('click'),
  cycle: () => ipcRenderer.send('cycle'),
  menu: () => ipcRenderer.send('menu'),
  popupHeight: (h) => ipcRenderer.send('popup-height', h),
  popupHide: () => ipcRenderer.send('popup-hide'),
})
