export function buildAdvancedSystemPrompt(opts: { advancedExtraPrompt: string; userQuery: string }) {
  const { advancedExtraPrompt, userQuery } = opts;
  // EXACT copy of tutorial.py system_prompt (except string interpolation)
  const systemPromptTemplate = `You are a GUI agent. You are given a task and action history, with screenshots of user's current screen. You need to perform the next action to complete the task. 

# ## Note
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
{advanced_extra}

# ## User Instruction
{user_query}
`;

  return systemPromptTemplate
    .replace("{advanced_extra}", advancedExtraPrompt || "")
    .replace("{user_query}", userQuery);
}

export function buildAdvancedFollowupPrompt(opts: { advancedExtraPrompt: string }) {
  const { advancedExtraPrompt } = opts;
  // tutorial.py follow-up prompt EXACT
  const promptTemplate =
    "这是user执行过上一次操作后的屏幕截图，请你继续指示下一步操作(***注意务必根据当前截图判断用户上一部是否正确的执行了要求的操作！如果没有请你继续换一种请你换一种指式方法/想想其他办法/更详细的描述来操作上一步。) ##Related Prompts:\n{}";
  return promptTemplate.replace("{}", advancedExtraPrompt || "");
}

export function buildActionPrompt(opts: { thought: string; extraPrompt?: string }) {
  const { thought, extraPrompt } = opts;
  // Keep EXACT content as dualAgent.ts (action prompt should not inject any rules)
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
type(content='')
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

export function buildExecutorSystemPrompt(opts: { instruction: string }) {
  const { instruction } = opts;
  // Mirror tutorial.py node_execute_action tool_prompt (核心约束一致 + 禁止擅自追加 \\n)
  return `You are a tool-calling translator for a GUI automation system.

You will be given a computer actioninstruction
Your ONLY job: convert instruction into EXACTLY ONE tool call using the available tools.

## Strict rules
- You MUST call exactly ONE tool.
- Do NOT output any extra text besides the tool call.
- Do NOT change the meaning of the instruction.
- Preserve coordinates and parameters EXACTLY if they exist in the input.
- Do NOT append "\\n" to typed content unless the instruction explicitly requires submission/pressing enter.
- Even if the instructions contain two consecutive actions, you can only output one action at a time.
- For example, if the instruction is "type 'xxx' and press enter", you should only call type tool and ignore the press enter part.
- You must 100% follow the instruction strictly, if instructions tell you to press whichever keyboard shortcut you must do 100% the same.

## Inputs/Instruction:
${instruction}`;
}


