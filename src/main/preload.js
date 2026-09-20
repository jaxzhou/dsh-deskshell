'use strict';

/**
 * The renderer runs sandboxed with context isolation: this bridge is the only
 * surface it gets, and every entry is an explicit, argument-checked call.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Subscribe to a main→renderer channel; returns the unsubscribe function. */
function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('dshShell', {
  /** Current snapshot: phase, detection, install progress, server, logs. */
  getState: () => ipcRenderer.invoke('dsh:get-state'),
  /** Re-run detection; starts dsh when it is installed. */
  check: () => ipcRenderer.invoke('dsh:check'),
  /** Re-run detection without starting anything. */
  detect: () => ipcRenderer.invoke('dsh:detect'),
  /** `npm install -g @deepseek-ai/dsh`; progress arrives through onState. */
  install: () => ipcRenderer.invoke('dsh:install'),
  /** Cancel an in-flight install. */
  cancelInstall: () => ipcRenderer.invoke('dsh:cancel-install'),
  /** Download and configure a private Node.js runtime (no admin rights). */
  installNode: () => ipcRenderer.invoke('dsh:install-node'),
  /** Cancel an in-flight runtime download. */
  cancelNodeInstall: () => ipcRenderer.invoke('dsh:cancel-node-install'),
  /** Start `dsh web` and load the resulting GUI. */
  start: () => ipcRenderer.invoke('dsh:start'),
  /** Stop the `dsh web` child. */
  stop: () => ipcRenderer.invoke('dsh:stop'),
  /** Stop then start again. */
  restart: () => ipcRenderer.invoke('dsh:restart'),
  /** Retry whatever failed: install dsh, or start it again. */
  retry: () => ipcRenderer.invoke('dsh:retry'),
  /** Reload the embedded DSH GUI. */
  reloadGui: () => ipcRenderer.invoke('dsh:reload-gui'),
  /** Show/hide the embedded GUI (hidden = read the shell's log panel). */
  setGuiVisible: (visible) => ipcRenderer.invoke('dsh:set-gui-visible', visible),
  /** Switch the shell's top tab: 'dsh' (embedded Web) or 'market'. */
  setActiveTab: (tab) => ipcRenderer.invoke('dsh:set-active-tab', tab),

  /** Plugin market: catalog merged with the installed state. */
  loadMarket: () => ipcRenderer.invoke('market:load'),
  /** Plugin market: what the dsh profile has installed right now. */
  installedPlugins: () => ipcRenderer.invoke('market:installed'),
  /** Install or update one plugin (progress via onState/onLog). */
  installPlugin: (payload) => ipcRenderer.invoke('market:install', payload),
  /** Cancel an in-flight plugin install/update. */
  cancelPlugin: () => ipcRenderer.invoke('market:cancel'),
  /** Open a URL (or the current GUI URL) in the system browser. */
  openExternal: (url) => ipcRenderer.invoke('dsh:open-external', url),
  /** Tell main where the shell's own toolbar ends, so the GUI view sits below it. */
  setViewInset: (inset) => ipcRenderer.invoke('dsh:set-view-inset', inset),
  /** Quit the desktop shell (and its dsh child). */
  quit: () => ipcRenderer.invoke('dsh:quit'),
  onState: (listener) => subscribe('dsh:state', listener),
  onLog: (listener) => subscribe('dsh:log', listener),
});
