/**
 * Hoyst-specific naming for Codex skill runs (ZU-Bestimmung, Anfechtungsschreiben,
 * D&O-Check): helpers get their task name and phase, polling tools and
 * tool-only model steps drop to DEBUG, failed shell commands become WARNING.
 *
 * Pure functions only, no SDK imports: `trace.ts` calls them at a handful of
 * sites so the fork stays easy to rebase on upstream. Everything here is a
 * no-op for rollouts without Hoyst task names (upstream fixtures keep their
 * names).
 */

import type { ModelStep, SessionMeta, ToolCall } from "./types.js";
import { toText } from "./utils.js";

export type HelperInfo = {
  taskName?: string;
  agentType?: string;
  model?: string;
  effort?: string;
  forkTurns?: string;
  nickname?: string;
};

export type Phase = { phase: string; label: string };

/** German labels per phase id, metadata only (`hoyst.phase_label`). */
export const PHASE_LABELS: Record<string, string> = {
  "0": "Inventar und Vollsichtung",
  "1": "Verfahrenseckdaten",
  "2": "Prüfstränge A–E",
  "3": "Würdigung und Prüfwelle",
  "3.6": "Kurzfassung",
  "4a": "Strukturdaten und Freeze",
  "4b": "Berichtstext",
  "5": "QC und Red Team",
  "6": "Rendern",
  "7": "Aufräumen",
  A: "Dossier",
  B: "Bearbeitung",
  C: "Fachprüfung",
  D: "Überarbeitung",
  E: "Sichtprüfung",
  F: "Empfängerprüfung",
  G: "Gegenlesen",
};

/**
 * Task-name prefix (or `type:<agent_type>`) → phase id. Longest matching prefix
 * wins; the agent type is the fallback. `LANGFUSE_CODEX_PHASE_MAP` (JSON) is
 * merged over this table.
 */
