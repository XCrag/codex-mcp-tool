import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { executeCodexCLI, processChangeModeOutput, CodexResult } from '../utils/codexExecutor.js';
import { ERROR_MESSAGES, STATUS_MESSAGES } from '../constants.js';

const askCodexArgsSchema = z.object({
  prompt: z.string().min(1).describe("The coding task / question for Codex (e.g., 'review the auth flow in src/auth.ts', 'fix the failing test in tests/foo.test.ts', or 'propose a unified diff that adds input validation')."),
  model: z.string().optional().describe("Optional model override (e.g., 'gpt-5-codex'). Only pass when the user explicitly requests a specific model."),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('read-only').describe("Sandbox policy for Codex's shell commands. 'read-only' (default, safest) = no file writes; 'workspace-write' = may modify the workspace; 'danger-full-access' = unrestricted."),
  cd: z.string().optional().describe("Workspace root for Codex (--cd). Defaults to the server's current working directory."),
  sessionId: z.string().optional().describe("Resume a previous Codex session. Pass the SESSION_ID returned by an earlier ask-codex call to continue the same conversation."),
  changeMode: z.boolean().default(false).describe("Ask Codex for structured OLD/NEW edits instead of free-form text (and force read-only so Codex only proposes diffs). The edits are returned ready to apply, and large responses are chunked via fetch-chunk."),
  chunkIndex: z.union([z.number(), z.string()]).optional().describe("Which changeMode chunk to return (1-based)."),
  chunkCacheKey: z.string().optional().describe("Cache key from a prior changeMode response, used with chunkIndex to fetch a continuation chunk."),
  image: z.union([z.array(z.string()), z.string()]).optional().describe("Image file path(s) to attach to the prompt. Array of paths, or a comma-separated string."),
  profile: z.string().optional().describe("Config profile to load from ~/.codex/config.toml. Only pass when the user explicitly requests one."),
  yolo: z.boolean().default(false).describe("Bypass all approvals AND sandboxing (dangerous). Only use when a sandbox policy cannot be applied."),
  skipGitRepoCheck: z.boolean().default(true).describe("Allow Codex to run outside a Git repository."),
  returnAllMessages: z.boolean().default(false).describe("Append the full raw JSONL event trace (reasoning, tool calls, etc.) for debugging. Increases payload size."),
});

function sessionFooter(sessionId?: string): string {
  if (!sessionId) return '';
  return `\n\n---\nSESSION_ID: ${sessionId}\n(To continue this Codex conversation, call ask-codex again with sessionId="${sessionId}".)`;
}

function normalizeImage(image: unknown): string[] | undefined {
  if (!image) return undefined;
  if (Array.isArray(image)) {
    const list = image.map(String).map(s => s.trim()).filter(Boolean);
    return list.length ? list : undefined;
  }
  if (typeof image === 'string') {
    const list = image.split(',').map(s => s.trim()).filter(Boolean);
    return list.length ? list : undefined;
  }
  return undefined;
}

function renderAllMessages(result: CodexResult): string {
  try {
    return `\n\n---\n[all_messages]\n\`\`\`json\n${JSON.stringify(result.events, null, 2)}\n\`\`\``;
  } catch {
    return '';
  }
}

export const askCodexTool: UnifiedTool = {
  name: "ask-codex",
  description: "Run a Codex CLI session (`codex exec`). sandbox policy [read-only|workspace-write|danger-full-access], session resume via sessionId, structured edits via changeMode:boolean. Returns Codex's reply plus a SESSION_ID for multi-turn continuation.",
  zodSchema: askCodexArgsSchema,
  prompt: {
    description: "Delegate a coding task to Codex via 'codex exec'. Supports session resume and changeMode structured edit suggestions.",
  },
  category: 'codex',
  execute: async (args, onProgress) => {
    const {
      prompt, model, sandbox, cd, sessionId, changeMode,
      chunkIndex, chunkCacheKey, image, profile, yolo,
      skipGitRepoCheck, returnAllMessages,
    } = args;

    if (!prompt?.toString().trim()) {
      throw new Error(ERROR_MESSAGES.NO_PROMPT_PROVIDED);
    }

    // ChangeMode continuation: fetch a cached chunk without re-invoking Codex.
    if (changeMode && chunkIndex && chunkCacheKey) {
      if (typeof chunkCacheKey !== 'string' || !/^[a-f0-9]{8}$/.test(chunkCacheKey)) {
        return `❌ Invalid chunkCacheKey format. Expected 8 lowercase hex characters (got ${JSON.stringify(chunkCacheKey)}).`;
      }
      return processChangeModeOutput(
        '',
        chunkIndex as number,
        chunkCacheKey as string,
        prompt as string
      );
    }

    const result = await executeCodexCLI(
      {
        prompt: prompt as string,
        model: model as string | undefined,
        sandbox: sandbox as string | undefined,
        cd: cd as string | undefined,
        sessionId: sessionId as string | undefined,
        image: normalizeImage(image),
        profile: profile as string | undefined,
        yolo: !!yolo,
        skipGitRepoCheck: skipGitRepoCheck !== false,
        changeMode: !!changeMode,
      },
      onProgress
    );

    if (!result.success) {
      // Still surface the session id (if any) so the caller can continue.
      return `❌ Codex did not return a usable reply.${result.errorText}${sessionFooter(result.sessionId)}`;
    }

    let body: string;
    if (changeMode) {
      body = await processChangeModeOutput(
        result.agentText,
        chunkIndex as number | undefined,
        undefined,
        prompt as string
      );
    } else {
      body = `${STATUS_MESSAGES.CODEX_RESPONSE}\n${result.agentText}`;
    }

    const trace = returnAllMessages ? renderAllMessages(result) : '';
    return `${body}${sessionFooter(result.sessionId)}${trace}`;
  }
};
