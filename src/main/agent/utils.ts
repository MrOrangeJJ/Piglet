import { clipboard } from "electron";
import robot from "robotjs";
import screenshot from "screenshot-desktop";
import jimp from "jimp";
import { createCanvas } from "@napi-rs/canvas";
import * as os from "node:os";
import * as path from "node:path";
import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

// Jimp built-in bitmap fonts don't support CJK glyphs; render non-ASCII as escapes so overlay is readable.
export function truncateForOverlayLabel(input: string, maxLen: number) {
  const s = String(input ?? "");
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

// Best-effort: reset OS input state after abort/stopping a task.
// This prevents "every click needs two clicks" symptoms caused by a stuck mouse-down/modifier state.
export function resetRobotInputState() {
  try {
    robot.mouseToggle("up", "left");
  } catch {}
  try {
    robot.mouseToggle("up", "right");
  } catch {}
  try {
    robot.mouseToggle("up", "middle");
  } catch {}
  try {
    robot.keyToggle("command", "up");
  } catch {}
  try {
    robot.keyToggle("control", "up");
  } catch {}
  try {
    robot.keyToggle("alt", "up");
  } catch {}
  try {
    robot.keyToggle("shift", "up");
  } catch {}
}

function escapeAppleScriptString(s: string) {
  // Escape for AppleScript string literal: backslash + double quote + newline
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
}

export async function openTerminalWindowAndGetTTY(opts?: {
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const { signal, timeoutMs = 20_000 } = opts ?? {};
  if (signal?.aborted) throw new Error("Aborted");

  // Prefer creating a new window; fallback to opening a new tab in front window.
  // Then wait until the tab's tty becomes available and return it.
  const script = `
tell application "Terminal"
  activate
  try
    set w to (make new window)
    set t to do script "" in w
  on error
    set t to do script ""
  end try
  repeat 120 times
    try
      set theTty to tty of t
      if theTty is not "" then exit repeat
    end try
    delay 0.1
  end repeat
  return tty of t
end tell
`;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: timeoutMs });
    const tty = String(stdout ?? "").trim();
    if (!tty || !tty.startsWith("/dev/")) {
      throw new Error(`Failed to get tty from Terminal. Got: ${tty}`);
    }
    return tty;
  } catch (e: any) {
    throw new Error(`无法创建/定位 Terminal window 并获取 tty: ${e?.message ?? e}`);
  }
}