export const DEFAULT_PHASE_MAP: Record<string, string> = {
  vollsichtung: "0",
  sichtung: "0",
  tiefe: "0",
  inventar: "0",
  strang: "2",
  wuerdigung: "3",
  skeptiker: "3",
  anwalt: "3",
  sprung: "3",
  schlichter: "3",
  datumsfreigabe: "3",
  heilung: "3",
  kurzfassung: "3.6",
  struktur: "4a",
  prose: "4b",
  prosa: "4b",
  bericht: "4b",
  qc: "5",
  provenienz: "5",
  redteam: "5",
  lesetest: "5",
  render: "6",
  "type:zu-recherche": "0",
  "type:zu-urteil": "2",
  "type:zu-wuerdigung": "3",
  "type:anfechtung-dossier": "A",
  "type:anfechtung-bearbeiter": "B",
  "type:anfechtung-bearbeiter-15b": "B",
  "type:anfechtung-fachpruefer": "C",
  "type:anfechtung-sichtpruefer": "E",
  "type:anfechtung-empfaengerpruefer": "F",
  "type:anfechtung-gegenleser": "G",
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** `agent_role: "default"` is Codex's placeholder, not a Hoyst role. */
const asRole = (value: unknown): string | undefined => {
  const text = asString(value);
  return text && text !== "default" ? text : undefined;
};

/** The task name is the last segment of Codex's `agent_path` (`/root/strang_c`). */
export function taskNameFromPath(agentPath: unknown): string | undefined {
  const text = asString(agentPath);
  if (!text) return undefined;
  const last = text.split("/").filter(Boolean).at(-1);
  return last && last !== "root" ? last : undefined;
}

export function helperFromSpawnArgs(args: unknown): HelperInfo {
  if (args == null || typeof args !== "object") return {};
  const a = args as Record<string, unknown>;
  return {
    taskName: asString(a.task_name),
    agentType: asRole(a.agent_type),
    model: asString(a.model),
    effort: asString(a.reasoning_effort) ?? asString(a.effort),
    forkTurns: asString(a.fork_turns),
  };
}

export function helperFromSessionMeta(meta: SessionMeta): HelperInfo {
  return {
    taskName: taskNameFromPath(meta.agentPath),
    agentType: asRole(meta.agentRole),
    nickname: asString(meta.agentNickname),
  };
}

export function phaseFor(
  taskName: string | undefined,
  agentType: string | undefined,
  overrides?: Record<string, string>,
): Phase | undefined {
  const map = { ...DEFAULT_PHASE_MAP, ...(overrides ?? {}) };
  let best: string | undefined;
  let bestLength = 0;
  if (taskName) {
    const task = taskName.toLowerCase();
    for (const [prefix, phase] of Object.entries(map)) {
      if (prefix.startsWith("type:")) continue;
      const key = prefix.toLowerCase();
      if (task.startsWith(key) && key.length > bestLength) {
        best = phase;
        bestLength = key.length;
      }
    }
  }
  if (best === undefined && agentType) best = map[`type:${agentType.toLowerCase()}`];
  if (best === undefined) return undefined;
  return { phase: best, label: PHASE_LABELS[best] ?? best };
}

/** `helper:strang_c [zu-urteil]`; without a task name the plain tool name. */
export function spawnObservationName(helper: HelperInfo): string | undefined {
  if (!helper.taskName) return undefined;
  return helper.agentType
    ? `helper:${helper.taskName} [${helper.agentType}]`
    : `helper:${helper.taskName}`;
}

/** `turn 2/3 · strang_c`; without a task name `undefined` (keep the upstream name). */
export function subagentTurnName(
  helper: HelperInfo,
  turnNumber: number | undefined,
  turnCount: number | undefined,
): string | undefined {
  if (!helper.taskName) return undefined;
  if (turnNumber && turnCount) return `turn ${turnNumber}/${turnCount} · ${helper.taskName}`;
  if (turnNumber) return `turn ${turnNumber} · ${helper.taskName}`;
  return `turn · ${helper.taskName}`;
}

const DELEGATION_TOOLS: Record<string, string> = {
  followup_task: "followup",
  send_message: "message",
  interrupt_agent: "interrupt",
};

/** `followup:strang_c`, `message:sichtung_03`, `interrupt:strang_a`. */
export function delegationName(tc: ToolCall): string | undefined {
  const prefix = DELEGATION_TOOLS[tc.name];
  if (!prefix || tc.args == null || typeof tc.args !== "object") return undefined;
  const target = asString((tc.args as Record<string, unknown>).target);
  return target ? `${prefix}:${target}` : undefined;
}

export function delegationTarget(tc: ToolCall): string | undefined {
  if (!(tc.name in DELEGATION_TOOLS) || tc.args == null || typeof tc.args !== "object") {
    return undefined;
  }
  return asString((tc.args as Record<string, unknown>).target);
}

const POLLING_TOOLS = new Set(["wait", "wait_agent", "list_agents"]);
const SHELL_TOOLS = new Set(["exec", "exec_command", "shell", "local_shell", "bash"]);

/** The shell text a tool call ran, if any (JS `tools.exec_command({cmd:"…"})` or args). */
export function shellText(tc: ToolCall): string | undefined {
  if (!SHELL_TOOLS.has(tc.name)) return undefined;
  if (typeof tc.args === "string") return tc.args;
  if (tc.args == null || typeof tc.args !== "object") return undefined;
  const args = tc.args as Record<string, unknown>;
  for (const field of ["cmd", "command", "code"]) {
    const value = args[field];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((part) => toText(part)).join(" ");
  }
  return undefined;
}

const HOYST_COMMAND = /\bhoyst\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g;
const COMMAND_FLAGS = new Set(["--help", "-h"]);

/** `hoyst report freeze` → `report freeze`; one entry per distinct command, in order. */
export function hoystCommands(tc: ToolCall): string[] {
  const text = shellText(tc);
  if (!text || !text.includes("hoyst")) return [];
  const out: string[] = [];
  for (const match of text.matchAll(HOYST_COMMAND)) {
    const verb = match[2] && !COMMAND_FLAGS.has(match[2]) ? ` ${match[2]}` : "";
    const command = `${match[1]}${verb}`;
    if (!out.includes(command)) out.push(command);
  }
  return out;
}

// The code sits in JSON that Codex itself quotes (`{\"exit_code\":0,…}` inside a
// text part), so the quotes may carry backslashes.
const EXIT_CODE = /\\*"exit_code\\*"\s*:\s*(-?\d+)/g;

/** The readable text of a tool output: text parts of a content array, else the whole thing. */
function outputText(output: unknown): string {
  if (Array.isArray(output)) {
    const parts = output
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : toText(part),
      )
      .filter(Boolean);
    return parts.join("\n");
  }
  return toText(output);
}

