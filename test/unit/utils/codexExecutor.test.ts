import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCodexArgs, parseCodexEvents, codexResultFromError } from "../../../src/utils/codexExecutor.js";
import { CommandError } from "../../../src/utils/commandExecutor.js";

// Codex's executor diverges from gemini's by design: where gemini reads plain
// stdout (and guards inline @file references), codex builds a `codex exec` argv
// and parses a line-delimited JSON event stream. These tests cover that surface.
describe("Node Utilities: Codex CLI Executor", () => {
  test("buildCodexArgs emits exec + read-only sandbox + json + skip-git by default, prompt last after --", () => {
    const args = buildCodexArgs({ prompt: "hello" });
    assert.equal(args[0], "exec");
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("--skip-git-repo-check")); // schema default is true
    assert.equal(args[args.length - 2], "--");
    assert.equal(args[args.length - 1], "hello"); // prompt is always the final positional
  });

  test("buildCodexArgs honours sandbox, model, profile, image, and yolo", () => {
    const args = buildCodexArgs({
      prompt: "x",
      sandbox: "workspace-write",
      model: "o3",
      profile: "work",
      image: ["a.png", "b.png"],
      yolo: true,
    });
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(args[args.indexOf("--model") + 1], "o3");
    assert.equal(args[args.indexOf("--profile") + 1], "work");
    assert.equal(args[args.indexOf("--image") + 1], "a.png,b.png"); // joined CSV
    assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  });

  test("buildCodexArgs appends `resume <id>` before the prompt separator when sessionId is set", () => {
    const args = buildCodexArgs({ prompt: "go on", sessionId: "abc-123" });
    const ri = args.indexOf("resume");
    assert.ok(ri > -1);
    assert.equal(args[ri + 1], "abc-123");
    assert.ok(ri < args.indexOf("--")); // resume must precede the `--` prompt separator
  });

  test("buildCodexArgs omits --skip-git-repo-check when skipGitRepoCheck is false", () => {
    const args = buildCodexArgs({ prompt: "x", skipGitRepoCheck: false });
    assert.ok(!args.includes("--skip-git-repo-check"));
  });

  test("parseCodexEvents extracts the session id and concatenates agent message text", () => {
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Hello" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: " world" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n");
    const r = parseCodexEvents(raw);
    assert.equal(r.success, true);
    assert.equal(r.sessionId, "sess-1");
    assert.equal(r.agentText, "Hello world");
  });

  test("parseCodexEvents skips non-JSON noise and ignores transient reconnect notices", () => {
    const raw = [
      "Reading additional input from stdin...", // non-JSON noise
      JSON.stringify({ type: "thread.started", thread_id: "sess-2" }),
      JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
    ].join("\n");
    const r = parseCodexEvents(raw);
    assert.equal(r.sessionId, "sess-2");
    assert.equal(r.agentText, "ok");
    assert.equal(r.errorText, ""); // a reconnect notice is not surfaced as an error
    assert.equal(r.success, true);
  });

  test("parseCodexEvents surfaces real error events and fails when no agent message was produced", () => {
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-3" }),
      JSON.stringify({ type: "error", message: "boom" }),
    ].join("\n");
    const r = parseCodexEvents(raw);
    assert.match(r.errorText, /boom/);
    assert.equal(r.success, false); // a session id alone, with no agent reply, is not success
  });

  test("parseCodexEvents returns success=false for empty input", () => {
    const r = parseCodexEvents("");
    assert.equal(r.success, false);
    assert.equal(r.agentText, "");
    assert.equal(r.sessionId, undefined);
  });

  // The codex backend reports a failed turn on stdout (the JSON event stream),
  // while stderr only carries the benign "Reading additional input from
  // stdin..." banner. These cover the recovery of the real reason.
  test("parseCodexEvents collapses the duplicated turn.failed reason into one [codex error] line", () => {
    const reason = "We're currently experiencing high demand, which may cause temporary errors.";
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-hd" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "error", message: reason }),       // codex emits the reason twice:
      JSON.stringify({ type: "turn.failed", error: { message: reason } }), // once here too
    ].join("\n");
    const r = parseCodexEvents(raw);
    assert.equal(r.success, false);
    assert.match(r.errorText, /high demand/);
    assert.equal((r.errorText.match(/\[codex error\]/g) || []).length, 1); // deduped, not doubled
  });

  test("codexResultFromError surfaces codex's real reason from stdout, not the stderr banner", () => {
    const reason = "We're currently experiencing high demand, which may cause temporary errors.";
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "sess-err" }),
      JSON.stringify({ type: "turn.failed", error: { message: reason } }),
    ].join("\n");
    // Mirrors what executeCommand throws today: the stderr banner as the message,
    // the useful JSON event stream captured on stdout.
    const err = new CommandError(
      "Command failed with exit code 1: Reading additional input from stdin...",
      1,
      stdout,
      "Reading additional input from stdin...",
    );
    const r = codexResultFromError(err);
    assert.equal(r.success, false);
    assert.match(r.errorText, /high demand/);
    assert.doesNotMatch(r.errorText, /Reading additional input from stdin/); // banner suppressed
    assert.doesNotMatch(r.errorText, /exit code 1/);
    assert.equal(r.sessionId, "sess-err"); // recovered for debugging / continuation
  });

  test("codexResultFromError falls back to the thrown message when no stdout is attached", () => {
    const r = codexResultFromError(new Error('Could not find the "codex" executable.'));
    assert.equal(r.success, false);
    assert.match(r.errorText, /Could not find the "codex" executable/);
    assert.equal(r.agentText, "");
  });

  test("codexResultFromError prepends the codex login hint for auth failures", () => {
    const r = codexResultFromError(new Error("stream error: 401 Unauthorized"));
    assert.match(r.errorText, /codex login/);      // NOT_LOGGED_IN guidance added
    assert.match(r.errorText, /401 Unauthorized/); // original detail preserved
  });
});
