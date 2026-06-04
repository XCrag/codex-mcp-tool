import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { callCodex, callTool, startServer, textOf, REPO_ROOT, CODEX_SKIP, type ServerHandle } from "./harness.js";
import { loadConfig } from "../envParser.js";

// LIVE tests: these drive the real codex CLI through the real MCP server. They
// auto-skip when codex is not on PATH, so the suite degrades gracefully. Real
// model calls are slow, hence the generous per-test timeout. Model is dynamically
// loaded from config to match the test suite settings.
const config = loadConfig();
const LIVE = { skip: CODEX_SKIP, timeout: 120_000 } as const;
const MODEL = config.judgeCodexModel;

const SESSION_RE = /SESSION_ID:\s*(\S+)/;

let server: ServerHandle;

before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.close();
});

describe("MCP Protocol E2E: Live Codex CLI & Tool Requests", () => {
  test("ask-codex answers a deterministic factual question", LIVE, async (t) => {
    const { isError, text } = await callCodex(t, server, {
      name: "ask-codex",
      arguments: { prompt: "What is 2 + 2? Reply with only the number.", model: MODEL },
    });
    assert.equal(isError, false, text);
    assert.match(text, /Codex response:/); // the tool's wrapper is always present
    assert.match(text, /\b4\b/); // ...and the model actually answered
    assert.match(text, SESSION_RE); // ...and a SESSION_ID is returned for continuation
  });

  test("ask-codex resumes a prior session via sessionId", LIVE, async (t) => {
    // Codex's headline capability over the stateless gemini tool: session resume.
    const first = await callCodex(t, server, {
      name: "ask-codex",
      arguments: { prompt: "Remember the word AURORA for later. Reply with only: noted.", model: MODEL },
    });
    assert.equal(first.isError, false, first.text);
    const m = first.text.match(SESSION_RE);
    assert.ok(m, "expected a SESSION_ID in the first reply");
    const sessionId = m![1];

    const second = await callCodex(t, server, {
      name: "ask-codex",
      arguments: {
        prompt: "What word did I ask you to remember? Reply with only that word.",
        model: MODEL,
        sessionId,
      },
    });
    // The resume round-trip must succeed and still yield a SESSION_ID.
    assert.equal(second.isError, false, second.text);
    assert.match(second.text, SESSION_RE);
    // Recall is model-dependent, so report it as a diagnostic rather than gating on it.
    t.diagnostic(/AURORA/i.test(second.text) ? "session recall: HIT (AURORA)" : "session recall: not echoed (model-dependent)");
  });

  test("ask-codex surfaces the contents of an in-workspace file", LIVE, async (t) => {
    const { isError, text } = await callCodex(t, server, {
      name: "ask-codex",
      arguments: {
        prompt:
          "Read the file test/e2e/fixtures/sentinel.txt and reply with only the sentinel token it contains.",
        model: MODEL,
        cd: REPO_ROOT, // resolve the relative path against the repo, read-only sandbox is enough
      },
    });
    assert.equal(isError, false, text);
    assert.match(text, /BANANA_SENTINEL_42/);
  });

  test("Help returns the codex CLI help text", LIVE, async (t) => {
    const res = await callTool(t, server, { name: "Help", arguments: {} });
    const text = textOf(res);
    assert.equal(res.isError ?? false, false, text);
    assert.match(text, /usage|--model|codex|exec/i);
  });

  // brainstorm generates free-form ideas: the slowest call, and nondeterministic.
  // Its prompt construction is unit-tested, and its integration path is identical
  // to ask-codex (proven above), so here we only verify the live round-trip
  // succeeds end-to-end. Larger timeout, single attempt.
  test("brainstorm completes a real round-trip through codex", { skip: CODEX_SKIP, timeout: 180_000 }, async (t) => {
    const res = await callTool(t, server, {
      name: "brainstorm",
      arguments: { prompt: "one quick way to speed up CI", model: MODEL, ideaCount: 1, includeAnalysis: false },
    });
    assert.equal(res.isError ?? false, false, textOf(res));
  });
});
