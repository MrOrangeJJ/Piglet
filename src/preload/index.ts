import { contextBridge, ipcRenderer } from 'electron'

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    send: (channel: string, data: any) => {
      // whitelist channels
      let validChannels = ['start-task', 'stop-task']
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data)
      }
    },
    on: (channel: string, func: (...args: any[]) => void) => {
      let validChannels = [
        'agent-thought',
        'agent-action-plan',
        'agent-tool',
        'agent-response',
        'agent-image',
        'task-finished',
        'draw-highlight',
        'task-error'
      ]
      if (validChannels.includes(channel)) {
        // Deliberately strip event as it includes `sender` 
        ipcRenderer.on(channel, (event, ...args) => func(...args))
      }
    },
    removeAllListeners: (channel: string) => {
        ipcRenderer.removeAllListeners(channel);
    }
  }
})



