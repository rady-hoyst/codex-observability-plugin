import { describe, expect, it } from "vitest";

import {
  DEFAULT_PHASE_MAP,
  delegationName,
  execCommands,
  execInput,
  execOutput,
  exitCodes,
  generationLevel,
  helperFromSessionMeta,
  helperFromSpawnArgs,
  helperTurnInput,
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

  it("reads exit codes from Codex 0.162 outputs: a content array with quoted JSON inside", () => {
    // Real shape: custom_tool_call_output.output is an array of text parts, and the
    // exec tool's JSON sits inside a text part (quotes escaped once stringified).
    const real = tc("exec", "x", [
      { type: "input_text", text: "Script completed\nWall time 5.0 seconds\nOutput:\n" },
      {
        type: "input_text",
        text: '{"chunk_id":"b0","wall_time_seconds":5.0,"exit_code":1,"output":""}',
      },
    ]);
    expect(exitCodes(real)).toEqual([1]);
    expect(toolLevel(real)).toBe("WARNING");
    // The same output after JSON.stringify (quotes escaped).
    const stringified = tc("exec", "x", JSON.stringify(real.output));
    expect(exitCodes(stringified)).toEqual([1]);
    // A long-running session reports no exit code in its first output.
    const session = tc("exec", "x", [
      {
        type: "input_text",
        text: '{"chunk_id":"c1","wall_time_seconds":5.0,"session_id":26998,"output":""}',
      },
    ]);
    expect(exitCodes(session)).toEqual([]);
    expect(toolLevel(session)).toBeUndefined();
  });

  it("drops tool-only model steps to DEBUG", () => {
    const step = { startTime: 0, endTime: 1, toolCalls: [] };
    expect(generationLevel(step)).toBe("DEBUG");
    expect(generationLevel({ ...step, reasoning: "thinking" })).toBeUndefined();
    expect(generationLevel({ ...step, text: "done" })).toBeUndefined();
  });
});

