import { BrowserWindow } from 'electron';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { SemanticSimilarityExampleSelector } from '@langchain/core/example_selectors';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { HumanMessage, SystemMessage, type BaseMessage, AIMessage } from '@langchain/core/messages';
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { tool } from 'langchain';
import * as z from 'zod';
import {
  buildActionPrompt,
  buildAdvancedFollowupPrompt,
  buildAdvancedSystemPrompt,
  buildExecutorSystemPrompt,
} from './promptTemplate';
import {
  captureScreenB64,
  computePendingOverlayFromToolCall,
  executeUiTarsAction,
  escapeSingleQuotes,
  getExecutorToolSchemaText,
  resetRobotInputState,
  selfTestMouseMovement,
  sleep,
  type PendingScreenshotOverlay,
} from './utils';
import type { AppConfig } from '../store';

export interface TaskStartPayload {
  instruction: string;
  config: AppConfig;
}

// NOTE: helpers (sleep/mapKey/escapeSingleQuotes/screenshot/action exec) moved to ./utils

const ACTION_TYPES = [
  "click",
  "left_double",
  "right_single",
  "drag",
  "hotkey",
  "type",
  "scroll",
  "wait",
  "finished",
] as const;

const ThoughtResponseSchema = z.object({
  // 对齐 tutorial.py 的 Pydantic Field(description=...)
  Thought: z.string().describe("what have you see in the screenshot and based on that, your thought on what should you do next to complete the task/why"),
  Instruction: z.string().describe("clear and short instruction to the user, in chinese"),
  // View: z.string(),
  ActionType: z
    .enum(ACTION_TYPES)
    .describe(
      "left_double is double click, right_single is right click! Make sure dont use click when you need to double click(some very common action like open file need to use double click)",
    ),
});

type ThoughtResponse = z.infer<typeof ThoughtResponseSchema>;

