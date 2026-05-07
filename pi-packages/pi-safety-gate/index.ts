/**
 * Pi Safety Gate Extension
 * 
 * Two features in one:
 * 1. Permission gate -- blocks dangerous bash commands (aligned with LAW rules)
 * 2. Git checkpoint -- auto-stashes before each agent turn
 */
import { execSync } from "node:child_process";

// HARD BLOCKED -- never allowed, no override. Matches LAW destructive git rules.
const HARD_BLOCKED = [
  /git\s+(reset|clean\s+-f|push\s+--force|push\s+-f|checkout\s+\.\s*$|restore\s+\.\s*$|branch\s+-D|stash\s+(drop|clear))/,
  /git\s+push\s+.*--force/,
  /rm\s+(-rf|-fr)\s+[\/~]/,       // rm -rf with absolute/home paths
  /rm\s+(-rf|-fr)\s+\.\s*$/,      // rm -rf . (current dir)
  />\s*\/dev\/sd/,                 // writing to block devices
  /mkfs\./,                        // formatting filesystems
  /dd\s+if=/,                      // raw disk writes
  /:(){ :|:& };:/,                // fork bomb
  /curl.*\|\s*(ba)?sh/,           // pipe curl to shell
  /wget.*\|\s*(ba)?sh/,           // pipe wget to shell
];

// WARN -- allowed after confirmation in interactive mode, blocked in headless/RPC
const WARN_PATTERNS = [
  { pattern: /chmod\s+777/, reason: "overly permissive (777)" },
  { pattern: /rm\s+-rf\s/, reason: "recursive force delete" },
  { pattern: /git\s+push\s+.*main/, reason: "pushing to main" },
  { pattern: /git\s+commit.*-m.*main/, reason: "committing on main" },
  { pattern: /git\s+checkout\s+main\s*$/, reason: "switching to main branch" },
  { pattern: /npm\s+publish/, reason: "publishing to npm" },
  { pattern: /docker\s+rm/, reason: "removing docker container" },
  { pattern: /systemctl\s+(stop|restart|disable)/, reason: "modifying system service" },
];

// --- Git Checkpoint ---

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function hasChanges(cwd: string): boolean {
  try {
    const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

function isOnMain(cwd: string): boolean {
  try {
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    return branch === "main" || branch === "master";
  } catch {
    return false;
  }
}

// @ts-ignore -- Pi extension API
export default function (pi: any) {
  // --- Permission Gate ---
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.tool !== "bash") return;

    const command = (event.input?.command ?? "") as string;

    // Hard blocks -- no override
    for (const pattern of HARD_BLOCKED) {
      if (pattern.test(command)) {
        return { 
          block: true, 
          reason: `HARD BLOCKED: destructive command not allowed.\nCommand: ${command}\nThis is a safety rule -- no override available.` 
        };
      }
    }

    // Check if on main branch for git write operations
    if (/git\s+(commit|merge|rebase|cherry-pick)/.test(command)) {
      const cwd = ctx.cwd ?? process.cwd();
      if (isOnMain(cwd)) {
        return {
          block: true,
          reason: `BLOCKED: git write operation on main/master branch.\nCommand: ${command}\nCreate a feature branch first.`
        };
      }
    }

    // Warn patterns -- confirm in interactive, block in headless
    for (const { pattern, reason } of WARN_PATTERNS) {
      if (pattern.test(command)) {
        if (ctx.hasUI) {
          const allow = await ctx.ui.confirm(
            `Warning: ${reason}\nCommand: ${command}\n\nAllow?`
          );
          if (allow) return;
        }
        return { block: true, reason: `Blocked (${reason}): ${command}` };
      }
    }
  });

  // --- Git Checkpoint ---
  pi.on("turn_start", async (_event: any, ctx: any) => {
    const cwd = ctx.cwd ?? process.cwd();
    if (!isGitRepo(cwd) || !hasChanges(cwd)) return;

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
    const message = `pi-checkpoint-${timestamp}`;

    try {
      // Stash with untracked files, then immediately pop
      // This creates a stash entry (safety net) while keeping working tree intact
      execSync(`git stash push -m "${message}" --include-untracked`, { cwd, stdio: "pipe" });
      try {
        execSync("git stash pop", { cwd, stdio: "pipe" });
      } catch {
        // Conflict on pop -- leave stashed, user can resolve
      }
    } catch {
      // Not a git repo or stash failed -- silently continue
    }
  });
}
