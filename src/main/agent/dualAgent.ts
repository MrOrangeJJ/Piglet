import { BrowserWindow, ipcMain, IpcMain, clipboard } from 'electron';
import { OpenAI } from 'openai';
import robot from 'robotjs';
import screenshot from 'screenshot-desktop';
import jimp from 'jimp';

// Types for IPC messages
export interface ModelConfig {
    baseUrl: string;
    apiKey: string;
    modelName: string;
}

export interface AppConfig {
    advancedModel: ModelConfig;
    actionModel: ModelConfig;
    rules?: Array<{
        id: string;
        name: string;
        content: string;
        enabled: boolean;
        injectToAdvanced?: boolean;
        injectToAction?: boolean;
    }>;
}

export interface TaskStartPayload {
  instruction: string;
  config: AppConfig;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(true), ms);
    if (signal) {
        if (signal.aborted) {
            clearTimeout(timeout);
            reject(new Error('Aborted'));
            return;
        }
        signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('Aborted'));
        });
    }
});

const mapKey = (key: string): string => {
    const map: Record<string, string> = {
        'return': 'enter',
        'ctrl': 'control',
        'cmd': 'command',
        'win': 'command',
        'meta': 'command',
        'shift': 'shift',
        'alt': 'alt',
        'esc': 'escape',
        'space': 'space',
        'up': 'up',
        'down': 'down',
        'left': 'left',
        'right': 'right',
        'page down': 'pagedown',
        'page up': 'pageup',
    };
    return map[key.toLowerCase()] || key.toLowerCase();
};

export class DualAgentService {
  private advancedClient: OpenAI | null = null;
  private actionClient: OpenAI | null = null;
  private advancedHistory: any[] = [];
  private actionHistory: any[] = [];
  private mainWindow: BrowserWindow;
  private overlayWindow: BrowserWindow;
  
  // Abort Controller for immediate stopping
  private abortController: AbortController | null = null;
  
  // Current Configuration
  private currentConfig: AppConfig | null = null;
  
  // Track repetitive actions
  private lastActionResponse: string = '';
  private repeatActionCount: number = 0;

  // Overlay annotation to be drawn into NEXT screenshot sent to LLM
  private pendingScreenshotOverlay:
    | {
        kind:
          | 'click'
          | 'double_click'
          | 'right_click'
          | 'middle_click'
          | 'drag'
          | 'hover'
          | 'hotkey';
        x?: number; // logical screen coords
        y?: number;
        startX?: number;
        startY?: number;
        endX?: number;
        endY?: number;
        label: string;
      }
    | null = null;

  constructor(mainWindow: BrowserWindow, overlayWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.overlayWindow = overlayWindow;
  }

