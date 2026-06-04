import { executeCommand, CommandError } from './commandExecutor.js';
import { Logger } from './logger.js';
import { CLI, DEFAULT_SANDBOX, ERROR_MESSAGES } from '../constants.js';

import { parseChangeModeOutput, validateChangeModeEdits } from './changeModeParser.js';
import { formatChangeModeResponse, summarizeChangeModeEdits } from './changeModeTranslator.js';
import { chunkChangeModeEdits } from './changeModeChunker.js';
import { cacheChunks, getChunks } from './chunkCache.js';

export interface CodexOptions {
  prompt: string;
  cd?: string;
  sandbox?: string;
  sessionId?: string;
  model?: string;
  image?: string[];
  profile?: string;
  yolo?: boolean;
  skipGitRepoCheck?: boolean;
  changeMode?: boolean;
}

export interface CodexResult {
  success: boolean;
  sessionId?: string;
  agentText: string;
  events: any[];
  errorText: string;
}

/**
 * Builds the argv for `codex exec`. Pure and side-effect free so it can be unit
 * tested. The prompt is passed verbatim as the final positional argument after
 * `--`; quoting for Windows cmd.exe is handled in commandExecutor.
 */
export function buildCodexArgs(opts: CodexOptions): string[] {
  const sandbox = (opts.sandbox && opts.sandbox.trim()) ? opts.sandbox : DEFAULT_SANDBOX;
  const cd = (opts.cd && opts.cd.trim()) ? opts.cd : process.cwd();

  const args: string[] = [CLI.FLAGS.EXEC, CLI.FLAGS.SANDBOX, sandbox, CLI.FLAGS.CD, cd, CLI.FLAGS.JSON];

  // Default to allowing non-git directories (matches the tool schema default).
  if (opts.skipGitRepoCheck !== false) args.push(CLI.FLAGS.SKIP_GIT);
  if (opts.image && opts.image.length) args.push(CLI.FLAGS.IMAGE, opts.image.join(','));
  if (opts.model && opts.model.trim()) args.push(CLI.FLAGS.MODEL, opts.model);
  if (opts.profile && opts.profile.trim()) args.push(CLI.FLAGS.PROFILE, opts.profile);
  if (opts.yolo) args.push(CLI.FLAGS.YOLO);
  // `resume <SESSION_ID>` is a subcommand of `exec`; options precede it.
  if (opts.sessionId && opts.sessionId.trim()) args.push(CLI.FLAGS.RESUME, opts.sessionId);

  args.push('--', opts.prompt);
  return args;
}

function extractErrorMessage(evt: any): string {
  if (typeof evt?.message === 'string') return evt.message;
  if (typeof evt?.error?.message === 'string') return evt.error.message;
  try {
    return JSON.stringify(evt);
  } catch {
    return String(evt);
  }
}

/**
 * Parses Codex's line-delimited JSON (`codex exec --json`) event stream.
 *
 * Event shapes (codex-cli 0.136):
 *   {"type":"thread.started","thread_id":"<uuid>"}            → session id
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}  → reply
 *   {"type":"turn.completed","usage":{...}}                   → end of turn
 *   error/fail events carry `message` or `error.message`
 *
 * Non-JSON lines (e.g. "Reading additional input from stdin...") are skipped, and
 * transient "Reconnecting... N/M" notices are not treated as errors.
 */
export function parseCodexEvents(raw: string): CodexResult {
  let sessionId: string | undefined;
  let agentText = '';
  const events: any[] = [];
  const errorMessages: string[] = [];

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // non-JSON noise
    }
    events.push(evt);

    if (typeof evt.thread_id === 'string' && evt.thread_id) {
      sessionId = evt.thread_id;
    }

    const type = typeof evt.type === 'string' ? evt.type : '';

    if (type === 'item.completed' && evt.item && evt.item.type === 'agent_message') {
      if (typeof evt.item.text === 'string') agentText += evt.item.text;
    }

    if (type.includes('error') || type.includes('fail')) {
      const msg = extractErrorMessage(evt);
      // Ignore transient reconnect notices (#23, #36 in upstream codexmcp), and
      // collapse duplicates — codex emits the same reason in both an `error`
      // event and the trailing `turn.failed` event.
      if (!/^Reconnecting\.\.\.\s+\d+\/\d+/.test(msg) && !errorMessages.includes(msg)) {
        errorMessages.push(msg);
      }
    }
  }

  // Mirror codexmcp's success rule: a turn is successful when we obtained a
  // session id AND a final agent message. Error events alone do not fail the run
  // if Codex still produced a reply (it may have logged recoverable warnings).
  const success = !!sessionId && agentText.trim().length > 0;
  const errorText = errorMessages.map((m) => `\n\n[codex error] ${m}`).join('');

  return { success, sessionId, agentText, events, errorText };
}

