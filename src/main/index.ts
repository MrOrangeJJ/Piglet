import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import { DualAgentService } from './agent/dualAgent';
import { setupIpcHandlers } from './ipcHandlers';

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let isQuitting = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false, // For simplicity in this demo, use contextBridge in production
      webSecurity: false
    }
  });

  // In a real app, load from dist/renderer or dev server
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!isQuitting && overlayWindow && !overlayWindow.isDestroyed()) {
      try {
        overlayWindow.close();
      } catch (e) {
        // ignore
      }
    }
    overlayWindow = null;
  });
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  
  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    type: 'panel', // keep lightweight
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    focusable: false, // Important: Click-through by default
    hiddenInMissionControl: true,
    skipTaskbar: true,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  
  overlayWindow.setContentProtection(true); // Prevent capture in screenshots
  
  if (process.platform === 'win32') {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver'); 
  } else {
    overlayWindow.setAlwaysOnTop(true, 'floating'); // 'floating' is safer on Mac than 'screen-saver' or 'main-menu' for focus
  }
  
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true }); // Click-through
  
  if (process.env.VITE_DEV_SERVER_URL) {
    overlayWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}/overlay.html`);
  } else {
    overlayWindow.loadFile(path.join(__dirname, '../dist/overlay.html'));
  }

  // Ensure overlay shows without stealing focus
  overlayWindow.once('ready-to-show', () => {
    if (!isQuitting && overlayWindow && !overlayWindow.isDestroyed()) {
      try {
        overlayWindow.showInactive();
      } catch (e) {
        // ignore
      }
    }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  
  // Explicitly ensure the app icon is in the dock and main window is focused
  if (app.dock) app.dock.show();
  if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
  }
  
  const agentService = new DualAgentService(mainWindow!, overlayWindow!);
  setupIpcHandlers(ipcMain, agentService);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Mirror UI-TARS: destroy all windows on quit to avoid "Object has been destroyed"
app.on('before-quit', () => {
  isQuitting = true;
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((w) => {
    try {
      w.removeAllListeners();
      w.destroy();
    } catch (e) {
      // ignore
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