const VerityResponseSchema = z.object({
  Think: z.string(),
  Correctness: z.boolean(),
});
type VerityResponse = z.infer<typeof VerityResponseSchema>;

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

  actionPrompt: Ann({ default: () => undefined }),
  actionResponseText: Ann({ default: () => undefined }),
  actionLine: Ann({ default: () => undefined }),

  finalInstructionForExecutor: Ann({ default: () => undefined }),
  finished: Ann({ default: () => undefined }),

  // Executor planned tool call (computed before executing)
  plannedToolName: Ann({ default: () => undefined }),
  plannedToolArgs: Ann({ default: () => undefined }),
  plannedToolDisplayText: Ann({ default: () => undefined }),

  verityThink: Ann({ default: () => undefined }),
  verityCorrectness: Ann({ default: () => undefined }),
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
  private actionModel: ChatOpenAI | null = null;
  private executorModel: ChatOpenAI | null = null;
  private advancedHistory: BaseMessage[] = [];
  private mainWindow: BrowserWindow;
  private overlayWindow: BrowserWindow;
  // LangChain 原生机制：语意相似规则选择器（只用于 Advanced rules 动态注入）
  private advancedRuleSelector: SemanticSimilarityExampleSelector<any> | null = null;
  
  // Abort Controller for immediate stopping
  private abortController: AbortController | null = null;
  
  // Current Configuration
  private currentConfig: AppConfig | null = null;
  
  // Track repetitive actions
  private lastActionResponse: string = '';
  private repeatActionCount: number = 0;

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
    this.lastActionResponse = '';
    this.repeatActionCount = 0;
    
    // Initialize LangChain models with new config
    try {
        this.advancedModel = new ChatOpenAI({
            model: config.advancedModel.modelName,
            apiKey: config.advancedModel.apiKey,
            configuration: { baseURL: config.advancedModel.baseUrl },
            temperature: 0,
            // We implement our own bounded retry for advanced structured output.
            // Disable internal exponential backoff retries to avoid long stalls on flaky providers.
            maxRetries: 0,
        });
        
        this.actionModel = new ChatOpenAI({
            model: config.actionModel.modelName,
            apiKey: config.actionModel.apiKey,
            configuration: { baseURL: config.actionModel.baseUrl },
            temperature: 0,
        });

        this.executorModel = new ChatOpenAI({
            model: config.executorModel.modelName,
            apiKey: config.executorModel.apiKey,
            configuration: { baseURL: config.executorModel.baseUrl },
            temperature: 0,
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
    if (!this.advancedModel || !this.actionModel || !this.executorModel) {
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
      .addNode("build_thought_prompt", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const step = state.step || 0;
        const queryForRules = step <= 0 ? state.userQuery : (state.thoughtResponse || "");
        const advancedExtraPrompt = await this.selectAdvancedRulesPrompt(queryForRules);

        // Rehydrate advanced history from state, then build new history for this turn
        this.advancedHistory = (state.advancedHistory || []) as any;
        const history = this.buildThoughtHistoryForThisTurn({
          step,
          screenshotBase64: state.screenshotB64 || "",
          rawScreenshotBase64: state.rawScreenshotB64 || "",
          userQuery: state.userQuery,
          advancedExtraPrompt,
        });

        return { advancedHistory: history };
      })
      .addNode("call_advanced", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const history = (state.advancedHistory || []) as any as BaseMessage[];
        const res = await this.callAdvancedStructured(history);

        // tutorial.py: push AIMessage(content=Thought) into history
        const updatedHistory = [...history, new AIMessage(res.Thought)];

        // Fix: type action should NOT accidentally add trailing \\n (unless explicitly asked)
        let instr = (res.Instruction || "").toString();

        const thoughtDisplay =
          `Thought: ${res.Thought}\n` + `Instruction: ${instr}\n` + `ActionType: ${res.ActionType}`;
        
        const imageSrc = `data:image/png;base64,${state.rawScreenshotB64 || ""}`;

        this.sendToMain("agent-thought", { text: thoughtDisplay, image: imageSrc });

        return {
          thoughtResponse: res.Thought,
          instructionForUser: instr,
          actionType: res.ActionType,
          advancedHistory: updatedHistory,
        };
      })
      .addNode("build_action_prompt", async (state: PigletStateType) => {
        return { actionPrompt: buildActionPrompt({ thought: state.instructionForUser || "", extraPrompt: "" }) };
      })
      .addNode("call_action", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        // Action 模型看到的截图：不带 overlay
        const base64ForActionModel = state.rawScreenshotB64 || state.screenshotB64 || "";
        const prompt = state.actionPrompt || "";
        const text = await this.callActionV2(base64ForActionModel, prompt);

        const actionLine = text.match(/Action:\s*(.*)/)?.[1] || "";
        if (actionLine === this.lastActionResponse) {
          this.repeatActionCount++;
      } else {
          this.repeatActionCount = 1;
          this.lastActionResponse = actionLine;
        }

        return {
          actionResponseText: text,
          actionLine,
          finalInstructionForExecutor: `Instruction: ${state.instructionForUser || ""}\nAction: ${actionLine}`,
        };
      })
      .addNode("build_executor_input", async (state: PigletStateType) => {
        const actionType = state.actionType || "click";
        return {
          finalInstructionForExecutor: `Instruction: ${state.instructionForUser || ""}\nActionType: ${actionType}`,
        };
      })
      .addNode("plan_overlay", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const planned = await this.prepareExecutorToolCall({
          instruction: state.finalInstructionForExecutor || "",
          modelImageWidth: state.modelW || 0,
          modelImageHeight: state.modelH || 0,
          scaleFactor: state.scaleFactor || 1,
          signal,
        });

        const pending = computePendingOverlayFromToolCall({
          toolName: planned.toolName,
          args: planned.toolArgs,
          modelImageWidth: state.modelW || 0,
          modelImageHeight: state.modelH || 0,
        });
        if (pending) this.pendingScreenshotOverlay = pending;

        return {
          plannedToolName: planned.toolName,
          plannedToolArgs: planned.toolArgs,
          plannedToolDisplayText: planned.displayText,
        };
      })