/**
 * Maps a thrown error from `executeCommand` into a CodexResult. Pure and
 * side-effect free so it can be unit tested.
 *
 * codex streams its JSON events to stdout, so when `codex exec` exits non-zero
 * the real reason (e.g. a `turn.failed` "high demand" error) lives in those
 * events — NOT in stderr, which only carries the benign "Reading additional
 * input from stdin..." banner that the generic command runner surfaces by
 * default. When the error is a CommandError (raw stdout available), parse it and
 * prefer the actual codex error; otherwise fall back to the thrown message
 * (ENOENT, spawn failures, etc.). The login hint is applied to whichever detail
 * we end up with.
 */
export function codexResultFromError(error: unknown): CodexResult {
  const message = error instanceof Error ? error.message : String(error);
  const parsed = error instanceof CommandError && error.stdout.trim()
    ? parseCodexEvents(error.stdout)
    : undefined;
  // parseCodexEvents already prefixes each reason with "\n\n[codex error] ", so
  // keep it verbatim (empty string stays falsy and falls back to the message) —
  // trimming here would jam the reason against the caller's "...reply." prefix.
  const detail = parsed?.errorText || message;
  const errorText = /not logged in|unauthor|auth|login|401|403/i.test(detail)
    ? `${ERROR_MESSAGES.NOT_LOGGED_IN}\n\n${detail}`
    : detail;
  return {
    success: false,
    sessionId: parsed?.sessionId,
    agentText: parsed?.agentText ?? '',
    events: parsed?.events ?? [],
    errorText,
  };
}

const CHANGEMODE_INSTRUCTIONS = (userRequest: string): string => `
[CHANGEMODE INSTRUCTIONS]
You are generating code modifications that will be processed by an automated system. The output format is critical because it enables programmatic application of changes without human intervention.

Do NOT modify any files yourself. Only OUTPUT the proposed edits in the exact format below — another tool will apply them.

INSTRUCTIONS:
1. Analyze each relevant file thoroughly
2. Identify locations requiring changes based on the user request
3. For each change, output in the exact format specified
4. The OLD section must be EXACTLY what appears in the file (copy-paste exact match)
5. Provide complete, directly replacing code blocks
6. Verify line numbers are accurate

CRITICAL REQUIREMENTS:
1. Output edits in the EXACT format specified below - no deviations
2. The OLD string MUST be findable with Ctrl+F - it must be a unique, exact match
3. Include enough surrounding lines to make the OLD string unique
4. If a string appears multiple times (like </div>), include enough context lines above and below to make it unique
5. Copy the OLD content EXACTLY as it appears - including all whitespace, indentation, line breaks
6. Never use partial lines - always include complete lines from start to finish

OUTPUT FORMAT (follow exactly):
**FILE: [filename]:[line_number]**
\`\`\`
OLD:
[exact code to be replaced - must match file content precisely]
NEW:
[new code to insert - complete and functional]
\`\`\`

EXAMPLE 1 - Simple unique match:
**FILE: src/utils/helper.js:100**
\`\`\`
OLD:
function getMessage() {
  return "Hello World";
}
NEW:
function getMessage() {
  return "Hello Universe!";
}
\`\`\`

EXAMPLE 2 - Common tag needing context:
**FILE: index.html:245**
\`\`\`
OLD:
        </div>
      </div>
    </section>
NEW:
        </div>
      </footer>
    </section>
\`\`\`

IMPORTANT: The OLD section must be an EXACT copy from the file that can be found with Ctrl+F!

USER REQUEST:
${userRequest}
`;

/**
 * Runs `codex exec` and returns a structured result. Never throws — a spawn or
 * non-zero-exit failure is captured into `{ success:false, errorText }` so the
 * calling tool can format it consistently (mirrors codexmcp's dict return).
 *
 * When `changeMode` is on, the sandbox is forced to `read-only`: Codex must only
 * PROPOSE diffs (which the OLD/NEW pipeline applies), never edit files itself.
 */
