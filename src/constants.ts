

// Logging
export const LOG_PREFIX = "[CMCPT]";

// Error messages
export const ERROR_MESSAGES = {
  TOOL_NOT_FOUND: "not found in registry",
  NO_PROMPT_PROVIDED: "Please provide a prompt for Codex. Describe the coding task (e.g., 'review the auth flow in src/auth.ts' or 'fix the failing test in tests/foo.test.ts').",
  NO_AGENT_MESSAGE: "Codex returned no final agent message. It may have only performed tool calls — you can continue the conversation with the returned sessionId, or set returnAllMessages=true to inspect the full event trace.",
  NOT_LOGGED_IN: "Codex CLI is not authenticated. Run `codex login` in your terminal, then retry.",
} as const;

// Status messages
export const STATUS_MESSAGES = {
  CODEX_RESPONSE: "Codex response:",
  SANDBOX_FORCED_READONLY: "🔒 changeMode is on — forcing sandbox=read-only so Codex only proposes diffs.",
  // Timeout prevention messages
  PROCESSING_START: "🔍 Starting Codex (may take a while for large tasks)",
  PROCESSING_CONTINUE: "⏳ Still processing... Codex is working on your request",
  PROCESSING_COMPLETE: "✅ Codex task completed successfully",
} as const;

// Sandbox policies accepted by `codex exec --sandbox`.
export const SANDBOX_LEVELS = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxLevel = (typeof SANDBOX_LEVELS)[number];
export const DEFAULT_SANDBOX: SandboxLevel = "read-only";

// MCP Protocol Constants
export const PROTOCOL = {
  // Message roles
  ROLES: {
    USER: "user",
    ASSISTANT: "assistant",
  },
  // Content types
  CONTENT_TYPES: {
    TEXT: "text",
  },
  // Status codes
  STATUS: {
    SUCCESS: "success",
    ERROR: "error",
    FAILED: "failed",
    REPORT: "report",
  },
  // Notification methods
  NOTIFICATIONS: {
    PROGRESS: "notifications/progress",
  },
  // Timeout prevention
  KEEPALIVE_INTERVAL: 25000, // 25 seconds
} as const;


// CLI Constants
export const CLI = {
  // Command names
  COMMANDS: {
    CODEX: "codex",
    ECHO: "echo",
  },
  // Command flags / subcommands for `codex exec`
  FLAGS: {
    EXEC: "exec",
    SANDBOX: "--sandbox",
    CD: "--cd",
    JSON: "--json",
    MODEL: "--model",
    IMAGE: "--image",
    PROFILE: "--profile",
    SKIP_GIT: "--skip-git-repo-check",
    YOLO: "--dangerously-bypass-approvals-and-sandbox",
    RESUME: "resume",
    HELP: "--help",
  },
  // Default values
  DEFAULTS: {
    SANDBOX: DEFAULT_SANDBOX,
    BOOLEAN_TRUE: "true",
    BOOLEAN_FALSE: "false",
  },
} as const;


// Environment variables that configure the server.
export const ENV = {
  CODEX_CLI_PATH: "CODEX_CLI_PATH", // explicit path to the codex executable (Windows shim resolution)
} as const;


// (merged PromptArguments and ToolArguments)
export interface ToolArguments {
  prompt?: string;
  model?: string;
  sandbox?: string;             // read-only | workspace-write | danger-full-access
  cd?: string;                  // workspace root for codex
  sessionId?: string;           // resume a previous codex session
  changeMode?: boolean | string;
  chunkIndex?: number | string; // Which chunk to return (1-based)
  chunkCacheKey?: string;       // Optional cache key for continuation
  image?: string[] | string;    // image file paths to attach
  profile?: string;             // config profile from ~/.codex/config.toml
  yolo?: boolean | string;      // bypass approvals and sandbox
  skipGitRepoCheck?: boolean | string;
  returnAllMessages?: boolean | string;
  message?: string;             // For Ping tool

  // brainstorm tool
  methodology?: string;
  domain?: string;
  constraints?: string;
  existingContext?: string;
  ideaCount?: number;
  includeAnalysis?: boolean;

  [key: string]: string | string[] | boolean | number | undefined; // Allow additional properties
}