describe("exec scripts (Codex 0.162)", () => {
  const exec = (input: unknown, output?: unknown) => tc("exec", input, output);
  const chunk = (fields: Record<string, unknown>) => ({
    type: "input_text",
    text: JSON.stringify({ chunk_id: "c1", wall_time_seconds: 0.01, ...fields }),
  });
  const header = { type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" };

  it("reads the command objects out of the JS wrapper", () => {
    expect(
      execCommands(
        exec(
          'text(await tools.exec_command({cmd:"hoyst version --check",max_output_tokens:3000}));\n',
        ),
      ),
    ).toEqual([{ cmd: "hoyst version --check", max_output_tokens: 3000 }]);
    // Several calls, escapes, a template literal, extra fields.
    const script =
      'text(await tools.exec_command({cmd:"printf \\"a\\\\tb\\\\n\\"",yield_time_ms:1000,max_output_tokens:2000}));\n' +
      "const r = await tools.exec_command({ cmd: `ls -la /work`, workdir: '/work/tmp' }); text(r);\n";
    expect(execCommands(exec(script))).toEqual([
      { cmd: 'printf "a\\tb\\n"', yield_time_ms: 1000, max_output_tokens: 2000 },
      { cmd: "ls -la /work", workdir: "/work/tmp" },
    ]);
    // ES shorthand `{cmd}` bound by a `const` in the script.
    expect(
      execCommands(
        exec(
          'const cmd = `hoyst corpus hits --query "SV"`;\ntext(await tools.exec_command({cmd, workdir:"/work"}));',
        ),
      ),
    ).toEqual([{ cmd: 'hoyst corpus hits --query "SV"', workdir: "/work" }]);
    // Quoted keys as models often write them; a template keeps its `${…}` verbatim.
    expect(
      execCommands(
        exec(
          'const r = await tools.exec_command({cmd:"hoyst register add P13.jsonl --partial","workdir":"/work/x","yield_time_ms":30000}); text(r.output);\n',
        ),
      ),
    ).toEqual([
      { cmd: "hoyst register add P13.jsonl --partial", workdir: "/work/x", yield_time_ms: 30000 },
    ]);
    expect(
      execCommands(
        exec("for (const f of files) text(await tools.exec_command({cmd:`cat /work/${f}`}));"),
      ),
    ).toEqual([{ cmd: "cat /work/${f}" }]);
    // Non-script arguments are not scripts.
    expect(execCommands(exec({ cmd: "ls" }))).toEqual([]);
    expect(execCommands(tc("spawn_agent", 'tools.exec_command({cmd:"x"})'))).toEqual([]);
  });

  it("shows one object per command as the input and keeps other scripts raw", () => {
    const one = 'text(await tools.exec_command({cmd:"hoyst case list",max_output_tokens:6000}));\n';
    expect(execInput(exec(one))).toEqual({ cmd: "hoyst case list", max_output_tokens: 6000 });
    const two =
      one + 'text(await tools.exec_command({cmd:"hoyst case mode",max_output_tokens:4000}));\n';
    expect(execInput(exec(two))).toEqual([
      { cmd: "hoyst case list", max_output_tokens: 6000 },
      { cmd: "hoyst case mode", max_output_tokens: 4000 },
    ]);
    const mixed = one + 'text(await tools.apply_patch("*** Begin Patch\\n*** End Patch"));\n';
    expect(execInput(exec(mixed))).toBe(mixed);
    const patch = 'text(await tools.apply_patch("*** Begin Patch\\n*** End Patch"));\n';
    expect(execInput(exec(patch))).toBe(patch);
    expect(execInput(exec({ cmd: "ls" }))).toEqual({ cmd: "ls" });
  });

  it("unwraps the Codex 0.162 output into the commands' plain text", () => {
    const one = exec('text(await tools.exec_command({cmd:"hoyst case list"}));', [
      header,
      chunk({ exit_code: 0, original_token_count: 5, output: "case_a1\ncase_b2\n" }),
    ]);
    expect(execOutput(one)).toBe("case_a1\ncase_b2");
    expect(exitCodes(one)).toEqual([0]);
    // Several commands: each output headed by its command; a truncation warning
    // and two chunks can share one text part.
    const two = exec(
      'text(await tools.exec_command({cmd:"hoyst case mode"}));\ntext(await tools.exec_command({cmd:"hoyst ref cli"}));\n',
      [
        header,
        {
          type: "input_text",
          text:
            "Warning: truncated output (original token count: 21551)\nTotal output lines: 2\n\n" +
            JSON.stringify({ chunk_id: "a", exit_code: 0, output: "modus: datenraum\n" }) +
            "\n" +
            JSON.stringify({
              chunk_id: "b",
              exit_code: 3,
              output: "FEHLER: Referenz 'cli' unbekannt.\n",
            }),
        },
      ],
    );
    expect(execOutput(two)).toBe(
      "Warning: truncated output (original token count: 21551)\nTotal output lines: 2\n" +
        "$ hoyst case mode\nmodus: datenraum\n$ hoyst ref cli\nFEHLER: Referenz 'cli' unbekannt.",
    );
    expect(exitCodes(two)).toEqual([0, 3]);
    // A long-running command reports a session instead of an exit code.
    const session = exec(
      'text(await tools.exec_command({cmd:"hoyst corpus build",yield_time_ms:1000}));',
      [header, chunk({ session_id: 7405, original_token_count: 0, output: "" })],
    );
    expect(execOutput(session)).toBe("(session 7405 still running)");
    // An image the script viewed keeps its data URI, so the SDK still uploads it.
    const URI = "data:image/png;base64,iVBORw0KGgo=";
    const image = exec('text(await tools.exec_command({cmd:"hoyst doc crop 12"}));', [
      header,
      { type: "input_image", image_url: URI, detail: "high" },
      chunk({ exit_code: 0, output: "crop written\n" }),
    ]);
    expect(execOutput(image)).toBe(`${URI}\ncrop written`);
    // A script that prints `r.output` itself leaves no chunk: its text is the output.
    const printed = exec(
      'const r = await tools.exec_command({cmd:"hoyst case list"}); text(r.output);',
      [header, { type: "input_text", text: "case_a1\ncase_b2\n" }],
    );
    expect(execOutput(printed)).toBe("case_a1\ncase_b2");
    expect(
      execOutput(
        exec("x", [
          {
            type: "input_text",
            text: "Script failed\nWall time 0.1 seconds\nOutput:\nTypeError: x",
          },
        ]),
      ),
    ).toBe("Script failed\nTypeError: x");
    // The same array once stringified (older rollouts) parses too.
    expect(execOutput(exec(one.args, JSON.stringify(one.output)))).toBe("case_a1\ncase_b2");
  });

  it("leaves other output shapes to the raw text", () => {
    const repr = "[{'type': 'input_text', 'text': '{\"exit_code\":0,\"output\":\"ok\"}'}]";
    expect(execOutput(exec("x", repr))).toBeUndefined();
    expect(execOutput(exec("x", "plain text"))).toBeUndefined();
    expect(execOutput(exec("x", []))).toBeUndefined();
    expect(execOutput(exec("x", undefined))).toBeUndefined();
    expect(
      execOutput(tc("wait_agent", {}, [header, chunk({ exit_code: 0, output: "x" })])),
    ).toBeUndefined();
  });
});

describe("helper turn input", () => {
  it("describes a helper whose brief is missing from its rollout", () => {
    const helper = helperFromSessionMeta({
      sessionId: "t",
      agentPath: "/root/strang_c",
      agentRole: "zu-urteil",
      agentNickname: "Dewey",
    });
    const phase = phaseFor("strang_c", "zu-urteil");
    const steps = [
      { startTime: 0, endTime: 1, toolCalls: [tc("wait_agent", { timeout_ms: 1 })] },
      {
        startTime: 1,
        endTime: 2,
        toolCalls: [
          tc(
            "exec",
            'text(await tools.exec_command({cmd:"hoyst corpus hits --query SV",max_output_tokens:3500}));',
          ),
          tc("exec", 'text(await tools.exec_command({cmd:"ls"}));'),
        ],
      },
    ];
    expect(helperTurnInput(helper, phase, steps)).toEqual({
      task_name: "strang_c",
      agent_type: "zu-urteil",
      phase: "2",
      phase_label: "Prüfstränge A–E",
      first_command: "hoyst corpus hits --query SV",
    });
    expect(helperTurnInput({ taskName: "provenienz_final" }, undefined, [])).toEqual({
      task_name: "provenienz_final",
    });
    // A script that cannot be read as commands contributes its first line, cut short.
    const script = [
      {
        startTime: 0,
        endTime: 1,
        toolCalls: [tc("exec", `const x = ${"y".repeat(300)};\ntext(x);`)],
      },
    ];
    expect(helperTurnInput(helper, undefined, script)?.first_command).toBe(
      `const x = ${"y".repeat(190)}…`,
    );
    expect(helperTurnInput({}, phase, steps)).toBeUndefined();
  });
});