export async function executeCodexCLI(
  opts: CodexOptions,
  onProgress?: (newOutput: string) => void
): Promise<CodexResult> {
  const changeMode = !!opts.changeMode;
  const sandbox = changeMode ? 'read-only' : ((opts.sandbox && opts.sandbox.trim()) ? opts.sandbox : DEFAULT_SANDBOX);
  const prompt = changeMode ? CHANGEMODE_INSTRUCTIONS(opts.prompt) : opts.prompt;

  const args = buildCodexArgs({ ...opts, sandbox, prompt });

  try {
    const raw = await executeCommand(CLI.COMMANDS.CODEX, args, onProgress);
    const result = parseCodexEvents(raw);
    if (!result.success && !result.errorText) {
      // Process exited 0 but we never saw an agent_message (e.g. Codex only ran
      // tool calls). Surface a helpful note; sessionId is still returned so the
      // caller can continue the conversation.
      result.errorText = ERROR_MESSAGES.NO_AGENT_MESSAGE;
    }
    return result;
  } catch (error) {
    Logger.error(`codex exec failed: ${error instanceof Error ? error.message : String(error)}`);
    return codexResultFromError(error);
  }
}

/**
 * Ported verbatim from gemini-mcp-tool: parse the OLD/NEW edits out of the
 * model's text, validate, chunk, cache, and format. Fed `result.agentText`.
 */
export async function processChangeModeOutput(
  rawResult: string,
  chunkIndex?: number,
  chunkCacheKey?: string,
  prompt?: string
): Promise<string> {
  // Check for cached chunks first
  if (chunkIndex && chunkCacheKey) {
    const cachedChunks = getChunks(chunkCacheKey);
    if (cachedChunks && chunkIndex > 0 && chunkIndex <= cachedChunks.length) {
      Logger.debug(`Using cached chunk ${chunkIndex} of ${cachedChunks.length}`);
      const chunk = cachedChunks[chunkIndex - 1];
      let result = formatChangeModeResponse(
        chunk.edits,
        { current: chunkIndex, total: cachedChunks.length, cacheKey: chunkCacheKey }
      );

      // Add summary for first chunk only
      if (chunkIndex === 1 && chunk.edits.length > 5) {
        const allEdits = cachedChunks.flatMap(c => c.edits);
        result = summarizeChangeModeEdits(allEdits) + '\n\n' + result;
      }

      return result;
    }

    if (!rawResult.trim()) {
      if (cachedChunks) {
        return `❌ Invalid chunk index: ${chunkIndex}

Available chunks: 1 to ${cachedChunks.length}
You requested: ${chunkIndex}

Please use a valid chunk index.`;
      }

      return `❌ Cache miss: No chunks found for cache key "${chunkCacheKey}".

Possible reasons:
1. The cache key is incorrect, or the original changeMode request did not create chunks
2. The cache has expired (10 minute TTL)
3. The MCP server was restarted and the file-based cache was cleared

Please re-run the original changeMode request to regenerate the chunks.`;
    }

    Logger.debug(`Cache miss or invalid chunk index, processing new result`);
  }

  // Parse OLD/NEW format
  const edits = parseChangeModeOutput(rawResult);

  if (edits.length === 0) {
    return `No edits found in Codex's response. Please ensure Codex uses the OLD/NEW format. \n\n${rawResult}`;
  }

  // Validate edits
  const validation = validateChangeModeEdits(edits);
  if (!validation.valid) {
    return `Edit validation failed:\n${validation.errors.join('\n')}`;
  }

  const chunks = chunkChangeModeEdits(edits);

  // Cache if multiple chunks and we have the original prompt
  let cacheKey: string | undefined;
  if (chunks.length > 1 && prompt) {
    cacheKey = cacheChunks(prompt, chunks);
    Logger.debug(`Cached ${chunks.length} chunks with key: ${cacheKey}`);
  }

  // Return requested chunk or first chunk
  const returnChunkIndex = (chunkIndex && chunkIndex > 0 && chunkIndex <= chunks.length) ? chunkIndex : 1;
  const returnChunk = chunks[returnChunkIndex - 1];

  // Format the response
  let result = formatChangeModeResponse(
    returnChunk.edits,
    chunks.length > 1 ? { current: returnChunkIndex, total: chunks.length, cacheKey } : undefined
  );

  // Add summary if helpful (only for first chunk)
  if (returnChunkIndex === 1 && edits.length > 5) {
    result = summarizeChangeModeEdits(edits, chunks.length > 1) + '\n\n' + result;
  }

  Logger.debug(`ChangeMode: Parsed ${edits.length} edits, ${chunks.length} chunks, returning chunk ${returnChunkIndex}`);
  return result;
}