/** Exit codes of the commands an exec call ran, as Codex reports them in the output. */
export function exitCodes(tc: ToolCall): number[] {
  if (!SHELL_TOOLS.has(tc.name) || tc.output == null) return [];
  const text = outputText(tc.output);
  if (!text.includes("exit_code")) return [];
  const codes: number[] = [];
  for (const match of text.matchAll(EXIT_CODE)) codes.push(Number(match[1]));
  return codes;
}

// ---------------------------------------------------------------------------
// Codex 0.162 exec scripts. The exec tool runs a JS snippet such as
// `text(await tools.exec_command({cmd:"hoyst case list",max_output_tokens:3500}));`
// and answers with text parts, one JSON chunk per command:
// `{"chunk_id":"…","wall_time_seconds":0.2,"exit_code":0,"output":"…"}`.
// A domain reader wants the command and its output, not the wrapper.

export type ExecCommand = { cmd: string } & Record<string, string | number | boolean>;

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/** The JS string literal whose opening quote sits at `start`; a template keeps its `${…}` verbatim. */
function readStringLiteral(
  script: string,
  start: number,
): { value: string; end: number } | undefined {
  const quote = script[start];
  let out = "";
  for (let i = start + 1; i < script.length; i++) {
    const ch = script[i];
    if (ch === "\\") {
      const next = script[i + 1];
      if (next === undefined) return undefined;
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(script.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(script.slice(i + 2, i + 6), 16));
        i += 5;
      } else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(script.slice(i + 2, i + 4))) {
        out += String.fromCharCode(parseInt(script.slice(i + 2, i + 4), 16));
        i += 3;
      } else {
        if (next !== "\n") out += SIMPLE_ESCAPES[next] ?? next;
        i += 1;
      }
      continue;
    }
    if (ch === quote) return { value: out, end: i + 1 };
    if (quote === "`" && ch === "$" && script[i + 1] === "{") {
      let depth = 0;
      let j = i;
      for (; j < script.length; j++) {
        if (script[j] === "{") depth += 1;
        else if (script[j] === "}" && --depth === 0) break;
      }
      if (j >= script.length) return undefined;
      out += script.slice(i, j + 1);
      i = j;
      continue;
    }
    out += ch;
  }
  return undefined;
}

const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/;

/** The string a `const name = "…"` in the script binds (ES shorthand `{cmd}` properties). */
function boundString(script: string, name: string): string | undefined {
  // The name goes into a pattern; only an identifier can be bound, and only an
  // identifier is safe there (`$` escaped below).
  if (!IDENTIFIER_NAME.test(name)) return undefined;
  const pattern = new RegExp(
    `(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*=\\s*(?=["'\`])`,
  );
  const match = pattern.exec(script);
  return match ? readStringLiteral(script, match.index + match[0].length)?.value : undefined;
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const NUMBER = /-?\d+(?:\.\d+)?/y;
const SEPARATORS = /[\s,]*/y;

/** The object literal of one `tools.exec_command({…})` call, its `{` at `start`. */
function readCallObject(script: string, start: number): ExecCommand | undefined {
  const out: Record<string, string | number | boolean> = {};
  let i = start + 1;
  const skip = () => {
    SEPARATORS.lastIndex = i;
    SEPARATORS.exec(script);
    i = SEPARATORS.lastIndex;
  };
  const at = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = i;
    return pattern.exec(script)?.[0];
  };
  for (;;) {
    skip();
    if (script[i] === "}") break;
    let key: string | undefined;
    const quoted = script[i] === '"' || script[i] === "'";
    if (quoted) {
      const literal = readStringLiteral(script, i);
      if (!literal) return undefined;
      key = literal.value;
      i = literal.end;
    } else {
      key = at(IDENTIFIER);
      if (!key) return undefined;
      i += key.length;
    }
    skip();
    let value: string | number | boolean | undefined;
    if (script[i] !== ":") {
      // Shorthand exists for identifiers only. A quoted key without a value means
      // the script's quoting is broken and the "key" is a run of code up to the
      // next quote, e.g. `max_output_tokens:12000}),  tools.exec_command({cmd:`.
      if (quoted) return undefined;
      value = boundString(script, key);
    } else {
      i += 1;
      skip();
      const ch = script[i];
      const number = at(NUMBER);
      if (ch === '"' || ch === "'" || ch === "`") {
        const literal = readStringLiteral(script, i);
        if (!literal) return undefined;
        value = literal.value;
        i = literal.end;
      } else if (number) {
        value = Number(number);
        i += number.length;
      } else {
        const ident = at(IDENTIFIER);
        if (!ident) return undefined;
        value =
          ident === "true" || ident === "false" ? ident === "true" : boundString(script, ident);
        i += ident.length;
      }
    }
    if (value === undefined) return undefined;
    out[key] = value;
  }
  return typeof out.cmd === "string" ? (out as ExecCommand) : undefined;
}

