import { IpcMain, BrowserWindow } from 'electron';
import { DualAgentService, TaskStartPayload } from './agent/dualAgent';
import { store, AppConfig } from './store';

export function setupIpcHandlers(ipcMain: IpcMain, agentService: DualAgentService) {
  // Load settings
  ipcMain.handle('get-settings', () => {
    return store.store;
  });

  // Save settings
  ipcMain.on('save-settings', (event, settings: AppConfig) => {
    store.store = settings;
  });

  ipcMain.on('start-task', async (event, payload: TaskStartPayload) => {
    await agentService.startTask(payload.instruction, payload.config);
  });

  ipcMain.on('stop-task', () => {
    agentService.stopTask();
  });

  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      try {
        win.setIgnoreMouseEvents(ignore, options);
      } catch (e) {
        // ignore
      }
  });
}
