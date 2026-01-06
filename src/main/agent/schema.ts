import * as z from "zod";

export const ACTION_TYPES = [
  "click",
  "left_double",
  "right_single",
  "drag",
  "hotkey",
  "type",
  "scroll",
  "wait",
  "finished",
  "terminal_task",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export const ThoughtResponseSchema = z.object({
  Thought: z
    .string()
    .describe(
      "what have you see in the screenshot and based on that, your thought on what should you do next to complete the task/why",
    ),
  Instruction: z.string().describe("clear and short instruction to the user, in chinese"),
  ActionType: z.enum(ACTION_TYPES).describe("left_double is double click, right_single is right click!"),
});
export type ThoughtResponse = z.infer<typeof ThoughtResponseSchema>;

// ---------- Terminal tool schema ----------
export const TerminalRunSchema = z.object({ command: z.string().min(1) });

// ---------- Executor tool schemas ----------
export const ClickSchema = z.object({
  x: z.number().int().describe("X coordinate in PIXELS on the current screenshot (model image space)."),
  y: z.number().int().describe("Y coordinate in PIXELS on the current screenshot (model image space)."),
});
export const DragSchema = z.object({
  start_x: z.number().int().describe("Drag start X in PIXELS on the current screenshot."),
  start_y: z.number().int().describe("Drag start Y in PIXELS on the current screenshot."),
  end_x: z.number().int().describe("Drag end X in PIXELS on the current screenshot."),
  end_y: z.number().int().describe("Drag end Y in PIXELS on the current screenshot."),
});
export const HotkeySchema = z.object({
  key: z
    .string()
    .describe("Hotkey string, keep original order. Examples: 'command+shift+3', 'option+command+h', 'enter'."),
});
export const TypeSchema = z.object({
  content: z
    .string()
    .describe("Text to type. Do NOT append \\n unless explicitly required to submit/press enter."),
});
export const ScrollDirectionSchema = z.enum(["down", "up", "left", "right"]);
export const ScrollSchema = z.object({
  x: z.number().int().describe("Scroll target X in PIXELS on the current screenshot."),
  y: z.number().int().describe("Scroll target Y in PIXELS on the current screenshot."),
  direction: ScrollDirectionSchema.describe("Scroll direction."),
  magnitude: z
    .number()
    .int()
    .min(1)
    .max(10)
    .nullable()
    .describe("Scroll amount multiplier. 1=smallest, 10=largest."),
});
export const WaitSchema = z.object({}).describe("Wait action (no args).");
export const FinishedSchema = z.object({
  content: z.string().optional().describe("Optional final summary to user."),
});

export const ExecutorActionSchemas = {
  click: ClickSchema,
  left_double: ClickSchema,
  right_single: ClickSchema,
  drag: DragSchema,
  hotkey: HotkeySchema,
  type: TypeSchema,
  scroll: ScrollSchema,
  wait: WaitSchema,
  finished: FinishedSchema,
} as const;

export type ExecutorActionType = keyof typeof ExecutorActionSchemas;

export function getExecutorActionSchema(actionType: string) {
  return (ExecutorActionSchemas as any)[actionType] as z.ZodTypeAny | undefined;
}