const EXEC_CALL = /tools\.exec_command\s*\(\s*(?=\{)/g;
const OTHER_TOOL_CALL = /tools\.(?!exec_command\b)[A-Za-z_$][\w$]*\s*\(/;

/** Every `tools.exec_command({…})` call of an exec script, in order; `undefined` where one cannot be read. */
function scriptCalls(tc: ToolCall): Array<ExecCommand | undefined> {
  if (!SHELL_TOOLS.has(tc.name) || typeof tc.args !== "string") return [];
  const script = tc.args;
  return Array.from(script.matchAll(EXEC_CALL), (match) => {
    // The script is the agent's own text and may be broken JS; a call the
    // reader trips over is unreadable, never a failed turn.
    try {
      return readCallObject(script, match.index + match[0].length);
    } catch {
      return undefined;
    }
  });
}

/** The `tools.exec_command({…})` calls of an exec script that can be read, in order; none for other shapes. */
export function execCommands(tc: ToolCall): ExecCommand[] {
  return scriptCalls(tc).filter((call): call is ExecCommand => call !== undefined);
}

/**
 * The input of an exec observation: the command object of a Codex 0.162 script
 * (`{cmd, max_output_tokens}`; an array when the script ran several commands),
 * else the raw arguments (older shapes, scripts that also patch files or read
 * images, scripts with a call that cannot be read).
 */
export function execInput(tc: ToolCall): unknown {
  if (typeof tc.args !== "string") return tc.args;
  const calls = scriptCalls(tc);
  if (calls.length === 0 || calls.includes(undefined) || OTHER_TOOL_CALL.test(tc.args)) {
    return tc.args;
  }
  return calls.length === 1 ? calls[0] : calls;
}

type ExecChunk = { output: string; exit_code?: unknown; session_id?: unknown };
const HEADER_LINE = /^(Script completed|Wall time .*|Output:)$/;

/** The JSON chunk Codex writes per command, if the line is one. */
function execChunk(line: string): ExecChunk | undefined {
  if (!line.startsWith("{") || !line.includes('"output"')) return undefined;
  try {
    const parsed = JSON.parse(line) as { output?: unknown } | null;
    return parsed && typeof parsed.output === "string" ? (parsed as ExecChunk) : undefined;
  } catch {
    return undefined;
  }
}

/** The text parts of an output, from the array itself or its JSON text. */
function outputParts(output: unknown): unknown[] | undefined {
  if (Array.isArray(output)) return output;
  if (typeof output !== "string" || !output.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The output of an exec observation as plain text: the `output` of every command
 * chunk (headed by its command when the script ran several) or the text the script
 * printed itself, warnings kept, the "Script completed / Wall time / Output:" header
 * dropped, images as their data URI. `undefined` for other shapes, so the caller
 * keeps the raw text.
 */
export function execOutput(tc: ToolCall): string | undefined {
  if (!SHELL_TOOLS.has(tc.name)) return undefined;
  const parts = outputParts(tc.output);
  if (!parts) return undefined;
  const entries: Array<string | ExecChunk> = [];
  let chunks = 0;
  let textParts = 0;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const { type, text, image_url } = part as {
      type?: unknown;
      text?: unknown;
      image_url?: unknown;
    };
    if (typeof text !== "string") {
      // The data URI stays in the text: the Langfuse SDK finds it there, uploads
      // the image and replaces it with a media tag (docs: PLAN_TRACING_NACHLAUF).
      if (type === "input_image")
        entries.push(typeof image_url === "string" ? image_url : "[image]");
      continue;
    }
    textParts += 1;
    for (const line of text.split("\n")) {
      const chunk = execChunk(line);
      if (chunk) {
        entries.push(chunk);
        chunks += 1;
      } else if (line.trim() && !HEADER_LINE.test(line)) entries.push(line);
    }
  }
  // A script that printed `r.output` itself has no chunk: its text is the output.
  if (textParts === 0 && entries.length === 0) return undefined;
  const commands = scriptCalls(tc);
  const labelled =
    commands.length > 1 && commands.length === chunks && !commands.includes(undefined);
  let index = 0;
  return entries
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const command = labelled ? commands[index] : undefined;
      index += 1;
      const running =
        entry.exit_code === undefined && entry.session_id !== undefined
          ? `(session ${String(entry.session_id)} still running)`
          : "";
      return [command ? `$ ${command.cmd}` : "", entry.output.trimEnd(), running]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

/** The first line of a script that could not be read as commands, cut to a readable length. */
function firstLine(text: string | undefined): string | undefined {
  const line = text?.split("\n").find((candidate) => candidate.trim());
  if (!line) return undefined;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Input of a helper turn whose brief is not in its rollout (Codex encrypts it in
 * the parent's spawn_agent call): what the helper is, its phase and the first
 * command it ran.
 */
export function helperTurnInput(
  helper: HelperInfo,
  phase: Phase | undefined,
  steps: readonly ModelStep[],
): Record<string, unknown> | undefined {
  if (!helper.taskName) return undefined;
  const firstExec = steps.flatMap((step) => step.toolCalls).find((tc) => SHELL_TOOLS.has(tc.name));
  const firstCommand = firstExec
    ? (scriptCalls(firstExec)[0]?.cmd ?? firstLine(shellText(firstExec)))
    : undefined;
  return {
    task_name: helper.taskName,
    ...(helper.agentType ? { agent_type: helper.agentType } : {}),
    ...(phase ? { phase: phase.phase, phase_label: phase.label } : {}),
    ...(firstCommand ? { first_command: firstCommand } : {}),
  };
}

/** DEBUG for polling, WARNING for a shell command that exited non-zero. */
export function toolLevel(tc: ToolCall): "DEBUG" | "WARNING" | undefined {
  if (POLLING_TOOLS.has(tc.name)) return "DEBUG";
  if (exitCodes(tc).some((code) => code !== 0)) return "WARNING";
  return undefined;
}

/** A model step with neither prose nor a reasoning summary is a tool-only step. */
export function generationLevel(step: ModelStep): "DEBUG" | undefined {
  return !step.text && !step.reasoning ? "DEBUG" : undefined;
}

/** Orchestrator commands that open a phase of the ZU skill. */
const PHASE_BOUNDARIES: Array<[RegExp, string]> = [
  [/^corpus build\b/, "0"],
  [/^report skeleton\b/, "3"],
  [/^report freeze\b/, "4b"],
  [/^report validate\b/, "5"],
  [/^report render\b/, "6"],
  [/^report cleanup\b/, "7"],
];

export function phaseBoundary(commands: readonly string[]): Phase | undefined {
  let found: Phase | undefined;
  for (const command of commands) {
    for (const [pattern, phase] of PHASE_BOUNDARIES) {
      if (pattern.test(command)) found = { phase, label: PHASE_LABELS[phase] ?? phase };
    }
  }
  return found;
}

/** Metadata keys shared by spawn, helper turn and delegation observations. */
export function helperMetadata(
  helper: HelperInfo,
  phase: Phase | undefined,
): Record<string, unknown> {
  return {
    ...(helper.taskName ? { "hoyst.task_name": helper.taskName } : {}),
    ...(helper.agentType ? { "hoyst.agent_type": helper.agentType } : {}),
    ...(helper.model ? { "hoyst.model": helper.model } : {}),
    ...(helper.effort ? { "hoyst.effort": helper.effort } : {}),
    ...(helper.forkTurns ? { "hoyst.fork_turns": helper.forkTurns } : {}),
    ...(helper.nickname ? { "hoyst.nickname": helper.nickname } : {}),
    ...phaseMetadata(phase),
  };
}

export function phaseMetadata(phase: Phase | undefined): Record<string, unknown> {
  return phase ? { "hoyst.phase": phase.phase, "hoyst.phase_label": phase.label } : {};
}
