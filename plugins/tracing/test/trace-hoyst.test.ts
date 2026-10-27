import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { seededIdGenerator } from "../src/instrumentation.js";
import { convertRollout } from "../src/trace.js";

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

const baseConfig: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  skill_tags: false,
  debug: false,
  fail_on_error: false,
  trace_name: "skill.zu_bestimmung",
  session_id: "case_a1:sr_test",
  version: "0.26.2",
  trace_seed: "sr_test",
};

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sessions");

function stageFixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-hoyst-"));
  fs.cpSync(fixturesRoot, path.join(dir, "sessions"), { recursive: true });
  return path.join(dir, "sessions", "2026", "06", "03");
}

const attr = (span: ReadableSpan, key: string): string | undefined =>
  span.attributes[key] == null ? undefined : String(span.attributes[key]);
const obsType = (span: ReadableSpan): string => attr(span, "langfuse.observation.type") ?? "";
const level = (span: ReadableSpan) => attr(span, "langfuse.observation.level");
const meta = (span: ReadableSpan, key: string) =>
  attr(span, `langfuse.observation.metadata.${key}`);
const parentId = (span: ReadableSpan): string | undefined =>
  (span as unknown as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
  (span as unknown as { parentSpanId?: string }).parentSpanId;
const byName = (name: string) => exporter.getFinishedSpans().filter((s) => s.name === name);

beforeAll(() => {
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    idGenerator: seededIdGenerator(),
  });
  provider.register();
});
afterAll(async () => {
  await provider.shutdown();
});
beforeEach(() => {
  exporter.reset();
});

