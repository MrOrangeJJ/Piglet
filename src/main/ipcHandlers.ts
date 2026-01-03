import { IpcMain, BrowserWindow, shell, dialog, app } from 'electron';
import { DualAgentService, TaskStartPayload } from './agent/dualAgent';
import { store, AppConfig } from './store';
import { getRulesJsonPath, loadRulesFromFile, saveRulesToFile } from './rulesFile';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

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

  // Export Advanced chat history (JSON) after a task finishes (kept until next task starts)
  ipcMain.handle('export-advanced-history', async () => {
    const payload = agentService.getAdvancedHistoryExportObject();
    const count = Number(payload?.messageCount ?? 0);
    if (!count) {
      throw new Error('No Advanced history available to export (run a task first).');
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultPath = path.join(app.getPath('downloads'), `piglet-advanced-history-${ts}.json`);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export Chat History (Advanced)',
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { canceled: true };

    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { canceled: false, path: filePath, count };
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
