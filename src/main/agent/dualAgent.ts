import { BrowserWindow } from 'electron';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { SemanticSimilarityExampleSelector } from '@langchain/core/example_selectors';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { HumanMessage, SystemMessage, type BaseMessage, AIMessage } from '@langchain/core/messages';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { createAgent, tool } from 'langchain';
import {
  ThoughtResponseSchema,
  type ThoughtResponse,
  TerminalRunSchema,
  getExecutorActionSchema,
} from './schema';
import {
  buildAdvancedFollowupPrompt,
  buildAdvancedSystemPrompt,
  buildCoordActionArgsPrompt,
  buildTextActionArgsSystemPrompt,
  buildTerminalHistoryPrompt,
  buildTerminalNodeSystemPrompt,
} from './promptTemplate';
import {
  captureScreenB64,
  computePendingOverlay,
  executeUiTarsActionFromObj,
  resetRobotInputState,
  openTerminalWindowAndGetTTY,
  runCommandInTerminalTTY,
  selfTestMouseMovement,
  sleep,
  waitForScreenStability,
  type PendingScreenshotOverlay,
} from './utils';
import type { AppConfig } from '../store';

export interface TaskStartPayload {
  instruction: string;
  config: AppConfig;
}

// NOTE: helpers (sleep/mapKey/screenshot/action exec) moved to ./utils

// Zod schemas moved to ./schema.ts

// LangGraph TS 的 Annotation 类型在复杂工程里容易触发 TS 推导/缓存问题。
// 这里把 Annotation 相关类型降级为 any，避免阻塞开发；运行时逻辑不受影响。
const Ann: any = Annotation;
const PigletState = Ann.Root({
  userQuery: Ann({ default: () => "" }),
  step: Ann({ default: () => 0 }),
  advancedHistory: Ann({ default: () => [] }),

  screenshotB64: Ann({ default: () => undefined }),
  // Action 模型专用：不带 overlay 注入的截图
  rawScreenshotB64: Ann({ default: () => undefined }),
  modelW: Ann({ default: () => undefined }),
  modelH: Ann({ default: () => undefined }),
  scaleFactor: Ann({ default: () => undefined }),

  thoughtResponse: Ann({ default: () => undefined }),
  instructionForUser: Ann({ default: () => undefined }),
  actionType: Ann({ default: () => undefined }),

  // Executor planned tool call (computed before executing)
  plannedToolName: Ann({ default: () => undefined }),
  plannedToolArgs: Ann({ default: () => undefined }),
  plannedToolDisplayText: Ann({ default: () => undefined }),

  terminalActionResultText: Ann({ default: () => undefined }),

  // loop timing: set by timer_node; used to compute last loop duration before each call_advanced
  loopStartMs: Ann({ default: () => undefined }),
});

type PigletStateType = any;

type AdvancedRuleExample = {
  input: string;
  content: string;
  rule_name: string;
  id: string;
};

export class DualAgentService {
  private advancedModel: ChatOpenAI | null = null;
  private coordActionModel: ChatOpenAI | null = null;
  private textActionModel: ChatOpenAI | null = null;
  private advancedHistory: BaseMessage[] = [];
  private mainWindow: BrowserWindow;
  private overlayWindow: BrowserWindow;
  // LangChain 原生机制：语意相似规则选择器（只用于 Advanced rules 动态注入）
  private advancedRuleSelector: SemanticSimilarityExampleSelector<any> | null = null;
  
  // Abort Controller for immediate stopping
  private abortController: AbortController | null = null;
  
  // Current Configuration
  private currentConfig: AppConfig | null = null;
  

  // Overlay annotation to be drawn into NEXT screenshot sent to LLM
  private pendingScreenshotOverlay: PendingScreenshotOverlay = null;

  // Main window UI state before a task starts (so we can restore after task ends)
  private mainWindowStateBeforeTask: null | {
    wasMinimized: boolean;
    wasMaximized: boolean;
    wasFullScreen: boolean;
    wasVisible: boolean;
  } = null;

  constructor(mainWindow: BrowserWindow, overlayWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.overlayWindow = overlayWindow;
  }