describe("Hoyst skill run", () => {
  it("names the root, the helper and its turns, and nests the helper under its spawn", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-hoyst-main.jsonl"), { config: baseConfig });

    const [root] = byName("skill.zu_bestimmung");
    expect(root).toBeDefined();
    expect(obsType(root)).toBe("agent");
    expect(byName("Codex Turn")).toHaveLength(0);
    expect(byName("Codex Subagent Turn")).toHaveLength(0);

    const [spawn] = byName("helper:strang_c [zu-urteil]");
    expect(spawn).toBeDefined();
    expect(obsType(spawn)).toBe("tool");
    expect(meta(spawn, "hoyst.task_name")).toBe("strang_c");
    expect(meta(spawn, "hoyst.agent_type")).toBe("zu-urteil");
    expect(meta(spawn, "hoyst.model")).toBe("gpt-6.1-sol");
    expect(meta(spawn, "hoyst.effort")).toBe("high");
    expect(meta(spawn, "hoyst.fork_turns")).toBe("none");
    expect(meta(spawn, "hoyst.phase")).toBe("2");
    expect(meta(spawn, "hoyst.phase_label")).toBe("Prüfstränge A–E");

    const turns = exporter
      .getFinishedSpans()
      .filter((s) => s.name.startsWith("turn ") && obsType(s) === "agent")
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(turns.map((s) => s.name)).toEqual(["turn 1/2 · strang_c", "turn 2/2 · strang_c"]);
    for (const turn of turns) {
      expect(parentId(turn)).toBe(spawn.spanContext().spanId);
      expect(turn.spanContext().traceId).toBe(root.spanContext().traceId);
      expect(turn.attributes["langfuse.internal.is_app_root"]).toBe(false);
      expect(meta(turn, "hoyst.task_name")).toBe("strang_c");
      expect(meta(turn, "hoyst.agent_type")).toBe("zu-urteil");
      expect(meta(turn, "hoyst.nickname")).toBe("Dewey");
      expect(meta(turn, "hoyst.phase")).toBe("2");
      expect(meta(turn, "hoyst.turns")).toBe("2");
    }
    expect(meta(turns[0], "hoyst.turn")).toBe("1");
    // The helper's own tools and generations carry the helper's phase.
    const helperTool = exporter
      .getFinishedSpans()
      .find((s) => obsType(s) === "tool" && parentId(s) === turns[0].spanContext().spanId);
    expect(meta(helperTool!, "hoyst.phase")).toBe("2");
    expect(meta(helperTool!, "hoyst.cmds")).toBe("corpus hits");

    const [followup] = byName("followup:strang_c");
    expect(followup).toBeDefined();
    expect(meta(followup, "hoyst.target")).toBe("strang_c");
  });

  it("drops polling and tool-only steps to DEBUG and flags a failed hoyst command", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-hoyst-main.jsonl"), { config: baseConfig });

    const [wait] = byName("wait_agent");
    expect(level(wait)).toBe("DEBUG");

    const execs = byName("exec").filter((s) => meta(s, "hoyst.cmds") !== "corpus hits");
    const corpus = execs.find((s) => meta(s, "hoyst.cmds") === "corpus build")!;
    const freeze = execs.find((s) => meta(s, "hoyst.cmds") === "report freeze")!;
    expect(level(corpus)).toBeUndefined();
    expect(meta(corpus, "hoyst.exit_codes")).toBe("0");
    expect(level(freeze)).toBe("WARNING");
    expect(attr(freeze, "langfuse.observation.status_message")).toBe("exit 2");
    expect(meta(freeze, "hoyst.exit_codes")).toBe("2");

    const [root] = byName("skill.zu_bestimmung");
    const generations = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "LLM" && parentId(s) === root.spanContext().spanId)
      .sort((a, b) => Number(meta(a, "codex.step_index")) - Number(meta(b, "codex.step_index")));
    expect(generations.map(level)).toEqual([undefined, "DEBUG", undefined, undefined]);
  });

  it("stamps the orchestrator's phase from the hoyst commands it ran", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-hoyst-main.jsonl"), { config: baseConfig });

    const [root] = byName("skill.zu_bestimmung");
    const generations = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "LLM" && parentId(s) === root.spanContext().spanId)
      .sort((a, b) => Number(meta(a, "codex.step_index")) - Number(meta(b, "codex.step_index")));
    // Step 1 runs `corpus build` (phase 0 from then on), step 3 runs `report freeze` (4b).
    expect(generations.map((s) => meta(s, "hoyst.phase"))).toEqual([undefined, "0", "0", "4b"]);
    const corpus = byName("exec").find((s) => meta(s, "hoyst.cmds") === "corpus build")!;
    expect(meta(corpus, "hoyst.phase")).toBe("0");
    expect(byName("phase:0")).toHaveLength(0);
  });

  it("opens one span per phase when asked to", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-hoyst-main.jsonl"), {
      config: { ...baseConfig, phase_spans: true },
    });

    const [root] = byName("skill.zu_bestimmung");
    const [phase0] = byName("phase:0");
    const [phase4b] = byName("phase:4b");
    expect(phase0 && phase4b).toBeTruthy();
    expect(parentId(phase0)).toBe(root.spanContext().spanId);
    expect(parentId(phase4b)).toBe(root.spanContext().spanId);
    expect(meta(phase4b, "hoyst.phase_label")).toBe("Berichtstext");
    const generations = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "LLM")
      .sort((a, b) => Number(meta(a, "codex.step_index")) - Number(meta(b, "codex.step_index")));
    expect(parentId(generations[0])).toBe(root.spanContext().spanId);
    expect(parentId(generations[1])).toBe(phase0.spanContext().spanId);
    expect(parentId(generations[3])).toBe(phase4b.spanContext().spanId);
    // The helper still hangs under its spawn, which now sits inside phase 0.
    const [spawn] = byName("helper:strang_c [zu-urteil]");
    expect(parentId(spawn)).toBe(phase0.spanContext().spanId);
    // Phase spans end at the next boundary / the turn's end.
    expect(phase0.endTime[0]).toBeLessThanOrEqual(phase4b.startTime[0]);
  });

  it("derives the root span id from the trace seed so a caller can precompute it", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-hoyst-main.jsonl"), { config: baseConfig });
    const [root] = byName("skill.zu_bestimmung");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(root.spanContext().traceId).toBe(sha("sr_test:1").slice(0, 32));
    expect(root.spanContext().spanId).toBe(sha("sr_test:1:span:0").slice(0, 16));
    // Children follow the same seed: the upload is reproducible run to run.
    exporter.reset();
    await convertRollout(path.join(stageFixtures(), "rollout-hoyst-main.jsonl"), {
      config: baseConfig,
    });
    expect(byName("skill.zu_bestimmung")[0].spanContext().spanId).toBe(
      sha("sr_test:1:span:0").slice(0, 16),
    );
  });

  it("keeps upstream names for rollouts without Hoyst task names", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-parent.jsonl"), {
      config: { ...baseConfig, trace_name: undefined, trace_seed: undefined },
    });
    expect(byName("Codex Turn")).toHaveLength(1);
    expect(byName("Codex Subagent Turn")).toHaveLength(1);
    expect(byName("spawn_agent")).toHaveLength(1);
  });
});
