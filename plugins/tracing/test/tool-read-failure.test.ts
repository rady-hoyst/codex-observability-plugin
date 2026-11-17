import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config.js";
import { convertRollout } from "../src/trace.js";

// Hoyst fork: one exec reader is made to throw for a single call, standing in
// for any bug in the readers of hoyst.ts.
vi.mock("../src/hoyst.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hoyst.js")>();
  return {
    ...actual,
    execOutput: vi.fn((tc: Parameters<typeof actual.execOutput>[0]) => {
      if (tc.callId === "call-boom") throw new Error("reader boom");
      return actual.execOutput(tc);
    }),
  };
});

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

// fail_on_error as the Hoyst uploader runs it: any failed turn aborts the upload.
const config: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  skill_tags: false,
  debug: false,
  fail_on_error: true,
};

// The quote after "max_output_tokens is missing (shape of a ZU run that could not be uploaded).
const BROKEN =
  "const [a, b] = await Promise.all([tools.exec_command({cmd:\"sed -n '1,80p' akte.md\", " +
  '"max_output_tokens:12000}),  tools.exec_command({cmd:"rg -n Zahlung akte.md", max_output_tokens:12000})]);';
const PLAIN = 'text(await tools.exec_command({cmd:"hoyst case list",max_output_tokens:3500}));';

const line = (ts: string, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: ts, type, payload });
const output = (text: string) => [
  { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
  { type: "input_text", text: JSON.stringify({ chunk_id: "c", exit_code: 0, output: text }) },
];

function stageRollout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-tool-read-"));
  const sessionsDir = path.join(dir, "sessions", "2026", "11", "12");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, "rollout-tool-read.jsonl");
  const calls: Array<[string, string, string]> = [
    ["call-broken", BROKEN, "Zahlung 1\n"],
    ["call-boom", PLAIN, "case_a1\n"],
    ["call-after", PLAIN, "case_a1\n"],
  ];
  const lines = [
    line("2026-11-12T10:00:00.000Z", "session_meta", { id: "sess-tool-read" }),
    line("2026-11-12T10:00:00.100Z", "event_msg", { type: "task_started", turn_id: "turn-1" }),
    line("2026-11-12T10:00:00.200Z", "event_msg", { type: "user_message", message: "go" }),
  ];
  calls.forEach(([callId, input, text], n) => {
    lines.push(
      line(`2026-11-12T10:00:0${n + 1}.000Z`, "response_item", {
        type: "custom_tool_call",
        call_id: callId,
        name: "exec",
        input,
      }),
      line(`2026-11-12T10:00:0${n + 1}.500Z`, "response_item", {
        type: "custom_tool_call_output",
        call_id: callId,
        output: output(text),
      }),
    );
  });
  lines.push(
    line("2026-11-12T10:00:05.000Z", "event_msg", { type: "token_count" }),
    line("2026-11-12T10:00:06.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "fertig" }],
    }),
    line("2026-11-12T10:00:06.100Z", "event_msg", { type: "token_count" }),
    line("2026-11-12T10:00:06.200Z", "event_msg", { type: "task_complete", turn_id: "turn-1" }),
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

beforeAll(() => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe("an exec call the Hoyst readers cannot handle", () => {
  it("is shown raw and does not fail its turn or the upload", async () => {
    const exported = await convertRollout(stageRollout(), { config });
    expect(exported).toEqual(["turn-1"]);

    const spans = exporter.getFinishedSpans();
    const attr = (callId: string, key: string) => {
      const span = spans.find(
        (s) => s.attributes["langfuse.observation.metadata.codex.call_id"] === callId,
      );
      expect(span, callId).toBeDefined();
      const value = span!.attributes[key];
      return value == null ? undefined : String(value);
    };
    const [root] = spans.filter((s) => s.name === "Codex Turn");
    expect(root.attributes["langfuse.observation.level"]).toBeUndefined();

    // Broken quoting: the raw script as input, the output still unwrapped.
    expect(attr("call-broken", "langfuse.observation.input")).toBe(BROKEN);
    expect(attr("call-broken", "langfuse.observation.output")).toBe("Zahlung 1");
    expect(attr("call-broken", "langfuse.observation.metadata.hoyst.read_error")).toBeUndefined();

    // A reader that throws: the call as upstream shows it, the error in metadata.
    expect(attr("call-boom", "langfuse.observation.input")).toBe(PLAIN);
    expect(attr("call-boom", "langfuse.observation.output")).toContain("Script completed");
    expect(attr("call-boom", "langfuse.observation.metadata.hoyst.read_error")).toBe("reader boom");

    // The calls after it are read as usual.
    expect(JSON.parse(attr("call-after", "langfuse.observation.input")!)).toEqual({
      cmd: "hoyst case list",
      max_output_tokens: 3500,
    });
    expect(attr("call-after", "langfuse.observation.output")).toBe("case_a1");
  });
});
