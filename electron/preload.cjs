const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moonbounce', {
  cast: {
    list: () => ipcRenderer.invoke('cast:list'),
    rescan: () => ipcRenderer.invoke('cast:rescan'),
    connect: (payload) => ipcRenderer.invoke('cast:connect', payload),
    play: (payload) => ipcRenderer.invoke('cast:play', payload),
    control: (action, value) => ipcRenderer.invoke('cast:control', action, value),
    disconnect: () => ipcRenderer.invoke('cast:disconnect'),
    status: () => ipcRenderer.invoke('cast:status'),
    onDevices: (callback) => {
      const listener = (_event, devices) => callback(devices);
      ipcRenderer.on('cast:devices', listener);
      return () => ipcRenderer.removeListener('cast:devices', listener);
    },
  },
  systemVolume: {
    get: () => ipcRenderer.invoke('system-volume:get'),
    set: (value) => ipcRenderer.invoke('system-volume:set', value),
  },
  plexAuth: {
    createPin: () => ipcRenderer.invoke('plex-auth:create-pin'),
    pollPin: (id) => ipcRenderer.invoke('plex-auth:poll-pin', id),
    resources: (token) => ipcRenderer.invoke('plex-auth:resources', token),
  },
  log: {
    write: (event, payload) => ipcRenderer.invoke('log:write', event, payload),
    path: () => ipcRenderer.invoke('log:path'),
  },
});