export async function runCommandInTerminalTTY(opts: {
  tty: string;
  shellCommand: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{ stdout: string; exitCode: number; outputPath: string; statusPath: string }> {
  const { tty, shellCommand, signal, pollIntervalMs = 250, timeoutMs = 2 * 60_000 } = opts;
  if (signal?.aborted) throw new Error("Aborted");
  if (!tty || !tty.startsWith("/dev/")) throw new Error(`Invalid tty: ${tty}`);

  const tempId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const outputPath = path.join(os.tmpdir(), `piglet_terminal_out_${tempId}.log`);
  const statusPath = path.join(os.tmpdir(), `piglet_terminal_status_${tempId}.log`);

  try {
    await fs.unlink(outputPath);
  } catch {}
  try {
    await fs.unlink(statusPath);
  } catch {}

  // Show output in Terminal + capture via tee; preserve exit code of the command (not tee) using PIPESTATUS[0] in bash.
  const pipeStatus0 = "${PIPESTATUS[0]}";
  const inner = `bash -lc ${JSON.stringify(String(shellCommand ?? ""))} 2>&1 | tee "${outputPath}"; echo ${pipeStatus0} > "${statusPath}"`;
  const wrappedCommand = `bash -lc ${JSON.stringify(inner)}`;

  const script = `
tell application "Terminal"
  set targetTab to missing value
  repeat with w in windows
    repeat with t in tabs of w
      try
        if tty of t is "${escapeAppleScriptString(tty)}" then
          set targetTab to t
          exit repeat
        end if
      end try
    end repeat
    if targetTab is not missing value then exit repeat
  end repeat
  if targetTab is missing value then error "No Terminal tab found for tty: ${escapeAppleScriptString(tty)}"
  activate
  do script "${escapeAppleScriptString(wrappedCommand)}" in targetTab
end tell
`;

  try {
    await execFileAsync("osascript", ["-e", script], { timeout: 20_000 });
  } catch (e: any) {
    throw new Error(String(e?.message ?? e));
  }

  const start = Date.now();
  while (true) {
    if (signal?.aborted) throw new Error("Aborted");
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Terminal 命令执行超时（>${timeoutMs}ms）: ${shellCommand}`);
    }
    if (fsSync.existsSync(statusPath)) break;
    await sleep(pollIntervalMs, signal);
  }

  const stdout = await fs.readFile(outputPath, "utf8").catch(() => "");
  const codeText = await fs.readFile(statusPath, "utf8").catch(() => "1");
  const exitCode = Number.parseInt(String(codeText).trim(), 10);
  return { stdout, exitCode: Number.isFinite(exitCode) ? exitCode : 1, outputPath, statusPath };
}

export async function runInVisibleTerminal(opts: {
  shellCommand: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{ stdout: string; exitCode: number; outputPath: string; statusPath: string }> {
  const { shellCommand, signal, pollIntervalMs = 250, timeoutMs = 2 * 60_000 } = opts;

  if (signal?.aborted) throw new Error("Aborted");
  const tempId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const outputPath = path.join(os.tmpdir(), `piglet_terminal_out_${tempId}.log`);
  const statusPath = path.join(os.tmpdir(), `piglet_terminal_status_${tempId}.log`);

  // Ensure clean slate
  try {
    await fs.unlink(outputPath);
  } catch {}
  try {
    await fs.unlink(statusPath);
  } catch {}

  // Goal: user can SEE the live output in Terminal.app, while we also CAPTURE it for function return.
  // Strategy: run command through `tee` (writes to file + prints to terminal).
  // We need PIPESTATUS[0] to preserve the exit code of the command (not tee), so we ensure the outer shell is bash.
  const pipeStatus0 = "${PIPESTATUS[0]}";
  const inner = `bash -lc ${JSON.stringify(String(shellCommand ?? ""))} 2>&1 | tee "${outputPath}"; echo ${pipeStatus0} > "${statusPath}"`;
  const wrappedCommand = `bash -lc ${JSON.stringify(inner)}`;

  const script = `
tell application "Terminal"
  activate
  do script "${escapeAppleScriptString(wrappedCommand)}"
end tell
`;

  // Fire-and-forget Terminal execution (osascript itself returns immediately).
  try {
    await execFileAsync("osascript", ["-e", script], { timeout: 15_000 });
  } catch (e: any) {
    throw new Error(`无法启动 Terminal.app 或执行 AppleScript: ${e?.message ?? e}`);
  }

  const start = Date.now();
  while (true) {
    if (signal?.aborted) throw new Error("Aborted");
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Terminal 命令执行超时（>${timeoutMs}ms）: ${shellCommand}`);
    }

    // statusPath is written at the end of wrappedCommand
    if (fsSync.existsSync(statusPath)) break;
    await sleep(pollIntervalMs, signal);
  }

  const stdout = await fs.readFile(outputPath, "utf8").catch(() => "");
  const codeText = await fs.readFile(statusPath, "utf8").catch(() => "1");
  const exitCode = Number.parseInt(String(codeText).trim(), 10);
  return { stdout, exitCode: Number.isFinite(exitCode) ? exitCode : 1, outputPath, statusPath };
}