//       .addNode("verity", async (state: PigletStateType) => {
//         if (signal.aborted) throw new Error("Aborted");
//         if (!this.currentConfig) throw new Error("Config not initialized");

//         const screenshotB64 = state.screenshotB64 || "";
//         const instructionForUser = (state.instructionForUser || "").toString();
//         const actionType = (state.actionType || "").toString();
//         const thoughtResponse = (state.thoughtResponse || "").toString();

//         // NOTE: verity is a single-shot check (no history). Reuse advanced model settings, but create a fresh client.
//         const verityModel = new ChatOpenAI({
//           model: this.currentConfig.advancedModel.modelName,
//           apiKey: this.currentConfig.advancedModel.apiKey,
//           configuration: { baseURL: this.currentConfig.advancedModel.baseUrl },
//           temperature: 0,
//         });
// // Be extremely strict: if there is ANY ambiguity, any off-by-a-bit, or it might click the wrong element, return Correctness=false.

//         const systemPrompt = `You are a strict GUI action verifier.
// You will be given:
// - The user's target instruction (InstructionForUser)
// - The intended action type (ActionType)
// - The previous thought (ThoughtResponse)
// - A screenshot where an overlay marks the intended action target/location.

// Your job: Determine whether the overlay-marked target/location EXACTLY matches the intended target described by InstructionForUser/ThoughtResponse.
// Only return Correctness=true if you are fully confident the overlay indicates the correct UI element with no deviation.

// Return a structured response with:
// - Think: your reasoning about whether it matches (be concise but concrete)
// - Correctness: true/false`;

//         const humanText = `InstructionForUser:\n${instructionForUser}\n\nActionType:\n${actionType}\n\nThoughtResponse:\n${thoughtResponse}`;

//         const invokeOnce = async (method: "functionCalling" | "jsonMode") => {
//           const llm = (verityModel as any).withStructuredOutput(VerityResponseSchema, { method });
//           return await llm.invoke([
//             new SystemMessage(systemPrompt),
//             new HumanMessage({
//               content: [
//                 { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotB64}` } },
//                 { type: "text", text: humanText },
//               ],
//             } as any),
//           ]);
//         };

//         let res: any;
//         try {
//           res = await invokeOnce("functionCalling");
//         } catch (e: any) {
//           console.warn("[verity] functionCalling failed, falling back to jsonMode.", e?.message ?? e);
//           res = await invokeOnce("jsonMode");
//         }

//         const parsed = VerityResponseSchema.safeParse(res);

//         if (!parsed.success) {
//           // If parsing fails, be safe: treat as incorrect so we try to re-plan.
//           console.warn("[verity] Failed to parse structured output, treating as incorrect.", parsed.error);
//           return { verityThink: "", verityCorrectness: false };
//         }
//         console.log("[verity] parsed", parsed.data.Think);
//         console.log("[verity] res", parsed.data.Correctness);

