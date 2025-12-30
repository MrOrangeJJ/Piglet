import { IpcMain, BrowserWindow, shell } from 'electron';
import { DualAgentService, TaskStartPayload } from './agent/dualAgent';
import { store, AppConfig } from './store';
import { getRulesJsonPath, loadRulesFromFile, saveRulesToFile } from './rulesFile';

export function setupIpcHandlers(ipcMain: IpcMain, agentService: DualAgentService) {
  // Load settings
  ipcMain.handle('get-settings', () => {
    // Rules are stored in a dedicated rules.json (NOT in electron-store).
    const cfg = store.store as any;
    const rules = loadRulesFromFile();
    return { ...cfg, rules };
  });

  // Save settings
  ipcMain.on('save-settings', (event, settings: AppConfig) => {
    // Persist non-rule settings in electron-store; persist rules in rules.json
    const { rules, ...rest } = (settings as any) || {};
    store.store = { ...(rest as any), rules: [] } as any;
    try {
      saveRulesToFile(rules ?? []);
    } catch (e) {
      console.error("[rules.json] save failed", e);
    }
  });

  ipcMain.handle('open-rules-json', async () => {
    const p = getRulesJsonPath();
    // Ensure file exists so editor can open it.
    try {
      loadRulesFromFile();
    } catch {
      // ignore
    }
    // Open with system default editor (Finder default for .json)
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return { path: p };
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
