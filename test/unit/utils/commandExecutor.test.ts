import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  quoteForCmd,
  resolveCommandForExecution,
  buildEnoentErrorMessage,
  selectWindowsCodexCandidate,
  CommandError,
} from "../../../src/utils/commandExecutor.js";

describe("Node Utilities: Command Executor & Quoting", () => {
  test("quoteForCmd wraps in double quotes and doubles embedded quotes", () => {
    assert.equal(quoteForCmd("hello"), '"hello"');
    assert.equal(quoteForCmd("a&calc"), '"a&calc"'); // cmd metachar made inert by quoting
    assert.equal(quoteForCmd('a"b'), '"a""b"');
  });

  test("quoteForCmd doubles a trailing backslash so it can't escape the closing quote", () => {
    assert.equal(quoteForCmd("path\\"), '"path\\\\"');
  });

  test("resolveCommandForExecution is a no-op off Windows", () => {
    if (process.platform !== "win32") {
      assert.equal(resolveCommandForExecution("codex"), "codex");
      assert.equal(resolveCommandForExecution("echo"), "echo");
    } else {
      // On Windows it should at least never return an empty string.
      assert.ok(resolveCommandForExecution("codex").length > 0);
    }
  });

  test("selectWindowsCodexCandidate ignores unsupported PowerShell and extensionless shims", () => {
    assert.equal(
      selectWindowsCodexCandidate([
        "C:\\Users\\jam\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\jam\\AppData\\Roaming\\npm\\codex.ps1",
      ]),
      "codex.cmd",
    );
    assert.equal(
      selectWindowsCodexCandidate([
        "C:\\Users\\jam\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\jam\\AppData\\Roaming\\npm\\codex.cmd",
        "C:\\Users\\jam\\AppData\\Roaming\\npm\\codex.ps1",
      ]),
      "C:\\Users\\jam\\AppData\\Roaming\\npm\\codex.cmd",
    );
  });

  test("buildEnoentErrorMessage gives codex-specific, platform-aware guidance", () => {
    const msg = buildEnoentErrorMessage("codex");
    assert.match(msg, /Could not find the "codex"/);
    assert.match(msg, /CODEX_CLI_PATH/);
    assert.match(msg, /@openai\/codex/);
    assert.match(msg, process.platform === "win32" ? /where codex/ : /which codex/);
  });

  test("buildEnoentErrorMessage omits the codex install hint for other commands", () => {
    const msg = buildEnoentErrorMessage("agy");
    assert.match(msg, /Could not find the "agy"/);
    assert.doesNotMatch(msg, /@openai\/codex/);
  });

  test("CommandError is an Error that carries the exit code and captured stdout/stderr", () => {
    const err = new CommandError("Command failed with exit code 2: boom", 2, "out-data", "err-data");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "CommandError");
    assert.equal(err.exitCode, 2);
    assert.equal(err.stdout, "out-data"); // stdout preserved so codex callers can parse the event stream
    assert.equal(err.stderr, "err-data");
    assert.match(err.message, /exit code 2/);
  });
});
