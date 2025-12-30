import { clipboard } from "electron";
import robot from "robotjs";
import screenshot from "screenshot-desktop";
import jimp from "jimp";

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error("Aborted"));
    };

    const cleanup = () => {
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          // ignore
        }
      }
    };

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        cleanup();
        reject(new Error("Aborted"));
        return;
      }
      // IMPORTANT: use a single listener per sleep call, and always remove it
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

export const mapKey = (key: string): string => {
  const map: Record<string, string> = {
    return: "enter",
    ctrl: "control",
    cmd: "command",
    win: "command",
    meta: "command",
    shift: "shift",
    // macOS: Option 键在 robotjs 里叫 'alt'
    alt: "alt",
    option: "alt",
    opt: "alt",
    "⌥": "alt",
    esc: "escape",
    space: "space",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
    "page down": "pagedown",
    "page up": "pageup",
  };
  return map[key.toLowerCase()] || key.toLowerCase();
};

export const escapeSingleQuotes = (s: string) =>
  (s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// Executor tool schema: keep stable & human-readable (don't depend on LangChain internals)
export function getExecutorToolSchemaText(toolName: string) {
  const schemas: Record<string, string> = {
    click: "{ x: int, y: int }",
    left_double: "{ x: int, y: int }",
    right_single: "{ x: int, y: int }",
    drag: "{ start_x: int, start_y: int, end_x: int, end_y: int }",
    hotkey: "{ key: string }",
    type: "{ content: string }",
    scroll: "{ x: int, y: int, direction: 'down' | 'up' | 'left' | 'right' }",
    wait: "{}",
    finished: "{ content?: string }",
  };
  return schemas[toolName] || "{}";
}

export type PendingScreenshotOverlay =
  | {
      kind:
        | "click"
        | "double_click"
        | "right_click"
        | "middle_click"
        | "drag"
        | "hover"
        | "hotkey";
      x?: number; // logical screen coords
      y?: number;
      startX?: number;
      startY?: number;
      endX?: number;
      endY?: number;
      label: string;
    }
  | null;

export async function drawOverlayIntoScreenshot(
  image: any,
  overlay: NonNullable<PendingScreenshotOverlay>,
  scaleFactor: number,
) {
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  const toPx = (v: number | undefined) => (v == null ? undefined : Math.round(v * scaleFactor));

  const W = image.bitmap.width;
  const H = image.bitmap.height;

  const font = await jimp.loadFont(jimp.FONT_SANS_16_WHITE);
  const labelText = overlay.label || "";

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
          if (d2 < inner2 * 0.25) {
            image.setPixelColor(0xff2a2a33, x, y);
          }
        }
      }
    }
  };

  if (overlay.kind === "hotkey") {
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

export async function captureScreenB64(opts: {
  pendingOverlay: PendingScreenshotOverlay;
  maxPixels?: number;
  minPixels?: number;
}): Promise<{
  base64Raw: string;
  base64WithOverlay: string;
  width: number;
  height: number;
  scaleFactor: number;
  pendingOverlayAfter: PendingScreenshotOverlay;
}> {
  const imgBuffer = await screenshot({ format: "png" });
  const screenSize = robot.getScreenSize();

  // Base screenshot (no overlay)
  const rawImage = await jimp.read(imgBuffer);
  // Clone for Advanced (with overlay injected)
  const overlayImage = rawImage.clone();

  const scaleFactor = rawImage.bitmap.width / screenSize.width;
  const MAX_PIXELS = opts.maxPixels ?? 2116800;
  const MIN_PIXELS = opts.minPixels ?? 3136;

  // Draw previous step overlay ONLY into Advanced screenshot (UI-TARS-like)
  let pendingOverlayAfter: PendingScreenshotOverlay = opts.pendingOverlay;
  if (opts.pendingOverlay) {
    try {
      await drawOverlayIntoScreenshot(overlayImage, opts.pendingOverlay, scaleFactor);
    } catch (e) {
      console.warn("[captureScreen] drawOverlayIntoScreenshot failed", e);
    } finally {
      // Apply only once: "previous action" overlay
      pendingOverlayAfter = null;
    }
  }

  // Resize BOTH images to the same size (critical for coordinate mapping)
  let newWidth = rawImage.bitmap.width;
  let newHeight = rawImage.bitmap.height;
  if (newWidth * newHeight > MAX_PIXELS) {
    const factor = Math.sqrt(MAX_PIXELS / (newWidth * newHeight));
    newWidth = Math.floor(newWidth * factor);
    newHeight = Math.floor(newHeight * factor);
    rawImage.resize(newWidth, newHeight);
    overlayImage.resize(newWidth, newHeight);
  } else if (newWidth * newHeight < MIN_PIXELS) {
    const factor = Math.sqrt(MIN_PIXELS / (newWidth * newHeight));
    newWidth = Math.ceil(newWidth * factor);
    newHeight = Math.ceil(newHeight * factor);
    rawImage.resize(newWidth, newHeight);
    overlayImage.resize(newWidth, newHeight);
  }

  const base64Raw = (await rawImage.getBufferAsync(jimp.MIME_PNG)).toString("base64");
  const base64WithOverlay = (await overlayImage.getBufferAsync(jimp.MIME_PNG)).toString("base64");

  return {
    base64Raw,
    base64WithOverlay,
    width: newWidth,
    height: newHeight,
    scaleFactor,
    pendingOverlayAfter,
  };
}

export type ParsedAction =
  | {
      actionType: string;
      args: Record<string, any>;
    }
  | null;

export function parseUiTarsAction(actionStr: string): ParsedAction {
  // Improved regex to capture action name and arguments (对齐 dualAgent.ts)
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
  const startBoxMatch = argsStr.match(
    /start_box=['"]?(?:<\|box_start\|>)?[\(\[](\d+),\s*(\d+)[\)\]](?:<\|box_end\|>)?['"]?/,
  );
  if (startBoxMatch) {
    args.start_box = [parseInt(startBoxMatch[1]), parseInt(startBoxMatch[2])];
  }

  // Extract end_box='(x,y)'
  const endBoxMatch = argsStr.match(
    /end_box=['"]?(?:<\|box_start\|>)?[\(\[](\d+),\s*(\d+)[\)\]](?:<\|box_end\|>)?['"]?/,
  );
  if (endBoxMatch) {
    args.end_box = [parseInt(endBoxMatch[1]), parseInt(endBoxMatch[2])];
  }

  // Extract direction
  const dirMatch = argsStr.match(/direction='([^']+)'/);
  if (dirMatch) args.direction = dirMatch[1];

  return { actionType, args };
}

export async function executeUiTarsAction(opts: {
  actionResponse: string;
  modelImageWidth: number;
  modelImageHeight: number;
  scaleFactor: number; // kept for API compatibility (may be used by callers)
  signal: AbortSignal;
  sendToOverlay: (channel: string, payload: any) => void;
}): Promise<{ pendingOverlay: PendingScreenshotOverlay }> {
  if (opts.signal.aborted) return { pendingOverlay: null };

  const screenSize = robot.getScreenSize();
  console.log(`Action Response: ${opts.actionResponse}`);

  const cleanAction = (opts.actionResponse || "").replace(/^Action:\s*/, "").trim();
  const parsed = parseUiTarsAction(cleanAction);

  if (!parsed) {
    console.log("Failed to parse action:", cleanAction);
    return { pendingOverlay: null };
  }

  const { actionType, args } = parsed;

  const mapCoords = (x: number, y: number) => {
    const logicalX = (x / opts.modelImageWidth) * screenSize.width;
    const logicalY = (y / opts.modelImageHeight) * screenSize.height;
    return { x: logicalX, y: logicalY };
  };

  let pendingOverlay: PendingScreenshotOverlay = null;

  // --- Strictly Following UI-TARS Logic via RobotJS Adaptation ---
  switch (actionType) {
    case "click":
    case "left_click":
    case "left_single":
      if (args.start_box) {
        const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
        robot.moveMouse(x, y);
        opts.sendToOverlay("draw-highlight", { type: "click", x, y });
        await sleep(100, opts.signal);
        if (opts.signal.aborted) return { pendingOverlay };
        robot.mouseClick();
        // annotate next screenshot
        pendingOverlay = { kind: "click", x, y, label: "click" };
      }
      break;

    case "left_double":
    case "double_click":
      if (args.start_box) {
        const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
        robot.moveMouse(x, y);
        opts.sendToOverlay("draw-highlight", { type: "double_click", x, y });
        await sleep(100, opts.signal);
        if (opts.signal.aborted) return { pendingOverlay };
        robot.mouseClick("left");
        await sleep(10, opts.signal); // within system double-click threshold
        if (opts.signal.aborted) return { pendingOverlay };
        robot.mouseClick("left", true);
        pendingOverlay = { kind: "double_click", x, y, label: "left double click" };
      }
      break;

    case "right_single":
    case "right_click":
      if (args.start_box) {
        const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
        robot.moveMouse(x, y);
        opts.sendToOverlay("draw-highlight", { type: "right_click", x, y });
        await sleep(100, opts.signal);
        if (opts.signal.aborted) return { pendingOverlay };
        robot.mouseClick("right");
        pendingOverlay = { kind: "right_click", x, y, label: "right click" };
      }
      break;

    case "middle_click":
      if (args.start_box) {
        const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
        robot.moveMouse(x, y);
        opts.sendToOverlay("draw-highlight", { type: "middle_click", x, y });
        robot.mouseClick("middle");
        pendingOverlay = { kind: "middle_click", x, y, label: "middle click" };
      }
      break;

    case "drag":
    case "left_click_drag":
    case "select":
      if (args.start_box && args.end_box) {
        const start = mapCoords(args.start_box[0], args.start_box[1]);
        const end = mapCoords(args.end_box[0], args.end_box[1]);

        opts.sendToOverlay("draw-highlight", {
          type: "drag",
          startX: start.x,
          startY: start.y,
          endX: end.x,
          endY: end.y,
        });

        robot.moveMouse(start.x, start.y);
        await sleep(100, opts.signal);
        if (opts.signal.aborted) return { pendingOverlay };
        robot.mouseToggle("down");
        robot.dragMouse(end.x, end.y);
        robot.mouseToggle("up");
      }
      break;

    case "mouse_move":
    case "hover":
      if (args.start_box) {
        const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
        robot.moveMouse(x, y);
        opts.sendToOverlay("draw-highlight", { type: "hover", x, y });
      }
      break;

    case "type":
      if (args.content) {
        console.log(`Typing: ${args.content}`);
        const content = args.content;
        const stripContent = content.replace(/\\n$/, "").replace(/\n$/, "");

        opts.sendToOverlay("draw-highlight", { type: "type", x: 0, y: 0, text: content });

        if (process.platform === "win32") {
          clipboard.writeText(stripContent);
          robot.keyTap("v", "control");
          await sleep(50, opts.signal);
        } else {
          clipboard.writeText(stripContent);
          robot.keyTap("v", "command");
          await sleep(50, opts.signal);
        }

        if (content.endsWith("\n") || content.endsWith("\\n")) {
          if (opts.signal.aborted) return { pendingOverlay };
          robot.keyTap("enter");
        }
      }
      break;

    case "hotkey":
    case "press":
      if (args.key) {
        const rawKey = String(args.key ?? "").trim().toLowerCase();
        // 兼容：
        // - "command+shift+3"（推荐格式）
        // - "command shift 3"
        // - "page down"（单键，带空格；mapKey 支持这个 key 名）
        let keys: string[] = [];
        if (rawKey.includes("+")) {
          keys = rawKey.split("+").map((s: string) => s.trim()).filter(Boolean);
        } else if (mapKey(rawKey) !== rawKey) {
          keys = [rawKey];
        } else {
          keys = rawKey.split(/\s+/).map((s: string) => s.trim()).filter(Boolean);
        }
        const modifiers: string[] = [];
        let mainKey = "";
        const ordered: string[] = [];

        keys.forEach((k: string) => {
          const mapped = mapKey(k);
          ordered.push(mapped);
          if (["command", "control", "alt", "shift"].includes(mapped)) {
            if (!modifiers.includes(mapped)) modifiers.push(mapped);
          } else {
            mainKey = mapped;
          }
        });

        if (mainKey) {
          console.log(`Main Key: ${mainKey}`);
          console.log(`Hotkey: ${modifiers.join("+")}`);
          opts.sendToOverlay("draw-highlight", { type: "hotkey", text: args.key });
          robot.keyTap(mainKey, modifiers);
          pendingOverlay = { kind: "hotkey", label: args.key };
        }
      }
      break;

    case "scroll":
      if (args.direction) {
        if (args.start_box) {
          const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
          robot.moveMouse(x, y);
        }

        const magnitude = 10;
        opts.sendToOverlay("draw-highlight", { type: "scroll", text: args.direction });

        if (args.direction === "down") robot.scrollMouse(0, -magnitude);
        if (args.direction === "up") robot.scrollMouse(0, magnitude);
      }
      break;

    case "wait":
      opts.sendToOverlay("draw-highlight", { type: "wait" });
      await sleep(5000, opts.signal);
      break;

    case "finished":
      break;

    default:
      console.log("Unhandled action:", actionType);
  }

  return { pendingOverlay };
}

export function selfTestMouseMovement(signal: AbortSignal) {
  // 保持与 dualAgent.ts 之前一致：用于验证 macOS Accessibility 权限（鼠标可控）
  console.log("Testing mouse movement...");
  const screenSize = robot.getScreenSize();
  const center = { x: screenSize.width / 2, y: screenSize.height / 2 };

  robot.moveMouse(center.x, center.y);
  if (signal.aborted) return;

  robot.moveMouse(center.x + 50, center.y);
  robot.moveMouse(center.x - 50, center.y);
  robot.moveMouse(center.x, center.y);
  console.log("Mouse test complete.");
}