//         return { verityThink: parsed.data.Think, verityCorrectness: parsed.data.Correctness };
//       })
      .addNode("execute", async (state: PigletStateType) => {
        if (signal.aborted) throw new Error("Aborted");
        const exec = await this.executePlannedToolCall({
          toolName: state.plannedToolName,
          toolArgs: state.plannedToolArgs,
          modelImageWidth: state.modelW || 0,
          modelImageHeight: state.modelH || 0,
          scaleFactor: state.scaleFactor || 1,
          signal,
        });

        const imageSrc = `data:image/png;base64,${state.screenshotB64 || ""}`;
        this.sendToMain("agent-action-plan", { text: state.plannedToolDisplayText || "", image: imageSrc });

        const at = state.actionType;
        const alsoFinished =
          exec.finished ||
          (state.actionLine || "").includes("finished") ||
          at === "finished";

        return { finished: alsoFinished };
      })
      .addNode("post", async (state: PigletStateType) => {
        // IMPORTANT: when task is finished (Action: finished), notify renderer to flip UI state back.
        if (state.finished) {
          this.sendToMain("task-finished");
          return { finished: true };
        }
        return { step: (state.step || 0) + 1 };
      })
      .addNode("sleep", async () => {
      await sleep(800, signal);
        return {};
      })
      .addEdge(START, "capture")
      .addEdge("capture", "build_thought_prompt")
      .addEdge("build_thought_prompt", "call_advanced")
      .addConditionalEdges(
        "call_advanced",
        (state: PigletStateType) => {
          const at = state.actionType;
          if (at && ["hotkey", "type", "finished", "wait"].includes(at)) return "build_executor_input";
          return "build_action_prompt";
        },
        ["build_executor_input", "build_action_prompt"],
      )
      .addEdge("build_action_prompt", "call_action")
      .addEdge("call_action", "plan_overlay")
      .addEdge("build_executor_input", "plan_overlay")
      .addEdge("plan_overlay", "pre_capture")
      // .addConditionalEdges(
      //   "pre_capture",
      //   (state: PigletStateType) => {
      //     const at = state.actionType;
      //     // Only verity-check actions that require target localization via overlay.
      //     if (at && ["hotkey", "type", "finished", "wait"].includes(at)) return "execute";
      //     return "verity";
      //   },
      //   ["execute", "verity"],
      // )
      // .addConditionalEdges(
      //   "verity",
      //   (state: PigletStateType) => (state.verityCorrectness ? "execute" : "build_action_prompt"),
      //   ["execute", "build_action_prompt"],
      // )
      .addEdge("pre_capture", "execute")
      .addEdge("execute", "post")
      .addConditionalEdges(
        "post",
        (state: PigletStateType) => (state.finished ? END : "sleep"),
        [END, "sleep"],
      )
      .addEdge("sleep", "capture")
      .compile();

    // LangGraph 默认 recursionLimit=25（按“节点执行次数”计，不是按“轮数”计）
    // 我们每一轮会跑多个节点（capture/build/call/execute/post/sleep...），所以需要显式提高上限。
    const estimatedNodesPerLoop = 30; // added verity + conditional branches
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

  private buildThoughtHistoryForThisTurn(opts: {
    step: number;
    screenshotBase64: string;
    rawScreenshotBase64: string;
    userQuery: string;
    advancedExtraPrompt: string;
  }): BaseMessage[] {
    const { step, screenshotBase64, rawScreenshotBase64, userQuery, advancedExtraPrompt } = opts;

    let history = [...this.advancedHistory];

    if (step <= 0) {
      const systemPrompt = buildAdvancedSystemPrompt({ advancedExtraPrompt, userQuery });

      history = [new SystemMessage(systemPrompt)];

      const msg = new HumanMessage({
        content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${rawScreenshotBase64}` } }],
      } as any);
      return [...history, msg];
    }

    // tutorial.py: if len(history) > 10, delete first 2 (excluding first SystemMessage)
    if (history.length > 15) {
      history = [history[0], ...history.slice(3)];
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
    const llm = base.withStructuredOutput(ThoughtResponseSchema, { method: "functionCalling" });

    // Bounded retry (no exponential backoff): try up to 3 times.
    // We intentionally avoid jsonMode fallback here.
    let res: any;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        res = await llm.invoke(history);
        break;
      } catch (e: any) {
        if (attempt >= maxAttempts) throw e;
        console.warn(
          `[callAdvancedStructured] functionCalling failed (attempt ${attempt}/${maxAttempts}); retrying...`,
          e?.message ?? e,
        );
        // Fixed delay to avoid tight-looping; no exponential backoff
        await sleep(100);
      }
    }
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

  private async callActionV2(base64Image: string, prompt: string) {
    if (!this.actionModel) throw new Error("Action model not initialized");
    const msg = new HumanMessage({
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
        { type: "text", text: prompt },
      ],
    } as any);
    
    const maxAttempts = 2;
    let last = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ai = await this.actionModel.invoke([msg]);
      last = ((ai.content as any) || "").toString();
      if (last.includes("Action:")) return last;
      console.warn(`[ActionModel] Missing "Action:" in response (attempt ${attempt}/${maxAttempts}). Retrying once...`, last);
    }
    return last;
  }

  private async prepareExecutorToolCall(opts: {
    instruction: string;
    modelImageWidth: number;
    modelImageHeight: number;
    scaleFactor: number;
    signal: AbortSignal;
  }): Promise<{ toolName: string; toolArgs: any; displayText: string }> {
    if (!this.executorModel) throw new Error("Executor model not initialized");
    const { instruction, modelImageWidth, modelImageHeight, scaleFactor, signal } = opts;

    // NOTE: LangChain tool typings can get extremely deep in TS; keep runtime behavior but erase types.
    const toolsByName = this.buildExecutorTools({
      modelImageWidth,
      modelImageHeight,
      scaleFactor,
      signal,
    }) as Record<string, any>;
    const tools = Object.values(toolsByName) as any[];
    const modelWithTools = (this.executorModel as any).bindTools
      ? (this.executorModel as any).bindTools(tools as any)
      : this.executorModel;

    const systemPrompt = buildExecutorSystemPrompt({ instruction });
    const ai = await modelWithTools.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage("Convert action_text into exactly one tool call(make sure match the action type). You will see something in this format '(start_box='<|box_start|>(x,y)<|box_end|>'), please follow the coordinate strictly, first is x , second is y ."),
    ]);

    const toolCalls =
      (ai as any).tool_calls ||
      (ai as any).additional_kwargs?.tool_calls ||
      (ai as any).additional_kwargs?.toolCalls ||
      [];

    if (!toolCalls.length) {
      throw new Error("Executor model did not call any tool.");
    }

    const call = toolCalls[0];
    const name = call.name;
    const args = call.args ?? call.arguments ?? {};
    const schema = getExecutorToolSchemaText(String(name || ""));
    const displayText =
      `Tool Call:\n` +
      `- name: ${String(name || "")}\n` +
      `- args: ${JSON.stringify(args ?? {}, null, 2)}`;

    return { toolName: String(name || ""), toolArgs: args, displayText };
  }

  private async executePlannedToolCall(opts: {
    toolName: string;
    toolArgs: any;
    modelImageWidth: number;
    modelImageHeight: number;
    scaleFactor: number;
    signal: AbortSignal;
  }): Promise<{ finished: boolean }> {
    if (!this.executorModel) throw new Error("Executor model not initialized");
    const { toolName, toolArgs, modelImageWidth, modelImageHeight, scaleFactor, signal } = opts;

    const toolsByName = this.buildExecutorTools({
      modelImageWidth,
      modelImageHeight,
      scaleFactor,
      signal,
    }) as Record<string, any>;

    const toolImpl = (toolsByName as any)[toolName];
    if (!toolImpl) {
      throw new Error(`Unknown tool called by executor model: ${toolName}`);
    }
    const result = await toolImpl.invoke(toolArgs ?? {});
    const finished = !!(result && (result as any).finished);
    return { finished };
  }




  // Executor tools Builder
  private buildExecutorTools(opts: {
    modelImageWidth: number;
    modelImageHeight: number;
    scaleFactor: number;
    signal: AbortSignal;
  }): Record<string, any> {
    const { modelImageWidth, modelImageHeight, scaleFactor, signal } = opts;
    const act = async (action: string) => {
      const { pendingOverlay } = await executeUiTarsAction({
        actionResponse: action,
        modelImageWidth,
        modelImageHeight,
        scaleFactor,
        signal,
        sendToOverlay: (channel, payload) => this.sendToOverlay(channel, payload),
      });
      // NOTE: pending overlay is computed in a dedicated LangGraph node BEFORE execute.
      // Execute tool should be side-effect only (do NOT compute/update pending overlay here).
      return { ok: true };
    };

    const click: any = tool(
      async ({ x, y }: { x: number; y: number }) =>
        act(`Action: click(start_box='<|box_start|>(${x}, ${y})<|box_end|>')`),
      {
        name: "click",
        description: "Left click once at (x, y). Coordinates are PIXELS in the current screenshot.",
        schema: z.object({ x: z.number().int(), y: z.number().int() }) as any,
      },
    ) as any;

    const left_double: any = tool(
      async ({ x, y }: { x: number; y: number }) =>
        act(`Action: left_double(start_box='<|box_start|>(${x}, ${y})<|box_end|>')`),
      {
        name: "left_double",
        description: "Left double click at (x, y). Coordinates are PIXELS in the current screenshot.",
        schema: z.object({ x: z.number().int(), y: z.number().int() }) as any,
      },
    ) as any;

    const right_single: any = tool(
      async ({ x, y }: { x: number; y: number }) =>
        act(`Action: right_single(start_box='<|box_start|>(${x}, ${y})<|box_end|>')`),
      {
        name: "right_single",
        description: "Right click once at (x, y). Coordinates are PIXELS in the current screenshot.",
        schema: z.object({ x: z.number().int(), y: z.number().int() }) as any,
      },
    ) as any;

    const drag: any = tool(
      async ({
        start_x,
        start_y,
        end_x,
        end_y,
      }: {
        start_x: number;
        start_y: number;
        end_x: number;
        end_y: number;
      }) =>
        act(
          `Action: drag(start_box='<|box_start|>(${start_x}, ${start_y})<|box_end|>', end_box='<|box_start|>(${end_x}, ${end_y})<|box_end|>')`,
        ),
      {
        name: "drag",
        description: "Drag from (start_x, start_y) to (end_x, end_y). Coordinates are PIXELS in the current screenshot.",
        schema: z.object({
          start_x: z.number().int(),
          start_y: z.number().int(),
          end_x: z.number().int(),
          end_y: z.number().int(),
        }) as any,
      },
    ) as any;

    const hotkey: any = tool(
      async ({ key }: { key: string }) => act(`Action: hotkey(key='${escapeSingleQuotes(key)}')`),
      {
        name: "hotkey",
        description: "Press a keyboard shortcut. Example: key='cmd+f' or key='ctrl+v' or key='enter'.",
        schema: z.object({ key: z.string() }) as any,
      },
    ) as any;

    const type: any = tool(
      async ({ content }: { content: string }) =>
        act(`Action: type(content='${escapeSingleQuotes(content)}')`),
      {
        name: "type",
        description: "Type text into the currently focused input.",
        schema: z.object({ content: z.string() }) as any,
      },
    ) as any;

    const scroll: any = tool(
      async ({
        x,
        y,
        direction,
        magnitude,
      }: {
        x: number;
        y: number;
        direction: "down" | "up" | "left" | "right";
        magnitude?: number;
      }) =>
        act(
          `Action: scroll(start_box='<|box_start|>(${x}, ${y})<|box_end|>', direction='${direction}'${
            magnitude != null ? `, magnitude=${Math.trunc(magnitude)}` : ""
          })`,
        ),
      {
        name: "scroll",
        description:
          "Scroll at (x, y) towards the given direction. Coordinates are PIXELS in the current screenshot. magnitude controls scroll amount (default is 1). You should make this decision based on the task",
        schema: z.object({
          x: z.number().int(),
          y: z.number().int(),
          direction: z.enum(["down", "up", "left", "right"]),
          magnitude: z.number().int().min(1).max(10).optional(),
        }) as any,
      },
    ) as any;

    const wait: any = tool(async () => act("Action: wait()"), {
      name: "wait",
      description: "Wait for 5 seconds (then the next loop will take a new screenshot).",
      schema: z.object({}) as any,
    }) as any;

    const finished: any = tool(async ({ content }: { content?: string }) => ({ finished: true, content }), {
      name: "finished",
      description: "Finish the task. content is optional.",
      schema: z.object({ content: z.string().optional() }) as any,
    }) as any;

    return {
      click,
      left_double,
      right_single,
      drag,
      hotkey,
      type,
      scroll,
      wait,
      finished,
    };
  }

  // action parsing/execution moved to utils.ts
}
