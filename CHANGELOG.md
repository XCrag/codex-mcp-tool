# Changelog

## [0.1.0] - 2026-06-03

Initial release. A TypeScript MCP server that wraps the [Codex CLI](https://developers.openai.com/codex), modeled on the architecture of [`gemini-mcp-tool`](https://github.com/jamubc/gemini-mcp-tool).

### Added
- **`ask-codex`** tool — runs `codex exec --json` and returns the agent's reply.
  - `sandbox` policy selector (`read-only` / `workspace-write` / `danger-full-access`), defaulting to `read-only`.
  - **Session resume** — every response carries a `SESSION_ID`; pass it back via `sessionId` to continue a multi-turn Codex conversation.
  - `model`, `cd` (workspace root), `image` (attachments), `profile`, `yolo` (approval/sandbox bypass), and `skipGitRepoCheck` options.
  - **`changeMode`** — asks Codex for structured `OLD`/`NEW` edits (and forces `read-only` so Codex only *proposes* diffs); large responses are chunked and cached, retrievable via `fetch-chunk`.
  - `returnAllMessages` — appends the raw JSONL event trace for debugging.
- **`brainstorm`** tool — methodology-driven idea generation (divergent / convergent / SCAMPER / design-thinking / lateral / auto).
- **`fetch-chunk`** tool — retrieves cached `changeMode` chunks (10-minute TTL).
- **`ping`** / **`Help`** utility tools.
- Progress notifications (keepalive every 25 s) so long Codex runs don't time out clients that request progress.
- Cross-platform command execution hardening ported from `gemini-mcp-tool` (Windows `cmd.exe` argument quoting, shim resolution, `CODEX_CLI_PATH` override, ENOENT guidance).
