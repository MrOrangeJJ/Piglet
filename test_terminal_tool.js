/**
 * Node-runner test script for Piglet "terminal tool" implementation.
 *
 * Usage:
 *   cd TwoWorker
 *   node test_terminal_tool.js
 *
 * This script will:
 * - Open macOS Terminal.app visibly
 * - Run a shell command
 * - Redirect stdout+stderr to a temp file
 * - Poll a status file for completion
 * - Print captured output and exit code
 */
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { execFile } = require("node:child_process");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeAppleScriptString(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
}

async function execFileAsync(cmd, args, opts) {
  return await new Promise((resolve, reject) => {
    execFile(cmd, args, opts ?? {}, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runInVisibleTerminal(shellCommand, opts = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const tempId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const outputPath = path.join(os.tmpdir(), `piglet_terminal_out_${tempId}.log`);
  const statusPath = path.join(os.tmpdir(), `piglet_terminal_status_${tempId}.log`);

  try {
    await fsp.unlink(outputPath);
  } catch {}
  try {
    await fsp.unlink(statusPath);
  } catch {}

  // Mirror utils.ts implementation: show output in Terminal AND capture it.
  // Use an outer bash so PIPESTATUS is available and correct.
  const pipeStatus0 = "${PIPESTATUS[0]}";
  const inner =
    `bash -lc ${JSON.stringify(String(shellCommand ?? ""))} 2>&1 | tee "${outputPath}"; ` +
    `echo ${pipeStatus0} > "${statusPath}"`;
  const wrappedCommand = `bash -lc ${JSON.stringify(inner)}`;

  const script = `
tell application "Terminal"
  activate
  do script "${escapeAppleScriptString(wrappedCommand)}"
end tell
`;

  await execFileAsync("osascript", ["-e", script], { timeout: 15_000 });

  const start = Date.now();
  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout after ${timeoutMs}ms. statusPath not found: ${statusPath}`);
    }
    if (fs.existsSync(statusPath)) break;
    await sleep(pollIntervalMs);
  }

  const stdout = await fsp.readFile(outputPath, "utf8").catch(() => "");
  const codeText = await fsp.readFile(statusPath, "utf8").catch(() => "1");
  const exitCode = Number.parseInt(String(codeText).trim(), 10);
  return {
    stdout,
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    outputPath,
    statusPath,
  };
}

async function main() {
  const cmd = process.argv.slice(2).join(" ").trim() || 'echo "piglet terminal tool OK"; uname -a';
  console.log("[test_terminal_tool] Running command in visible Terminal.app:");
  console.log(cmd);
  const res = await runInVisibleTerminal(cmd, { timeoutMs: 90_000, pollIntervalMs: 250 });
  console.log("\n=== Result ===");
  console.log("exitCode:", res.exitCode);
  console.log("outputPath:", res.outputPath);
  console.log("statusPath:", res.statusPath);
  console.log("\n--- captured output ---\n");
  process.stdout.write(res.stdout || "");
  console.log("\n--- end ---\n");
}

main().catch((e) => {
  console.error("[test_terminal_tool] FAILED:", e?.message ?? e);
  process.exitCode = 1;
});