// Executor tool schema: keep stable & human-readable (don't depend on LangChain internals)
export function getExecutorToolSchemaText(toolName: string) {
  const schemas: Record<string, string> = {
    click: "{ x: int, y: int }",
    left_double: "{ x: int, y: int }",
    right_single: "{ x: int, y: int }",
    drag: "{ start_x: int, start_y: int, end_x: int, end_y: int }",
    hotkey: "{ key: string }",
    type: "{ content: string }",
    scroll: "{ x: int, y: int, direction: 'down' | 'up' | 'left' | 'right', magnitude?: int (default 10) }",
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
        | "hotkey"
        | "scroll"
        | "type"
        | "wait";
      x?: number; // logical screen coords
      y?: number;
      startX?: number;
      startY?: number;
      endX?: number;
      endY?: number;
      label: string;
    }
  | null;

export function computePendingOverlayFromToolCall(opts: {
  toolName: string;
  args: Record<string, any>;
  modelImageWidth: number;
  modelImageHeight: number;
}): PendingScreenshotOverlay {
  const { toolName, args, modelImageWidth, modelImageHeight } = opts;
  const screenSize = robot.getScreenSize();

  const mapXY = (x: number, y: number) => {
    const logicalX = (x / modelImageWidth) * screenSize.width;
    const logicalY = (y / modelImageHeight) * screenSize.height;
    return { x: logicalX, y: logicalY };
  };

  try {
    switch (toolName) {
      case "click": {
        const x = Number(args?.x);
        const y = Number(args?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const p = mapXY(x, y);
        return { kind: "click", x: p.x, y: p.y, label: "click" };
      }
      case "left_double": {
        const x = Number(args?.x);
        const y = Number(args?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const p = mapXY(x, y);
        return { kind: "double_click", x: p.x, y: p.y, label: "left double click" };
      }
      case "right_single": {
        const x = Number(args?.x);
        const y = Number(args?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const p = mapXY(x, y);
        return { kind: "right_click", x: p.x, y: p.y, label: "right click" };
      }
      case "drag": {
        const sx = Number(args?.start_x);
        const sy = Number(args?.start_y);
        const ex = Number(args?.end_x);
        const ey = Number(args?.end_y);
        if (![sx, sy, ex, ey].every((n) => Number.isFinite(n))) return null;
        const s = mapXY(sx, sy);
        const e = mapXY(ex, ey);
        return { kind: "drag", startX: s.x, startY: s.y, endX: e.x, endY: e.y, label: "drag" };
      }
      case "hotkey": {
        const key = String(args?.key ?? "");
        if (!key.trim()) return null;
        return { kind: "hotkey", label: key };
      }
      case "type": {
        const content = String(args?.content ?? "");
        const stripContent = content.replace(/\\n$/, "").replace(/\n$/, "");
        return { kind: "type", label: `type: "${truncateForOverlayLabel(stripContent, 32)}"` };
      }
      case "wait": {
        return { kind: "wait", label: "wait" };
      }
      case "scroll": {
        const x = Number(args?.x);
        const y = Number(args?.y);
        const direction = String(args?.direction ?? "");
        const rawMag = args?.magnitude;
        const magBefore = Number.isFinite(Number(rawMag)) ? Math.max(1, Math.min(10, Number(rawMag))) : 1;
        const label = `${direction} (x${magBefore})`;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          const p = mapXY(x, y);
          return { kind: "scroll", x: p.x, y: p.y, label };
        }
        return { kind: "scroll", label };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export async function drawOverlayIntoScreenshot(
  image: any,
  overlay: NonNullable<PendingScreenshotOverlay>,
  scaleFactor: number,
) {
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  const toPx = (v: number | undefined) => (v == null ? undefined : Math.round(v * scaleFactor));

  const W = image.bitmap.width;
  const H = image.bitmap.height;

  // Make overlay text much larger for readability (≈4x)
  const TEXT_SCALE = 4;
  const FONT_SIZE = 16 * TEXT_SCALE; // 64px
  const FONT_FAMILY =
    '"PingFang SC","Hiragino Sans GB","Heiti SC","Microsoft YaHei",system-ui,-apple-system,sans-serif';
  const labelText = overlay.label || "";

  const renderTextBoxPng = async (text: string, opts?: { maxWidth?: number }) => {
    const maxWidth = opts?.maxWidth ?? 260 * TEXT_SCALE;
    const paddingX = 12 * TEXT_SCALE;
    const paddingY = 8 * TEXT_SCALE;
    const lineHeight = Math.round(FONT_SIZE * 1.15);
    const canvasMeasure = createCanvas(10, 10);
    const mctx = canvasMeasure.getContext("2d");
    mctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    const textW = Math.ceil(mctx.measureText(text).width);
    const boxW = clamp(textW + paddingX * 2, 60 * TEXT_SCALE, maxWidth + paddingX * 2);
    const boxH = paddingY * 2 + lineHeight;

    const canvas = createCanvas(boxW, boxH);
    const ctx = canvas.getContext("2d");
    // background
    ctx.fillStyle = "rgba(0,0,0,0.66)";
    ctx.fillRect(0, 0, boxW, boxH);
    // text
    ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    ctx.fillStyle = "white";
    ctx.textBaseline = "top";
    ctx.fillText(text, paddingX, paddingY);
    return canvas.toBuffer("image/png");
  };

  const drawLabel = async (px: number, py: number, text: string) => {
    const buf = await renderTextBoxPng(text);
    const labelImg = await jimp.read(buf);
    const boxW = labelImg.bitmap.width;
    const boxH = labelImg.bitmap.height;
    const x = clamp(px + 18 * TEXT_SCALE, 0, W - boxW - 2);
    const y = clamp(py - boxH - 18 * TEXT_SCALE, 0, H - boxH - 2);
    image.composite(labelImg, x, y);
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

  const drawBanner = async (text: string) => {
    const buf = await renderTextBoxPng(text, { maxWidth: 420 * TEXT_SCALE });
    const bannerImg = await jimp.read(buf);
    const boxW = bannerImg.bitmap.width;
    const boxH = bannerImg.bitmap.height;
    const x = Math.round((W - boxW) / 2);
    const y = clamp(H - boxH - 36 * TEXT_SCALE, 0, H - boxH - 2);
    image.composite(bannerImg, x, y);
  };

  const drawLine = (x1: number, y1: number, x2: number, y2: number, thickness: number) => {
    const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));
    x1 = clampInt(x1, 0, W - 1);
    y1 = clampInt(y1, 0, H - 1);
    x2 = clampInt(x2, 0, W - 1);
    y2 = clampInt(y2, 0, H - 1);

    const dx = Math.abs(x2 - x1);
    const sx = x1 < x2 ? 1 : -1;
    const dy = -Math.abs(y2 - y1);
    const sy = y1 < y2 ? 1 : -1;
    let err = dx + dy;
    let x = x1;
    let y = y1;
    while (true) {
      for (let ty = -thickness; ty <= thickness; ty++) {
        for (let tx = -thickness; tx <= thickness; tx++) {
          const px = x + tx;
          const py = y + ty;
          if (px >= 0 && px < W && py >= 0 && py < H) image.setPixelColor(0xff2a2aff, px, py);
        }
      }
      if (x === x2 && y === y2) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  };

  // Banner-style overlays (no reliable point coordinate)
  if (overlay.kind === "hotkey" || overlay.kind === "type" || overlay.kind === "wait") {
    await drawBanner(`${overlay.kind}: ${labelText}`);
    return;
  }

  // Drag overlay: draw a line and endpoints, plus label near end.
  if (overlay.kind === "drag") {
    const sx = toPx(overlay.startX);
    const sy = toPx(overlay.startY);
    const ex = toPx(overlay.endX);
    const ey = toPx(overlay.endY);
    if (sx == null || sy == null || ex == null || ey == null) return;
    drawLine(sx, sy, ex, ey, 2);
    drawRing(sx, sy, 22, 5);
    drawRing(ex, ey, 26, 6);
    await drawLabel(ex, ey, labelText || "drag");
    return;
  }

  // Scroll overlay: prefer ring at scroll target if available, also show banner for direction/magnitude.
  if (overlay.kind === "scroll") {
    await drawBanner(`scroll: ${labelText}`);
    const px = toPx(overlay.x);
    const py = toPx(overlay.y);
    if (px != null && py != null) {
      drawRing(px, py, 22, 5);
      await drawLabel(px, py, "scroll");
    }
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

  // Extract magnitude (optional, executor tool only)
  const magMatch = argsStr.match(/magnitude=(\d+)/) || argsStr.match(/magnitude='(\d+)'/);
  if (magMatch) args.magnitude = parseInt(magMatch[1], 10);

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
        try {
          robot.dragMouse(end.x, end.y);
        } finally {
          // Always release mouse to avoid stuck "mouse down" if task is aborted mid-action
          try {
            robot.mouseToggle("up");
          } catch {
            // ignore
          }
        }
        pendingOverlay = {
          kind: "drag",
          startX: start.x,
          startY: start.y,
          endX: end.x,
          endY: end.y,
          label: "drag",
        };
      }
      break;

    case "mouse_move":
    case "hover":
      if (args.start_box) {
        const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
        robot.moveMouse(x, y);
        opts.sendToOverlay("draw-highlight", { type: "hover", x, y });
        pendingOverlay = { kind: "hover", x, y, label: "hover" };
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
        pendingOverlay = {
          kind: "type",
          label: `type: "${truncateForOverlayLabel(stripContent, 32)}"`,
        };
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
        let scrollTarget: { x: number; y: number } | null = null;
        if (args.start_box) {
          const { x, y } = mapCoords(args.start_box[0], args.start_box[1]);
          robot.moveMouse(x, y);
          scrollTarget = { x, y };
        }

        const rawMag = (args as any).magnitude;
        const magnitude_beforeScroll = Number.isFinite(Number(rawMag)) ? Math.max(1, Math.min(10, Number(rawMag))) : 1;
        const magnitude = magnitude_beforeScroll * 100;
        opts.sendToOverlay("draw-highlight", { type: "scroll", text: args.direction });

        if (args.direction === "down") robot.scrollMouse(0, -magnitude);
        if (args.direction === "up") robot.scrollMouse(0, magnitude);
        if (args.direction === "left") robot.scrollMouse(-magnitude, 0);
        if (args.direction === "right") robot.scrollMouse(magnitude, 0);

        pendingOverlay = {
          kind: "scroll",
          x: scrollTarget?.x,
          y: scrollTarget?.y,
          label: `${args.direction} (x${magnitude_beforeScroll})`,
        };
      }
      break;

    case "wait":
      opts.sendToOverlay("draw-highlight", { type: "wait" });
      await sleep(5000, opts.signal);
      pendingOverlay = { kind: "wait", label: "wait" };
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