  /** JSON-serializable export payload for Advanced history (prefers last finished snapshot). */
  getAdvancedHistoryExportObject() {
    const msgs = this.advancedHistory as any[];
    const stored = (msgs || []).map((m: any) => {
      // LangChain BaseMessage supports toDict() (StoredMessage) + toJSON() (Serializable)
      if (m && typeof m.toDict === "function") return m.toDict();
      if (m && typeof m.toJSON === "function") return m.toJSON();
      return {
        type: m?._getType?.() ?? m?.type ?? "unknown",
        content: m?.content ?? "",
        name: m?.name,
        additional_kwargs: m?.additional_kwargs,
        response_metadata: m?.response_metadata,
      };
    });
    return {
      exportedAt: new Date().toISOString(),
      messageCount: stored.length,
      messages: stored,
    };
  }

  private minimizeMainWindowForTask() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.mainWindowStateBeforeTask) return; // already captured for this task

    const state = {
      wasMinimized: this.mainWindow.isMinimized(),
      wasMaximized: this.mainWindow.isMaximized(),
      wasFullScreen: this.mainWindow.isFullScreen(),
      wasVisible: this.mainWindow.isVisible(),
    };
    this.mainWindowStateBeforeTask = state;

    try {
      // Avoid trapping the user in fullscreen during automation; minimize will send to Dock.
      if (state.wasFullScreen) this.mainWindow.setFullScreen(false);
    } catch (e) {
      console.warn('[minimizeMainWindowForTask] setFullScreen(false) failed', e);
    }

    const tryMinimize = (tag: string) => {
      try {
        if (this.mainWindow.isDestroyed()) return;
        if (!state.wasMinimized && !this.mainWindow.isMinimized()) {
          this.mainWindow.minimize();
        }
        if (!state.wasMinimized && !this.mainWindow.isMinimized()) {
          // Some macOS window types/state transitions can ignore the first minimize call.
          console.warn('[minimizeMainWindowForTask] minimize did not take effect', {
            tag,
            wasVisible: state.wasVisible,
            wasMaximized: state.wasMaximized,
            wasFullScreen: state.wasFullScreen,
          });
        }
      } catch (e) {
        console.warn('[minimizeMainWindowForTask] minimize failed', { tag, e });
      }
    };

    // Try immediately, then retry a couple times to avoid races with window focus/showInactive.
    tryMinimize('now');
    setTimeout(() => tryMinimize('t+50ms'), 50);
    setTimeout(() => tryMinimize('t+200ms'), 200);
  }

  private restoreMainWindowAfterTask() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.mainWindowStateBeforeTask = null;
      return;
    }
    const state = this.mainWindowStateBeforeTask;
    this.mainWindowStateBeforeTask = null;
    if (!state) return;

    try {
      // Only undo minimize if we minimized it.
      if (!state.wasMinimized && this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
    } catch {
      // ignore
    }

    try {
      // If the user had it visible, bring it back. If user had it minimized, don't steal focus.
      if (!state.wasMinimized) {
        this.mainWindow.show();
        this.mainWindow.focus();
      } else if (state.wasVisible) {
        // keep it visible state without stealing focus too aggressively
        this.mainWindow.showInactive();
      }
    } catch {
      // ignore
    }

    try {
      if (state.wasMaximized && !this.mainWindow.isMaximized()) {
        this.mainWindow.maximize();
      }
    } catch {
      // ignore
    }

    try {
      if (state.wasFullScreen && !this.mainWindow.isFullScreen()) {
        this.mainWindow.setFullScreen(true);
      }
    } catch {
      // ignore
    }
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

  /**
   * 动态裁剪 Advanced history（在调用 advanced model 之前统一处理）。
   *
   * index 定义：倒序 index（0 => 最后一条，1 => 倒数第二条 ...）
   *
   * 规则：
   * - 永远保留最开始的 SystemMessage（如果存在）作为最早的 msg
   * - index 0..5：保留完整对话（不删除）
   * - index > 5：删除所有 HumanMessage
   * - 在 index=6 位置插入一个 HumanMessage(content="...Previous human response omitted ")（插入，不替换）
   * - 处理后将 index > 10 的部分都切掉（保留最后 11 条；再加上最开始 SystemMessage）
   */
  private trimAdvancedHistoryForInvoke(history: BaseMessage[]): BaseMessage[] {
    const msgs = Array.isArray(history) ? [...history] : [];
    if (!msgs.length) return msgs;

    const first = msgs[0];
    const hasSystem = first && (first as any)._getType?.() === "system";
    const systemMsg = hasSystem ? (first as any as BaseMessage) : null;
    const rest = hasSystem ? msgs.slice(1) : msgs;

    // 保留最后 6 条（index 0..5）
    const keepLast = 6;
    const tail = rest.length > keepLast ? rest.slice(-keepLast) : [...rest];
    const older = rest.length > keepLast ? rest.slice(0, -keepLast) : [];

    // index > 5 的部分：删除所有 HumanMessage
    let removedAnyHuman = false;
    const olderNoHuman = older.filter((m) => {
      const t = (m as any)?._getType?.() ?? (m as any)?.type;
      const isHuman = t === "human";
      if (isHuman) removedAnyHuman = true;
      return !isHuman;
    }) as BaseMessage[];

    // Insert omission marker at reverse index=6 (right before the last 6 messages),
    // because this is exactly where we start deleting HumanMessage from older parts.
    let combinedNoMarker: BaseMessage[] = [...olderNoHuman, ...tail];
    const hadMoreThanWindow = combinedNoMarker.length > 11;
    const needMarker = removedAnyHuman || hadMoreThanWindow;

    let combined: BaseMessage[] = [...olderNoHuman];
    if (needMarker && rest.length > keepLast) {
      // Insert (do NOT replace)
      combined.push(new HumanMessage("...Previous human response omitted "));
    }
    combined.push(...tail);

    // After processing, keep only reverse index 0..10 (last 11 messages)
    if (combined.length > 101) combined = combined.slice(-101);

    return systemMsg ? [systemMsg, ...combined] : combined;
  }

  async startTask(instruction: string, config: AppConfig) {
    // Cancel previous task if running
    if (this.abortController) {
        // ensure UI state (overlay/widget/window) is cleaned up consistently
        this.stopTask();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.currentConfig = config;
    this.advancedHistory = [];

    // (coord actions now return structured args; no need to track repeated raw "Action:" lines)
    
    // Initialize LangChain models with new config
    try {
        this.advancedModel = new ChatOpenAI({
            model: config.advancedModel.modelName,
            apiKey: config.advancedModel.apiKey,
            configuration: { baseURL: config.advancedModel.baseUrl },
            // temperature: 0,
            // We implement our own bounded retry for advanced structured output.
            // Disable internal exponential backoff retries to avoid long stalls on flaky providers.
            maxRetries: 5,
        });
        
        // coordActionModel: responsible for coordinate localization (image -> schema args)
        this.coordActionModel = new ChatOpenAI({
          model: config.actionModel.modelName,
          apiKey: config.actionModel.apiKey,
          configuration: { baseURL: config.actionModel.baseUrl },
        });

        // textActionModel: responsible for text-only actions (instruction -> schema args)
        this.textActionModel = new ChatOpenAI({
          model: config.executorModel.modelName,
          apiKey: config.executorModel.apiKey,
          configuration: { baseURL: config.executorModel.baseUrl },
        });

        // Build advanced rules selector using LangChain's official mechanism:
        // SemanticSimilarityExampleSelector.fromExamples(..., MemoryVectorStore, { k, inputKeys })
        const candidates = (config.rules || [])
          .filter((r: any) => r && (r.content || "").trim().length > 0)
          .filter((r: any) => !!r.enabled && !(r.alwaysInject ?? false));

        if (!candidates.length) {
          this.advancedRuleSelector = null;
        } else {
          const embeddings = new OpenAIEmbeddings({
            model: config.embeddingsModel.modelName,
            apiKey: config.embeddingsModel.apiKey,
            configuration: { baseURL: config.embeddingsModel.baseUrl },
          });

          const examples: AdvancedRuleExample[] = candidates.map((r: any) => ({
            id: String(r.id ?? ""),
            rule_name: String(r.name ?? "Rule"),
            content: String((r.content || "").trim()),
            input: String((r.content || "").trim()),
          }));

          try {
            this.advancedRuleSelector = await SemanticSimilarityExampleSelector.fromExamples(
              examples as any,
              embeddings as any,
              MemoryVectorStore as any,
              { k: 3, inputKeys: ["input"] } as any,
            );
    } catch (e) {
            console.warn("[advancedRuleSelector] init failed, skip dynamic rules injection.", e);
            this.advancedRuleSelector = null;
          }
        }
    } catch (e) {
        this.mainWindow.webContents.send('task-error', "Failed to initialize LangChain models. Check your settings.");
        return;
    }
    
    // --- Self-Test: Mouse Movement ---
    try {
        selfTestMouseMovement(signal);
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
    // Minimize Piglet main window while task runs (do NOT affect overlay window)
    this.minimizeMainWindowForTask();

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
      // Extra safety: if we aborted mid-action, reset any stuck OS input state.
      resetRobotInputState();
      // Always restore click-through even if the user was hovering the widget when it hides
      this.ensureOverlayClickThrough();
      this.sendToOverlay('show-widget', { visible: false });
      // Restore Piglet main window after task ends
      this.restoreMainWindowAfterTask();
    }
  }

  stopTask() {
    if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
    }
 
    // If aborted mid-action, robotjs might leave the OS in a stuck input state (mouse down / modifier down).
    // This can cause the UI to require "double clicks" after stopping from the overlay.
    resetRobotInputState();
    // Ensure overlay does not keep intercepting mouse
    this.ensureOverlayClickThrough();
    this.sendToOverlay('show-widget', { visible: false });
    this.sendToMain('task-finished'); // Update UI immediately
    // Restore Piglet main window if we minimized it
    this.restoreMainWindowAfterTask();
  }

  private async runLoop(instruction: string, signal: AbortSignal) {
    if (!this.currentConfig) throw new Error("Config not initialized");
    if (!this.advancedModel || !this.coordActionModel || !this.textActionModel) {
      throw new Error("LangChain models not initialized");
    }

    // NOTE: LangGraph 的 TS 类型在复杂项目里仍可能很重；这里保持节点签名宽松（state: any）
    const graph = new StateGraph(PigletState)
      .addNode("capture", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const { base64WithOverlay, base64Raw, width, height, scaleFactor, pendingOverlayAfter } =
          await captureScreenB64({ pendingOverlay: null });
        // this.pendingScreenshotOverlay = pendingOverlayAfter;
        return {
          // screenshotB64: base64WithOverlay, // 给 Advanced / UI 展示用：带 overlay
          rawScreenshotB64: base64Raw,      // 给 Action 用：不带 overlay
          modelW: width,
          modelH: height,
          scaleFactor,
        };
      })
      .addNode("pre_capture", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const { base64WithOverlay, base64Raw, width, height, scaleFactor, pendingOverlayAfter } =
          await captureScreenB64({ pendingOverlay: this.pendingScreenshotOverlay });
        this.pendingScreenshotOverlay = pendingOverlayAfter;
        return {
          screenshotB64: base64WithOverlay, // 给 Advanced / UI 展示用：带 overlay
          // rawScreenshotB64: base64Raw,      // 给 Action 用：不带 overlay
          modelW: width,
          modelH: height,
          scaleFactor,
        };
      })
      .addNode("manage_computer_use_history", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const step = state.step || 0;
        const queryForRules = step <= 0 ? state.userQuery : (state.thoughtResponse || "");
        const advancedExtraPrompt = await this.selectAdvancedRulesPrompt(queryForRules);

        const history = this.buildComputerUseHistoryForThisTurn({
          step,
          screenshotBase64: state.screenshotB64 || "",
          rawScreenshotBase64: state.rawScreenshotB64 || "",
          userQuery: state.userQuery,
          pass_history: state.advancedHistory,
          advancedExtraPrompt,
          
        });

        return { advancedHistory: history };
      })
      .addNode("timer_node", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const now = Date.now();
        const prev = Number(state.loopStartMs);
        const hasPrev = Number.isFinite(prev) && prev > 0;
        if (hasPrev) {
          const elapsedMs = Math.max(0, now - prev);
          // UI divider to mark the previous loop duration
          this.sendToMain("agent-timer", { elapsedMs });
        }
        // First tick: only set baseline, do NOT send.
        return { loopStartMs: now };
      })
      .addNode("call_advanced", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const history = (state.advancedHistory || []) as any as BaseMessage[];
        const trimmedHistory = this.trimAdvancedHistoryForInvoke(history);
        // this.advancedHistory = [...trimmedHistory];
        const res = await this.callAdvancedStructured(trimmedHistory);

        let instr = (res.Instruction || "").toString();

        // tutorial.py: push AIMessage(content=Thought) into history
        const updatedHistory = [...history, new AIMessage(`Thought: ${res.Thought}\nInstruction: ${instr}\nActionType: ${res.ActionType}`)];
        // Fix: type action should NOT accidentally add trailing \\n (unless explicitly asked)

        const thoughtDisplay =
          `Thought: ${res.Thought}\n` + `Instruction: ${instr}\n` + `ActionType: ${res.ActionType}`;
        
        const imageSrc = `data:image/png;base64,${state.rawScreenshotB64 || ""}`;

        // Text-only event. Images are streamed via a dedicated `agent-image` event.
        this.sendToMain("agent-thought", { text: thoughtDisplay });
        this.sendToMain("agent-image", { image: imageSrc });

        this.advancedHistory = updatedHistory;

        return {
          thoughtResponse: res.Thought,
          instructionForUser: instr,
          actionType: res.ActionType,
          advancedHistory: updatedHistory,
          step: (state.step || 0) + 1,
        };
      })
      .addNode("call_terminal_action", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        if (!this.advancedModel) throw new Error("Advanced model not initialized");

        // Per requirement: entering call_terminal_action creates a NEW Terminal window/tab once,
        // and all tool calls within this node reuse the SAME tab via tty.
        let tty = await openTerminalWindowAndGetTTY({ signal, timeoutMs: 20_000 });

        const terminal_run: any = tool(
          async ({ command }: { command: string }) => {
            // Always reuse the same tty inside this call_terminal_action.
            // If user closes the tab/window, we auto-recreate a new session tty and retry once.
            const runOnce = async () =>
              await runCommandInTerminalTTY({
                tty,
                shellCommand: command,
                signal,
                pollIntervalMs: 250,
                timeoutMs: 3 * 60_000,
              });

            let stdout = "";
            let exitCode = 1;
            try {
              const r = await runOnce();
              stdout = r.stdout;
              exitCode = r.exitCode;
            } catch (e: any) {
              const msg = String(e?.message ?? e);
              if (msg.includes("No Terminal tab found for tty")) {
                tty = await openTerminalWindowAndGetTTY({ signal, timeoutMs: 20_000 });
                this.sendToMain("agent-tool", { text: `[Terminal] session tty recreated: ${tty}` });
                const r = await runOnce();
                stdout = r.stdout;
                exitCode = r.exitCode;
              } else {
                throw e;
              }
            }

            const text = `Command:\n${command}\n\nExitCode: ${exitCode}\n\nOutput:\n${stdout}`;
            // Terminal tool output is usually long: render as `agent-tool` (collapsed by default in UI).
            this.sendToMain("agent-tool", { text });
            return text;
          },
          {
            name: "terminal_run",
            description:
              "Run ONE shell command in visible macOS Terminal.app, capture its full output (stdout+stderr) and exit code.",
            schema: TerminalRunSchema as any,
          },
        ) as any;

        // LangGraph v1+ 标准实践：使用 langchain 内置的 createAgent（createReactAgent 已 deprecated）
        const agent = createAgent({
          model: this.advancedModel as any,
          tools: [terminal_run] as any,
          prompt: buildTerminalNodeSystemPrompt(),
        } as any);

        const taskGoal = (state.instructionForUser || "").toString().trim();
        const result = await agent.invoke(
          {
            messages: [{ role: "user", content: `Terminal task goal:\n${taskGoal}` }],
          } as any,
          // Give the sub-agent enough recursion budget to do multi-step terminal work
          { recursionLimit: 120 } as any,
        );

        const msgs: any[] = (result as any)?.messages || [];
        const toolOutputs = msgs
          .filter((m) => m && (m._getType?.() === "tool" || m?.type === "tool") && (m?.name === "terminal_run"))
          .map((m) => String(m?.content ?? "").trim())
          .filter((s) => s.length > 0);
        const finalAi = [...msgs].reverse().find((m) => m && (m._getType?.() === "ai" || m?.type === "ai"));
        const finalSummary = String(finalAi?.content ?? "").trim();
        //获取msgs中最后一条消息的content
        // const finalMessageContent = String(msgs[msgs.length - 1]?.content ?? "").trim();
        // console.log("finalMessageContent", finalMessageContent);

        if (finalSummary) {
          // Final summary shown as normal response line
          this.sendToMain("agent-response", { text: finalSummary });
        }

        const merged =
          (finalSummary ? `Terminal 任务结果总结：\n${finalSummary}\n\n` : "") +
          (toolOutputs.length ? `Terminal 详细输出：\n\n${toolOutputs.join("\n\n---\n\n")}` : "");

        return { terminalActionResultText: merged || (finalSummary || "Terminal 执行结束（无输出）。") };
      })
      .addNode("manage_terminal_use_history", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const terminalResultText = (state.terminalActionResultText || "").toString();
        const base64Raw = String(state.rawScreenshotB64 || "");

        const promptText = buildTerminalHistoryPrompt({ terminalResultText });
        const msg = new HumanMessage({
          content: [
            ...(base64Raw
              ? [{ type: "image_url", image_url: { url: `data:image/png;base64,${base64Raw}` } }]
              : []),
            { type: "text", text: promptText },
          ],
        } as any);

        // Context image stream
        if (base64Raw) this.sendToMain("agent-image", { image: `data:image/png;base64,${base64Raw}` });

        const nextHistory = [...(state.advancedHistory || []), msg];
        return { advancedHistory: nextHistory };
      })
      .addNode("call_coord_action", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        if (!this.coordActionModel) throw new Error("Coord action model not initialized");
        const actionType = String(state.actionType || "");
        const schema = getExecutorActionSchema(actionType);
        if (!schema) throw new Error(`No action args schema for actionType: ${actionType}`);

        // Action model sees RAW screenshot only (no overlay)
        const base64ForActionModel = state.rawScreenshotB64 || state.screenshotB64 || "";
        const prompt = buildCoordActionArgsPrompt({
          actionType,
          instructionForUser: String(state.instructionForUser || ""),
        });

        const llm = (this.coordActionModel as any).withStructuredOutput(schema, { method: "jsonSchema" });
        const res = await llm.invoke([
          new SystemMessage(prompt),
          new HumanMessage({
            content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${base64ForActionModel}` } }],
          } as any),
        ]);

        // console.log(res);

        const parsed = schema.safeParse(res);
        if (!parsed.success) {
          throw new Error(`Action model structured output parse failed for ${actionType}: ${parsed.error}`);
        }
        const args = parsed.data;
        const displayText =
          `Action Args (from Action Model):\n` +
          `- actionType: ${actionType}\n` +
          `- args: ${JSON.stringify(args ?? {}, null, 2)}`;

        return {
          plannedToolName: actionType,
          plannedToolArgs: args,
          plannedToolDisplayText: displayText,
        };
      })
      .addNode("call_text_action", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const actionType = String(state.actionType || "");
        const planned = await this.prepareTextActionArgs({
          actionType,
          instruction: String(state.instructionForUser || ""),
          signal,
        });
        return {
          plannedToolName: planned.actionType, // reuse existing state keys
          plannedToolArgs: planned.args,
          plannedToolDisplayText: planned.displayText,
        };
      })
      .addNode("plan_overlay", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const actionType = String(state.plannedToolName || state.actionType || "");
        const args = (state.plannedToolArgs ?? {}) as any;
        const pending = computePendingOverlay({
          actionType,
          args,
          modelImageWidth: state.modelW || 0,
          modelImageHeight: state.modelH || 0,
        });
        if (pending) this.pendingScreenshotOverlay = pending;
        return {};
      })
      .addNode("execute", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        await this.executePlannedAction({
          actionType: state.plannedToolName,
          args: state.plannedToolArgs,
          modelImageWidth: state.modelW || 0,
          modelImageHeight: state.modelH || 0,
          scaleFactor: state.scaleFactor || 1,
          signal,
        });

        const imageSrc = `data:image/png;base64,${state.screenshotB64 || ""}`;
        // Text-only event. Images are streamed via `agent-image`.
        this.sendToMain("agent-action-plan", { text: state.plannedToolDisplayText || "" });
        this.sendToMain("agent-image", { image: imageSrc });
        return {};
      })

      .addNode("sleep", async () => {
      // After executing an action, continuously capture screenshots and wait until the screen is stable.
      // Mirror `screendiff.py` logic: MSE -> causal EMA(alpha=0.3) -> log1p; stable when log <= 0.2 for >=0.5s.
      // Give up after 5s and proceed anyway.
      const waitResult = await waitForScreenStability({
        signal,
        fps: 20,
        alpha: 0.5,
        logThreshold: 1.0,
        stableDurationMs: 200,
        maxWaitMs: 2000,
      });
      console.log(waitResult);

        return {};
      })
      .addEdge(START, "capture")
      .addConditionalEdges(
        "capture",
        (state: PigletStateType) => {
          // After a terminal action we go manage_terminal_use_history, otherwise manage_computer_use_history.
          return state.actionType === "terminal_task"
            ? "manage_terminal_use_history"
            : "manage_computer_use_history";
        },
        ["manage_terminal_use_history", "manage_computer_use_history"],
      )
      .addEdge("manage_computer_use_history", "timer_node")
      .addEdge("manage_terminal_use_history", "timer_node")
      .addEdge("timer_node", "call_advanced")
      .addConditionalEdges(
        "call_advanced",
        (state: PigletStateType) => {
          const at = state.actionType;
          if (at === "terminal_task") return "call_terminal_action";
          if (at === "finished"){
            this.sendToMain("task-finished");
            return END;
          }
          if (at && ["hotkey", "type", "wait"].includes(at)) return "call_text_action";
          return "call_coord_action";
        },
        ["call_terminal_action", "call_text_action", "call_coord_action", END],
      )
      .addEdge("call_terminal_action", "capture")
      .addEdge("call_coord_action", "plan_overlay")
      .addEdge("call_text_action", "plan_overlay")
      .addEdge("plan_overlay", "pre_capture")
      .addEdge("pre_capture", "execute")
      .addEdge("execute", "sleep")
      .addEdge("sleep", "capture")
      .compile();

    const estimatedNodesPerLoop = 24; // terminal + coord/text + overlay + capture + pre_capture + execute + sleep...
    const maxSteps = 60;
    const recursionLimit = Math.max(400, maxSteps * estimatedNodesPerLoop + 100);

    await graph.invoke(
      {
        userQuery: instruction,
        step: 0,
        advancedHistory: [],
      } as any,
      { recursionLimit } as any,
    );
  }

  // screenshot + overlay helpers moved to utils.ts
  private async selectAdvancedRulesPrompt(query: string) {
    if (!query || !query.trim()) return "";
    const alwaysInject = (this.currentConfig?.rules || [])
      .filter((r: any) => r && !!r.enabled && !!(r.alwaysInject ?? false) && (r.content || "").trim().length > 0)
      .map((r: any) => (r.content || "").trim());

    let dynamic = "";
    if (this.advancedRuleSelector) {
      try {
        const selected = await this.advancedRuleSelector.selectExamples({ input: query });
        const parts = (selected || [])
          .map((ex: any) => String((ex?.content ?? ex?.input ?? "")).trim())
          .filter((s: string) => s.length > 0);
        dynamic = parts.join("\n\n");
      } catch (e) {
        console.warn("[advancedRuleSelector] selectExamples failed, skip dynamic rules injection.", e);
        dynamic = "";
      }
    }

    const parts = [...(dynamic ? [dynamic] : []), ...alwaysInject].filter((x) => x && x.trim().length > 0);
    // simple de-dup
    const dedup: string[] = [];
    const seen = new Set<string>();
    for (const p of parts) {
      if (seen.has(p)) continue;
      seen.add(p);
      dedup.push(p);
    }
    return dedup.join("\n\n");
  }

  private buildComputerUseHistoryForThisTurn(opts: {
    step: number;
    screenshotBase64: string;
    rawScreenshotBase64: string;
    userQuery: string;
    advancedExtraPrompt: string;
    pass_history: BaseMessage[];
  }): BaseMessage[] {
    const { step, screenshotBase64, rawScreenshotBase64, userQuery, advancedExtraPrompt, pass_history } = opts;

    let history = [...pass_history];

    if (step <= 0) {
      const systemPrompt = buildAdvancedSystemPrompt({ advancedExtraPrompt, userQuery });

      history = [...this.advancedHistory, new SystemMessage(systemPrompt)];

      const msg = new HumanMessage({
        content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${rawScreenshotBase64}` } }],
      } as any);


      return [...history, msg];
    }

    const prompt = buildAdvancedFollowupPrompt({ advancedExtraPrompt });

    const msg = new HumanMessage({
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotBase64}` } },
        { type: "image_url", image_url: { url: `data:image/png;base64,${rawScreenshotBase64}` } },
        { type: "text", text: prompt },
      ],
    } as any);


    return [...history, msg];
  }

  private async callAdvancedStructured(history: BaseMessage[]): Promise<ThoughtResponse> {
    if (!this.advancedModel) throw new Error("Advanced model not initialized");
    const base = this.advancedModel as any;
    const llm = base.withStructuredOutput(ThoughtResponseSchema, { method: "jsonSchema" });
    // const llm = base.withStructuredOutput(ThoughtResponseSchema, { method: "jsonMode" });


    let res: any;
    res = await llm.invoke(history);

    // when withStructuredOutput is available, res is already an object; otherwise it is a message
    if (typeof res === "object" && res && "Thought" in res && "Instruction" in res && "ActionType" in res) {
      return res as ThoughtResponse;
    }
    // fallback: try parse as JSON (best-effort)
    try {
      const obj = JSON.parse((res?.content ?? "").toString());
      return ThoughtResponseSchema.parse(obj);
    } catch {
      return { Thought: "", Instruction: "", ActionType: "click" };
    }
  }

  private async prepareTextActionArgs(opts: {
    actionType: string;
    instruction: string;
    signal: AbortSignal;
  }): Promise<{ actionType: string; args: any; displayText: string }> {
    // Text-only action arg extraction
    if (!this.textActionModel) throw new Error("Text action model not initialized");
    const { actionType, instruction, signal } = opts;
    if (signal.aborted) throw new Error("Aborted");

    const schema = getExecutorActionSchema(actionType);
    if (!schema) throw new Error(`No executor args schema for actionType: ${actionType}`);


    const systemPrompt = buildTextActionArgsSystemPrompt({
      actionType,
      instruction,
    });

    const base = this.textActionModel as any;
    const llm = base.withStructuredOutput(schema, { method: "jsonSchema" });
    const res = await llm.invoke([new SystemMessage(systemPrompt)]);
    const parsed = schema.safeParse(res);
    if (!parsed.success) {
      throw new Error(`Executor structured output parse failed for ${actionType}: ${parsed.error}`);
    }
    const args = parsed.data;
    const displayText =
      `Action Args:\n` +
      `- actionType: ${String(actionType || "")}\n` +
      `- args: ${JSON.stringify(args ?? {}, null, 2)}`;

    return { actionType, args, displayText };
  }

  private async executePlannedAction(opts: {
    actionType: string;
    args: any;
    modelImageWidth: number;
    modelImageHeight: number;
    scaleFactor: number;
    signal: AbortSignal;
  }): Promise<void> {
    const { actionType, args, modelImageWidth, modelImageHeight, scaleFactor, signal } = opts;
    await executeUiTarsActionFromObj({
      actionType: String(actionType || ""),
      args: args ?? {},
      modelImageWidth,
      modelImageHeight,
      scaleFactor,
      signal,
      sendToOverlay: (channel, payload) => this.sendToOverlay(channel, payload),
    });
  }
  // NOTE: executor action execution no longer uses tool calling.
  // We use per-action structured schemas + executeUiTarsActionFromObj instead.

  // action parsing/execution moved to utils.ts
}