  /** Ensure overlay is click-through (critical to avoid "mouse dead" after task ends) */
  private ensureOverlayClickThrough() {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      try {
        this.overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      } catch (e) {
        // ignore
      }
    }
  }

  /** Safe send to overlay (skip if destroyed) */
  private sendToOverlay(channel: string, payload: any) {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      try {
        this.overlayWindow.webContents.send(channel, payload);
      } catch (e) {
        console.error('overlay send error', e);
      }
    }
  }

  /** Safe send to main (skip if destroyed) */
  private sendToMain(channel: string, payload?: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send(channel, payload);
      } catch (e) {
        console.error('main send error', e);
      }
    }
  }

  async startTask(instruction: string, config: AppConfig) {
    // Cancel previous task if running
    if (this.abortController) {
        this.abortController.abort();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.currentConfig = config;
    this.advancedHistory = [];
    this.actionHistory = [];
    this.lastActionResponse = '';
    this.repeatActionCount = 0;
    
    // Initialize clients with new config
    try {
        this.advancedClient = new OpenAI({
            baseURL: config.advancedModel.baseUrl,
            apiKey: config.advancedModel.apiKey,
            dangerouslyAllowBrowser: true
        });
        
        this.actionClient = new OpenAI({
            baseURL: config.actionModel.baseUrl,
            apiKey: config.actionModel.apiKey,
            dangerouslyAllowBrowser: true
        });
    } catch (e) {
        this.mainWindow.webContents.send('task-error', "Failed to initialize OpenAI clients. Check your settings.");
        return;
    }
    
    // --- Self-Test: Mouse Movement ---
    try {
        console.log("Testing mouse movement...");
        const screenSize = robot.getScreenSize();
        const center = { x: screenSize.width / 2, y: screenSize.height / 2 };
        
        robot.moveMouse(center.x, center.y);
        if (signal.aborted) return;
        
        // Using signal-aware sleep for smoother interruption
        // But for short UI feedback actions, standard sleep is ok, but risky if user stops *during* init
        robot.moveMouse(center.x + 50, center.y);
        robot.moveMouse(center.x - 50, center.y);
        robot.moveMouse(center.x, center.y);
        console.log("Mouse test complete.");
    } catch (e) {
        console.error("Mouse test failed! Check Accessibility Permissions.", e);
        this.mainWindow.webContents.send('task-error', "Mouse control failed. Please grant Accessibility permissions.");
        this.abortController = null;
        return;
    }
    // ---------------------------------
    
    // Show overlay widget
    this.ensureOverlayClickThrough();
    this.sendToOverlay('show-widget', { visible: true });

    try {
      await this.runLoop(instruction, signal);
    } catch (error: any) {
      if (error.message === 'Aborted') {
          console.log("Task aborted by user.");
      } else {
      console.error("Task loop error:", error);
          this.mainWindow.webContents.send('task-error', error.message || error);
      }
    } finally {
      this.abortController = null;
      // Always restore click-through even if the user was hovering the widget when it hides
      this.ensureOverlayClickThrough();
      this.sendToOverlay('show-widget', { visible: false });
    }
  }

  stopTask() {
    if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
    }
    // Ensure overlay does not keep intercepting mouse
    this.ensureOverlayClickThrough();
    this.sendToOverlay('show-widget', { visible: false });
    this.sendToMain('task-finished'); // Update UI immediately
  }

  private async runLoop(instruction: string, signal: AbortSignal) {
    let currentInstruction = instruction;
    let count = 0;
    const advancedExtraPrompt = (this.currentConfig?.rules || [])
        .filter((r) => r && r.enabled && (r.content || '').trim().length > 0 && (r.injectToAdvanced ?? true))
        .map((r) => r.content.trim())
        .join('\n\n');
    const actionExtraPrompt = (this.currentConfig?.rules || [])
        .filter((r) => r && r.enabled && (r.content || '').trim().length > 0 && (r.injectToAction ?? false))
        .map((r) => r.content.trim())
        .join('\n\n');
    
    while (!signal.aborted) {
      const { base64, width, height, scaleFactor } = await this.captureScreen();
      
      let thoughtPrompt = "";
      if (count <= 0){
        thoughtPrompt = this.constructThoughtPrompt(currentInstruction, advancedExtraPrompt);
      } else {
        thoughtPrompt = "这是user执行过上一次操作后的屏幕截图，请你继续指示下一步操作(注意根据当前截图判断用户上一部是否正确的执行了要求的操作！如果没有请你继续换一种请你换一种指式方法/想想其他办法/更详细的描述来操作上一步。)";
        if (advancedExtraPrompt) {
          thoughtPrompt += `\n\n# ## Extra Prompt\n${advancedExtraPrompt}`;
        }
      }

      // Inject Warning if action repeated 3+ times
      if (this.repeatActionCount >= 3) {
          thoughtPrompt += "\n\n(注意：Action Model的输出已经连续3次完全一样了！请你换一种指式方法/想想其他办法/更详细的描述！这个user比较笨，听不懂你现在这个指令)";
          console.log("Injecting repetition warning to Advanced Model.");
      }

    if (signal.aborted) break;
    const thoughtResponse = await this.callAdvancedModel(base64, thoughtPrompt);
    if (signal.aborted) break;
    
    const imageSrc = `data:image/png;base64,${base64}`;
    this.sendToMain('agent-thought', { text: thoughtResponse, image: imageSrc });
      
      const actionPrompt = this.constructActionPrompt(thoughtResponse, actionExtraPrompt); 
      if (signal.aborted) break;

    const actionResponse = await this.callActionModel(base64, actionPrompt);
    if (signal.aborted) break;


    this.sendToMain('agent-action-plan', { text: actionResponse, image: imageSrc });

    //提取actionResponse中Action:开始的内容(包括Action:)
    const actionText = actionResponse.match(/Action:\s*(.*)/)?.[1] || "";
    
      // Track Repetition
      if (actionText === this.lastActionResponse) {
          this.repeatActionCount++;
      } else {
          this.repeatActionCount = 1;
          this.lastActionResponse = actionText;
      }

      count++;
      await this.executeAction(actionText, width, height, scaleFactor, signal);
      
      if (actionText.includes("finished")) {
        this.sendToMain('task-finished');
        break;
      }
      
      if (signal.aborted) break;
      await sleep(2000, signal);
    }
  }

  private async captureScreen() {
    // No need to hide/show overlay thanks to setContentProtection(true)
    const imgBuffer = await screenshot({ format: 'png' });
    const screenSize = robot.getScreenSize();
    const jimpImage = await jimp.read(imgBuffer);
    
    const scaleFactor = jimpImage.bitmap.width / screenSize.width;
    const MAX_PIXELS = 2116800;

    // Draw previous step overlay into current screenshot for LLM (UI-TARS-like)
    if (this.pendingScreenshotOverlay) {
        try {
            await this.drawOverlayIntoScreenshot(jimpImage, this.pendingScreenshotOverlay, scaleFactor);
        } catch (e) {
            console.warn('[captureScreen] drawOverlayIntoScreenshot failed', e);
        } finally {
            // Apply only once: "previous action" overlay
            this.pendingScreenshotOverlay = null;
        }
    }
    
    let newWidth = jimpImage.bitmap.width;
    let newHeight = jimpImage.bitmap.height;
    
    if (newWidth * newHeight > MAX_PIXELS) {
        const factor = Math.sqrt(MAX_PIXELS / (newWidth * newHeight));
        newWidth = Math.floor(newWidth * factor);
        newHeight = Math.floor(newHeight * factor);
        jimpImage.resize(newWidth, newHeight);
    }
    
    const base64 = (await jimpImage.getBufferAsync(jimp.MIME_PNG)).toString('base64');
    
    return {
        base64,
        width: newWidth, 
        height: newHeight, 
        scaleFactor
    };
  }

  private async drawOverlayIntoScreenshot(
    image: any,
    overlay: NonNullable<DualAgentService['pendingScreenshotOverlay']>,
    scaleFactor: number,
  ) {
    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
    const toPx = (v: number | undefined) =>
      v == null ? undefined : Math.round(v * scaleFactor);

    const W = image.bitmap.width;
    const H = image.bitmap.height;

    const font = await jimp.loadFont(jimp.FONT_SANS_16_WHITE);
    const labelText = overlay.label || '';

    const drawLabel = async (px: number, py: number, text: string) => {
      const maxTextWidth = 260;
      const textW = jimp.measureText(font, text);
      const boxW = clamp(textW + 16, 60, maxTextWidth + 16);
      const boxH = 28;
      const bg = await new jimp(boxW, boxH, 0x000000aa);
      bg.print(
        font,
        8,
        6,
        {
          text,
          alignmentX: jimp.HORIZONTAL_ALIGN_LEFT,
          alignmentY: jimp.VERTICAL_ALIGN_MIDDLE,
        },
        boxW - 16,
        boxH - 12,
      );
      // place near the marker, avoid going offscreen
      const x = clamp(px + 18, 0, W - boxW - 2);
      const y = clamp(py - boxH - 18, 0, H - boxH - 2);
      image.composite(bg, x, y);
    };

    const drawRing = (px: number, py: number, radius: number, thickness: number) => {
      const r2 = radius * radius;
      const inner = radius - thickness;
      const inner2 = inner * inner;
      const minX = clamp(px - radius - 2, 0, W - 1);
      const maxX = clamp(px + radius + 2, 0, W - 1);
      const minY = clamp(py - radius - 2, 0, H - 1);
      const maxY = clamp(py + radius + 2, 0, H - 1);
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const dx = x - px;
          const dy = y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2 && d2 >= inner2) {
            image.setPixelColor(0xff2a2aff, x, y); // bright red ring
          } else if (d2 < inner2) {
            // subtle fill to improve visibility
            // only fill close to center a bit (keep light)
            if (d2 < (inner2 * 0.25)) {
              image.setPixelColor(0xff2a2a33, x, y);
            }
          }
        }
      }
    };

    if (overlay.kind === 'hotkey') {
      // Place a bottom-center banner
      const text = `hotkey: ${labelText}`;
      const textW = jimp.measureText(font, text);
      const boxW = clamp(textW + 24, 140, 420);
      const boxH = 34;
      const bg = await new jimp(boxW, boxH, 0x000000aa);
      bg.print(font, 12, 9, text);
      const x = Math.round((W - boxW) / 2);
      const y = clamp(H - boxH - 36, 0, H - boxH - 2);
      image.composite(bg, x, y);
      return;
    }

    const px = toPx(overlay.x);
    const py = toPx(overlay.y);
    if (px == null || py == null) return;

    // Bigger and clearer than current on-screen overlay: radius 28, thickness 6
    drawRing(px, py, 28, 6);
    await drawLabel(px, py, labelText);
  }
  private constructThoughtPrompt(instruction: string, extraPrompt?: string) {
    return `You are a GUI agent. You are given a task and action history, with screenshots of user's current screen. You need to perform the next action to complete the task. 

# ## Output Format
# \`\`\`
# Thought: ...
# \`\`\`

# ## Action Space
click, left_double, right_single, drag, hotkey, type, scroll, wait, finished

# ## Note
# - Use Chinese in \`Thought\` part.
# - Write a small plan and finally summarize your next action (with its target element) in one sentence in \`Thought\` part.
# - You only need to write the "Thought" section; there's no need to provide overly detailed instructions.
# - Make sure that your Thought contains only one action(click,key press and etc) at a time.
# - Further actions are on hold, and next plan will be revised after the user provides feedback with a screenshot (since the user's operation might be wrong; if current step fails, you need to adjust your instructions or find other solutions until that step is correctly resolved, so you cannot skip steps).
# - If a command repeatedly fails, you need to adjust your instructions to make them clearer! Your user might be clueless, and repeatedly using the same command/method won't lead to the correct outcome.
# - Make SURE Only One Action(one of the above actions) At A Response! No such things like "输入xxx并回车" since "输入" and "回车" are two different actions.
# - Your output should not include any coordinate information, only pure text descriptions. The details should be left for the user to handle.

# ## Output Example
# Instruction: 我需要打开 VSCode 应用程序。在底部的 Dock 栏中，我可以看到 VSCode 的图标（蓝色图标，位于终端图标和另一个深色图标之间）。
#下一步操作：点击 Dock 栏中的 VSCode 图标以打开应用程序。

# ## Extra Prompt
${extraPrompt}
# ## User Instruction
${instruction}`;
  }

  private constructActionPrompt(thought: string, extraPrompt?: string) {
    return `You are a GUI agent. You are given a action instruction, with screenshots. You need to perform the next action(follow the instruction strictly dont think too much, do what the instruction ask you to do) to complete the task. 

## Output Format
\`\`\`
Action: ...
\`\`\`

## Action Space

click(start_box='<|box_start|>(x1, y1)<|box_end|>')
left_double(start_box='<|box_start|>(x1, y1)<|box_end|>')
right_single(start_box='<|box_start|>(x1, y1)<|box_end|>')
drag(start_box='<|box_start|>(x1, y1)<|box_end|>', end_box='<|box_start|>(x3, y3)<|box_end|>')
hotkey(key='')
type(content='') #If you want to submit your input, use "\\n" at the end of \`content\`.
scroll(start_box='<|box_start|>(x1, y1)<|box_end|>', direction='down or up or right or left')
wait() #Sleep for 5s and take a screenshot to check for any changes.
finished(content='xxx') # Use escape characters \\', \\", and \\n in content part to ensure we can parse the content in normal python string format.

# ## Note
# - Make SURE Only One Action At A Time!
# - Even if the instructions contain two consecutive actions, you can only output one action at a time.
# - For example, 'type(content='xxx') \nhotkey(key='enter')' is not allowed in one output, you should only output 'type(content='xxx')'instead.
# - You must 100% follow the instruction strictly, if instructions tell you to press whichever keyboard shortcut you must do 100% the same.


## Extra Prompt
${extraPrompt}
## User Instruction
${thought}`;
  }

  private async callAdvancedModel(base64Image: string, prompt: string) {
    if (!this.advancedClient || !this.currentConfig) throw new Error("Advanced Client not initialized");

    const messages = [
        ...this.advancedHistory,
        {
            role: "user",
            content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
                { type: "text", text: prompt }
            ]
        }
    ];
    
    const completion = await this.advancedClient.chat.completions.create({
        model: this.currentConfig.advancedModel.modelName,
        messages: messages as any,
        temperature: 0
    });
    
    const content = completion.choices[0].message.content || "";
    this.advancedHistory.push({ role: "user", content: prompt });
    this.advancedHistory.push({ role: "assistant", content });
    return content;
  }

  private async callActionModel(base64Image: string, prompt: string) {
    if (!this.actionClient || !this.currentConfig) throw new Error("Action Client not initialized");

     const messages = [
        // ...this.actionHistory,
        {
            role: "user",
            content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
                { type: "text", text: prompt }
            ]
        }
    ];
    
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const completion = await this.actionClient.chat.completions.create({
            model: this.currentConfig.actionModel.modelName,
            messages: messages as any,
            temperature: 0
        });
        
        const content = completion.choices[0].message.content || "";
        const hasAction = content.includes("Action:");
        
        if (hasAction) {
            // Only record valid outputs to avoid polluting history
            this.actionHistory.push({ role: "user", content: prompt });
            this.actionHistory.push({ role: "assistant", content });
            return content;
        }
        
        console.warn(`[ActionModel] Missing "Action:" in response (attempt ${attempt}/${maxAttempts}). Retrying once...`, content);
        // Do NOT record invalid output; retry once.
    }
    
    // If still invalid after retry, return last content without recording
    return "";
  }

  private parseAction(actionStr: string) {
      // Improved regex to capture action name and arguments
      const match = actionStr.match(/^([a-z_]+)\((.*)\)$/);
      if (!match) return null;
      
      const actionType = match[1];
      const argsStr = match[2];
      const args: any = {};
      
      // Extract content='...'
      const contentMatch = argsStr.match(/content='((?:[^'\\]|\\.)*)'/);
      if (contentMatch) args.content = contentMatch[1];
      
      // Extract key='...'
      const keyMatch = argsStr.match(/key='([^']+)'/);
      if (keyMatch) args.key = keyMatch[1];
      
      // Extract start_box='(x,y)'
      const startBoxMatch = argsStr.match(/start_box=['"]?(?:<\|box_start\|>)?[\(\[](\d+),\s*(\d+)[\)\]](?:<\|box_end\|>)?['"]?/);
      if (startBoxMatch) {
          args.start_box = [parseInt(startBoxMatch[1]), parseInt(startBoxMatch[2])];
      }
      
      // Extract end_box='(x,y)'
      const endBoxMatch = argsStr.match(/end_box=['"]?(?:<\|box_start\|>)?[\(\[](\d+),\s*(\d+)[\)\]](?:<\|box_end\|>)?['"]?/);
      if (endBoxMatch) {
          args.end_box = [parseInt(endBoxMatch[1]), parseInt(endBoxMatch[2])];
      }
      
      // Extract direction
      const dirMatch = argsStr.match(/direction='([^']+)'/);
      if (dirMatch) args.direction = dirMatch[1];

      return { actionType, args };
  }

  private async executeAction(actionResponse: string, modelImageWidth: number, modelImageHeight: number, scaleFactor: number, signal: AbortSignal) {
    if (signal.aborted) return;
    
    const screenSize = robot.getScreenSize();
    console.log(`Action Response: ${actionResponse}`);
    
    const cleanAction = actionResponse.replace(/^Action:\s*/, '').trim();
    const parsed = this.parseAction(cleanAction);
    
    if (!parsed) {
        console.log("Failed to parse action:", cleanAction);
        return;
    }
    
    const { actionType, args } = parsed;
    
    const mapCoords = (x: number, y: number) => {
        const logicalX = (x / modelImageWidth) * screenSize.width;
        const logicalY = (y / modelImageHeight) * screenSize.height;
        return { x: logicalX, y: logicalY };
    };

    // --- Strictly Following UI-TARS Logic via RobotJS Adaptation ---

    switch (actionType) {
        case 'click':
        case 'left_click':
        case 'left_single':
            if (args.start_box) {
                const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
                robot.moveMouse(x, y); 
                this.sendToOverlay('draw-highlight', { type: 'click', x, y });
                await sleep(100, signal); 
                if (signal.aborted) return;
                robot.mouseClick();
                // annotate next screenshot
                this.pendingScreenshotOverlay = { kind: 'click', x, y, label: 'click' };
            }
            break;
            
        case 'left_double':
        case 'double_click':
            if (args.start_box) {
                const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
                robot.moveMouse(x, y);
                this.sendToOverlay('draw-highlight', { type: 'double_click', x, y });
                await sleep(100, signal);
                if (signal.aborted) return;
                robot.mouseClick('left');
                await sleep(10, signal); // within system double-click threshold
                if (signal.aborted) return;
                robot.mouseClick('left', true); 
                // robot.mouseClick('left');
                // await sleep(10, signal); // within system double-click threshold
                // if (signal.aborted) return;
                // robot.mouseClick('left');
                this.pendingScreenshotOverlay = {
                  kind: 'double_click',
                  x,
                  y,
                  label: 'left double click',
                };
            }
            break;

        case 'right_single':
        case 'right_click':
            if (args.start_box) {
                const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
                robot.moveMouse(x, y);
                this.sendToOverlay('draw-highlight', { type: 'right_click', x, y });
                await sleep(100, signal);
                if (signal.aborted) return;
                robot.mouseClick('right');
                this.pendingScreenshotOverlay = { kind: 'right_click', x, y, label: 'right click' };
            }
            break;

        case 'middle_click':
            if (args.start_box) {
                const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
                robot.moveMouse(x, y);
                this.sendToOverlay('draw-highlight', { type: 'middle_click', x, y });
                robot.mouseClick('middle'); 
                this.pendingScreenshotOverlay = { kind: 'middle_click', x, y, label: 'middle click' };
            }
            break;

        case 'drag':
        case 'left_click_drag':
        case 'select':
            if (args.start_box && args.end_box) {
                const start = mapCoords(args.start_box[0], args.start_box[1]);
                const end = mapCoords(args.end_box[0], args.end_box[1]);
                
                this.sendToOverlay('draw-highlight', { 
                    type: 'drag', 
                    startX: start.x, startY: start.y, 
                    endX: end.x, endY: end.y 
                });
                
                robot.moveMouse(start.x, start.y);
                await sleep(100, signal);
                if (signal.aborted) return;
                robot.mouseToggle('down');
                robot.dragMouse(end.x, end.y); 
                robot.mouseToggle('up');
            }
            break;

        case 'mouse_move':
        case 'hover':
            if (args.start_box) {
                const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
                robot.moveMouse(x, y);
                this.sendToOverlay('draw-highlight', { type: 'hover', x, y });
            }
            break;
            
        case 'type':
            if (args.content) {
                console.log(`Typing: ${args.content}`);
                const content = args.content;
                const stripContent = content.replace(/\\n$/, '').replace(/\n$/, '');
                
                this.sendToOverlay('draw-highlight', { type: 'type', x: 0, y: 0, text: content });
                
                if (process.platform === 'win32') {
                    clipboard.writeText(stripContent);
                    robot.keyTap('v', 'control');
                    await sleep(50, signal);
                } else {
                    clipboard.writeText(stripContent);
                    robot.keyTap('v', 'command');
                    await sleep(50, signal);
                }
                
                if (content.endsWith('\n') || content.endsWith('\\n')) {
                    if (signal.aborted) return;
                    robot.keyTap('enter');
                }
            }
            break;
            
        case 'hotkey':
        case 'press':
            if (args.key) {
                const keys = args.key.toLowerCase().split(/[\s+]/); 
                const modifiers: string[] = [];
                let mainKey = '';
                
                keys.forEach((k: string) => {
                    const mapped = mapKey(k);
                    if (['command', 'control', 'alt', 'shift'].includes(mapped)) {
                        modifiers.push(mapped);
                    } else {
                        mainKey = mapped;
                    }
                });
                
                if (mainKey) {
                    console.log(`Hotkey: ${mainKey} + [${modifiers}]`);
                    this.sendToOverlay('draw-highlight', { type: 'hotkey', text: args.key });
                    robot.keyTap(mainKey, modifiers);
                    this.pendingScreenshotOverlay = { kind: 'hotkey', label: args.key };
                }
            }
            break;
            
        case 'scroll':
            if (args.direction) {
                if (args.start_box) {
                     const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
                     robot.moveMouse(x, y);
                }
                
                const magnitude = 10;
                this.sendToOverlay('draw-highlight', { type: 'scroll', text: args.direction });
                
                if (args.direction === 'down') robot.scrollMouse(0, -magnitude);
                if (args.direction === 'up') robot.scrollMouse(0, magnitude);
            }
            break;
            
        case 'wait':
            this.sendToOverlay('draw-highlight', { type: 'wait' });
            await sleep(5000, signal);
            break;
            
        case 'finished':
            break;
            
        default:
            console.log("Unhandled action:", actionType);
    }
  }
}
