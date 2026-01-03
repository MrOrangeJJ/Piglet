/**
 * Test: reuse the SAME Terminal.app tab across multiple runs using `tty` as session id.
 *
 * Requirement:
 * - On entering "terminal_node": create a new Terminal window/tab ONCE and get its tty.
 * - During the same terminal_node: multiple tool calls should all execute in that SAME tab (by tty).
 * - User should see output in Terminal.app, and the function should also capture the same output.
 *
 * Usage:
 *   cd TwoWorker
 *   node test_terminal_tty_session.js
 *   node test_terminal_tty_session.js "echo hi" "ls -la"
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

async function runAppleScript(script, timeoutMs = 15_000) {
  const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: timeoutMs });
  return String(stdout ?? "").trim();
}

async function openNewTerminalWindowAndGetTTY() {
  // Try: make new window (preferred). If it fails, fallback: do script in front window (new tab).
  const scriptPreferred = `
tell application "Terminal"
  activate
  try
    set w to (make new window)
    set t to do script "" in w
  on error
    set t to do script ""
  end try
  -- Wait for tty to be available
  repeat 80 times
    try
      set theTty to tty of t
      if theTty is not "" then exit repeat
    end try
    delay 0.1
  end repeat
  return tty of t
end tell
`;
  const tty = await runAppleScript(scriptPreferred, 20_000);
  if (!tty || !tty.startsWith("/dev/")) {
    throw new Error(`Failed to get tty from Terminal. Got: ${tty}`);
  }
  return tty;
}

async function runCommandInTTYSession(opts) {
  const { tty, shellCommand, pollIntervalMs = 250, timeoutMs = 90_000 } = opts;
  const tempId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const outputPath = path.join(os.tmpdir(), `piglet_terminal_out_${tempId}.log`);
  const statusPath = path.join(os.tmpdir(), `piglet_terminal_status_${tempId}.log`);

  try {
    await fsp.unlink(outputPath);
  } catch {}
  try {
    await fsp.unlink(statusPath);
  } catch {}

  const pipeStatus0 = "${PIPESTATUS[0]}";
  const inner =
    `bash -lc ${JSON.stringify(String(shellCommand ?? ""))} 2>&1 | tee "${outputPath}"; ` +
    `echo ${pipeStatus0} > "${statusPath}"`;
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

  await runAppleScript(script, 20_000);

  const start = Date.now();
  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout after ${timeoutMs}ms waiting status file: ${statusPath}`);
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
  const cmd1 = process.argv[2] || 'echo "[1] hello from tty session"; pwd';
  const cmd2 = process.argv[3] || 'echo "[2] still same tty session"; ls -1 | head -5';

  console.log("[tty-test] opening Terminal window and acquiring tty...");
  const tty = await openNewTerminalWindowAndGetTTY();
  console.log("[tty-test] tty =", tty);
  console.log("[tty-test] Now run TWO commands in the SAME Terminal tab (by tty).");
  console.log("  cmd1:", cmd1);
  console.log("  cmd2:", cmd2);

  const r1 = await runCommandInTTYSession({ tty, shellCommand: cmd1 });
  const r2 = await runCommandInTTYSession({ tty, shellCommand: cmd2 });

  console.log("\n=== cmd1 result ===");
  console.log("exitCode:", r1.exitCode);
  console.log("--- output ---\n" + (r1.stdout || ""));
  console.log("------------");

  console.log("\n=== cmd2 result ===");
  console.log("exitCode:", r2.exitCode);
  console.log("--- output ---\n" + (r2.stdout || ""));
  console.log("------------");

  console.log("\n[tty-test] DONE. Please confirm in Terminal.app you saw both outputs in the SAME window/tab.");
}

main().catch((e) => {
  console.error("[tty-test] FAILED:", e?.message ?? e);
  process.exitCode = 1;
});


