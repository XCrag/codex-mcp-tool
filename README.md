# Codex MCP Tool

> A Model Context Protocol (MCP) server that lets AI assistants (Claude Code, Claude Desktop, …) drive the [Codex CLI](https://developers.openai.com/codex) — delegating code generation, debugging, and review to Codex while keeping a persistent **session** across turns.

This project is modeled on the architecture of [`gemini-mcp-tool`](https://github.com/jamubc/gemini-mcp-tool), adapted for `codex exec` and extended with Codex's session-resume capability.

## Prerequisites

1. **[Node.js](https://nodejs.org/)** v18+
2. **[Codex CLI](https://developers.openai.com/codex)** installed and authenticated (`codex login`)

Verify Codex works first:

```bash
codex --version
codex exec --sandbox read-only --skip-git-repo-check -- "say hi"
```

## Install

### One-line (Claude Code)

```bash
claude mcp add codex-cli -- npx -y codex-mcp-tool
```

### From source (local)

```bash
cd codex-mcp-tool
npm install
npm run build
claude mcp add codex-cli -- node /absolute/path/to/codex-mcp-tool/dist/index.js
```

### Claude Desktop config

```json
{
  "mcpServers": {
    "codex-cli": {
      "command": "npx",
      "args": ["-y", "codex-mcp-tool"]
    }
  }
}
```

Type `/mcp` inside Claude Code to verify the `codex-cli` server is connected.

## Tools

### `ask-codex`

Runs `codex exec` and returns Codex's reply. The response ends with a `SESSION_ID` line — capture it and pass it back as `sessionId` to continue the same conversation.

| Param | Type | Default | Description |
|---|---|---|---|
| `prompt` | string (required) | — | Instruction for Codex |
| `sandbox` | enum | `read-only` | `read-only` · `workspace-write` · `danger-full-access` |
| `cd` | string | server cwd | Workspace root for Codex |
| `sessionId` | string | — | Resume a previous Codex session |
| `model` | string | — | Override model (only when explicitly requested) |
| `image` | string[] | — | Image file paths to attach to the prompt |
| `profile` | string | — | Config profile from `~/.codex/config.toml` |
| `yolo` | boolean | `false` | Bypass approvals **and** sandbox (dangerous) |
| `skipGitRepoCheck` | boolean | `true` | Allow running outside a Git repo |
| `changeMode` | boolean | `false` | Ask for structured `OLD`/`NEW` edits (forces `read-only`) |
| `chunkIndex` / `chunkCacheKey` | — | — | Continuation of a chunked `changeMode` response |
| `returnAllMessages` | boolean | `false` | Append the raw JSONL event trace |

**Examples**

- `ask codex to review the auth flow in @src/auth.ts (read-only)`
- `use codex with workspace-write to fix the failing test in tests/foo.test.ts`
- `ask codex for a unified diff that adds input validation — changeMode`

### `brainstorm`

Methodology-driven idea generation: `divergent`, `convergent`, `scamper`, `design-thinking`, `lateral`, or `auto`.

### `fetch-chunk`

Retrieves the next chunk of a large `changeMode` response (`cacheKey`, `chunkIndex`). 10-minute TTL.

### `ping` / `Help`

Connectivity echo, and `codex --help` passthrough.

## How it differs from `gemini-mcp-tool`

- Drives `codex exec --json` and parses Codex's **JSONL event stream** (instead of Gemini's plain-text stdout).
- **Sessions**: Codex returns a `thread_id`; this server surfaces it as `SESSION_ID` and resumes via `codex exec resume`.
- **Sandbox policy** is a three-level enum (Codex), not a boolean flag (Gemini). Default is the safest, `read-only`.
- The Gemini `@file` exfiltration guard is **not** needed — Codex does not inline `@file`; its file access is bounded by the sandbox policy and `--cd` root.

## Recommended `CLAUDE.md` snippet

To get Claude Code to collaborate with Codex effectively, consider adding guidance like: *"Before coding, ask `ask-codex` (read-only, `changeMode`) for a reference unified-diff prototype; treat it as a logical reference and rewrite to production quality. After coding, ask `ask-codex` to review the diff. Always reuse the returned `SESSION_ID`."*

## License

MIT. Unofficial, third-party tool; not affiliated with OpenAI.
