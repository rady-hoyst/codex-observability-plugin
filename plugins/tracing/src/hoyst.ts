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
