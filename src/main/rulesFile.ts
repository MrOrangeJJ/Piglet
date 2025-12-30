import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import * as z from "zod";

const RuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().default("Rule"),
  content: z.string().default(""),
  enabled: z.boolean().default(true),
  alwaysInject: z.boolean().default(false),
});

const RulesFileSchema = z.object({
  version: z.literal(2),
  rules: z.array(RuleSchema).default([]),
});

export type RulesFile = z.infer<typeof RulesFileSchema>;
export type RulePrompt = z.infer<typeof RuleSchema>;

export function getRulesJsonPath() {
  const dir = app.getPath("userData");
  return path.join(dir, "rules.json");
}

export function loadRulesFromFile(): RulePrompt[] {
  const filePath = getRulesJsonPath();
  try {
    if (!fs.existsSync(filePath)) {
      const init: RulesFile = { version: 2, rules: [] };
      fs.writeFileSync(filePath, JSON.stringify(init, null, 2), "utf-8");
      return [];
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = RulesFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // If the file is corrupted/invalid, don't crash the app; keep empty and let user fix it.
      console.warn("[rules.json] invalid format, falling back to empty rules.", parsed.error);
      return [];
    }
    return parsed.data.rules;
  } catch (e) {
    console.warn("[rules.json] load failed, falling back to empty rules.", e);
    return [];
  }
}

export function saveRulesToFile(rules: unknown) {
  const filePath = getRulesJsonPath();
  const parsedRules = z.array(RuleSchema).safeParse(rules);
  if (!parsedRules.success) {
    throw new Error(`Invalid rules payload: ${parsedRules.error.message}`);
  }
  const payload: RulesFile = { version: 2, rules: parsedRules.data };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
}


