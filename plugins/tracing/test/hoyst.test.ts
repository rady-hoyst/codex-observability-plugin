import { describe, expect, it } from "vitest";

import {
  DEFAULT_PHASE_MAP,
  delegationName,
  exitCodes,
  generationLevel,
  helperFromSessionMeta,
  helperFromSpawnArgs,
  hoystCommands,
  phaseBoundary,
  phaseFor,
  spawnObservationName,
  subagentTurnName,
  taskNameFromPath,
  toolLevel,
} from "../src/hoyst.js";
import type { ToolCall } from "../src/types.js";

const tc = (name: string, args: unknown, output?: unknown): ToolCall => ({
  callId: "c",
  name,
  args,
  startTime: 0,
  output,
});

describe("helper naming", () => {
  it("reads task, type, model, effort and fork mode from spawn_agent arguments", () => {
    const helper = helperFromSpawnArgs({
      task_name: "strang_c",
      agent_type: "zu-urteil",
      model: "gpt-6.1-sol",
      reasoning_effort: "high",
      fork_turns: "none",
      message: "gAAAA",
    });
    expect(helper).toEqual({
      taskName: "strang_c",
      agentType: "zu-urteil",
      model: "gpt-6.1-sol",
      effort: "high",
      forkTurns: "none",
    });
    expect(spawnObservationName(helper)).toBe("helper:strang_c [zu-urteil]");
    expect(spawnObservationName({ taskName: "sichtung_01" })).toBe("helper:sichtung_01");
    expect(spawnObservationName(helperFromSpawnArgs({ prompt: "tell a joke" }))).toBeUndefined();
  });

  it("treats Codex's role placeholder `default` as no role", () => {
    expect(
      helperFromSpawnArgs({ task_name: "x", agent_type: "default" }).agentType,
    ).toBeUndefined();
    expect(
      helperFromSessionMeta({
        sessionId: "t",
        agentPath: "/root/provenienz_final",
        agentRole: "default",
      }),
    ).toEqual({ taskName: "provenienz_final", agentType: undefined, nickname: undefined });
  });

  it("names helper turns after the task with their ordinal", () => {
    const helper = helperFromSessionMeta({
      sessionId: "t",
      agentPath: "/root/strang_c",
      agentRole: "zu-urteil",
      agentNickname: "Dewey",
    });
    expect(subagentTurnName(helper, 2, 3)).toBe("turn 2/3 · strang_c");
    expect(subagentTurnName(helper, 1, undefined)).toBe("turn 1 · strang_c");
    expect(subagentTurnName({}, 1, 1)).toBeUndefined();
    expect(taskNameFromPath("/root")).toBeUndefined();
    expect(taskNameFromPath("/root/a/b")).toBe("b");
  });

  it("names delegations after their target", () => {
    expect(delegationName(tc("followup_task", { target: "strang_c", message: "x" }))).toBe(
      "followup:strang_c",
    );
    expect(delegationName(tc("send_message", { target: "sichtung_03" }))).toBe(
      "message:sichtung_03",
    );
    expect(delegationName(tc("interrupt_agent", { target: "strang_a" }))).toBe(
      "interrupt:strang_a",
    );
    expect(delegationName(tc("wait_agent", { timeout_ms: 1 }))).toBeUndefined();
  });
});

describe("phases", () => {
  it("maps task names by longest prefix and falls back to the agent type", () => {
    expect(phaseFor("vollsichtung_03", undefined)).toEqual({
      phase: "0",
      label: "Inventar und Vollsichtung",
    });
    expect(phaseFor("strang_c", "zu-urteil")?.phase).toBe("2");
    expect(phaseFor("qc_provenienz", undefined)?.phase).toBe("5");
    expect(phaseFor("prose_welle_1", undefined)?.phase).toBe("4b");
    expect(phaseFor("heilung_patronat", undefined)?.phase).toBe("3");
    expect(phaseFor("unbekannt", "zu-recherche")?.phase).toBe("0");
    expect(phaseFor("unbekannt", "anfechtung-gegenleser")?.phase).toBe("G");
    expect(phaseFor("unbekannt", undefined)).toBeUndefined();
  });

  it("lets the environment override the table", () => {
    expect(phaseFor("heilung_x", undefined, { heilung: "5" })?.phase).toBe("5");
    expect(phaseFor("neu_1", "zu-urteil", { "type:zu-urteil": "3" })?.phase).toBe("3");
    expect(Object.keys(DEFAULT_PHASE_MAP)).toContain("type:zu-wuerdigung");
  });

  it("detects phase boundaries in the orchestrator's hoyst commands", () => {
    const exec = (cmd: string) =>
      tc("exec", `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}});`);
    expect(hoystCommands(exec("hoyst corpus build --case /work/x && hoyst corpus index"))).toEqual([
      "corpus build",
      "corpus index",
    ]);
    expect(hoystCommands(exec("hoyst report freeze --report x.json"))).toEqual(["report freeze"]);
    expect(hoystCommands(exec("hoyst --help"))).toEqual([]);
    expect(hoystCommands(exec("hoyst report --help"))).toEqual(["report"]);
    expect(hoystCommands(tc("spawn_agent", { task_name: "x" }))).toEqual([]);
    expect(phaseBoundary(["corpus build"])?.phase).toBe("0");
    expect(phaseBoundary(["report freeze"])?.phase).toBe("4b");
    expect(phaseBoundary(["report render"])?.phase).toBe("6");
    expect(phaseBoundary(["corpus hits"])).toBeUndefined();
  });
});

describe("levels", () => {
  it("drops polling tools to DEBUG and failed shell commands to WARNING", () => {
    expect(toolLevel(tc("wait_agent", { timeout_ms: 1 }))).toBe("DEBUG");
    expect(toolLevel(tc("list_agents", {}))).toBe("DEBUG");
    expect(toolLevel(tc("wait", {}))).toBe("DEBUG");
    const ok = tc(
      "exec",
      "x",
      "[{'type': 'input_text', 'text': '{\"exit_code\":0,\"output\":\"\"}'}]",
    );
    const bad = tc(
      "exec",
      "x",
      "[{'type': 'input_text', 'text': '{\"exit_code\":2,\"output\":\"\"}'}]",
    );
    expect(exitCodes(ok)).toEqual([0]);
    expect(exitCodes(bad)).toEqual([2]);
    expect(toolLevel(ok)).toBeUndefined();
    expect(toolLevel(bad)).toBe("WARNING");
    expect(toolLevel(tc("exec", "x", "no codes here"))).toBeUndefined();
  });

  it("drops tool-only model steps to DEBUG", () => {
    const step = { startTime: 0, endTime: 1, toolCalls: [] };
    expect(generationLevel(step)).toBe("DEBUG");
    expect(generationLevel({ ...step, reasoning: "thinking" })).toBeUndefined();
    expect(generationLevel({ ...step, text: "done" })).toBeUndefined();
  });
});
