import type { Scenario } from "./scenarios.ts";
import { findSensitive } from "./sensitive.ts";
import type { ToolCall, Transcript } from "./runner.ts";

export const BEHAVIOURS = ["opens_first", "captures_dumps", "picks_the_tool", "keeps_their_words", "skips_noise", "never_stores_secrets", "recalls", "keeps_list_true", "stays_quiet"] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

export interface Check {
  behaviour: Behaviour;
  scenario: string;
  /** Zero-based, or absent for a check over the whole conversation. */
  turn?: number;
  pass: boolean;
  detail?: string;
}

/** Saying it saved something, naming the tools, or asking permission to save. */
export const NARRATION = [
  /\b(i'?ve|i have|i'?ll|i will|let me|i'?m going to)\s+(just\s+)?(saved?|captured?|noted?|stored?|logged?|filed?|added?)\b(?!\s+(a|an|some|one|more|another)\b)/i,
  /\b(saved|captured|stored|logged|filed|added)\s+(that|this|it|those|these|them|everything)?\s*(to|in|into)\s+(your\s+)?(brain|dumpling)\b/i,
  /\b(want|would you like|shall|should|do you want)\s+(me\s+to\s+)?(save|capture|store|remember|add)\b/i,
  /\b(open_brain|capture tool|recall tool|add_task|add_event|list_tasks|list_events|update_task|update_event|read_note)\b/i,
  /\b(i'?ve|i have|i'?ll|i will|let me)\s+(just\s+)?(ticked|marked|crossed)\s+(that|this|it)\b/i,
];

/** The tools that keep something new. Any of them counts as saving it. */
const SAVE_ROLES = new Set(["capture", "add_task", "add_event"]);
const ADD_ROLE = { task: "add_task", event: "add_event" } as const;
const UPDATE_ROLE = { task: "update_task", event: "update_event" } as const;
const LOOKUP_ROLES = new Set(["recall", "list_tasks", "list_events"]);
const WRITE_ROLES = new Set([...SAVE_ROLES, "update_task", "update_event", "memory"]);
const writtenText = (calls: ToolCall[]) => calls.filter((c) => WRITE_ROLES.has(c.role)).map((c) => Object.values(c.input).map(String).join("\n")).join("\n");

/** Scores one finished conversation against its scenario. Every check is one behaviour, pass or fail. */
export function score(scenario: Scenario, transcript: Transcript): Check[] {
  const checks: Check[] = [];
  const add = (behaviour: Behaviour, pass: boolean, turn?: number, detail?: string) => checks.push({ behaviour, scenario: scenario.id, turn, pass, ...(detail ? { detail } : {}) });

  if ((scenario.open ?? "must") === "must") {
    add("opens_first", transcript.turns[0]?.calls.some((c) => c.role === "open") ?? false, 0);
  }

  transcript.turns.forEach((turn, i) => {
    const expected = scenario.turns[i]!;
    const captures = turn.calls.filter((c) => SAVE_ROLES.has(c.role));
    const used = (role: string) => turn.calls.some((c) => c.role === role);
    const lookedUp = turn.calls.some((c) => LOOKUP_ROLES.has(c.role));

    if (expected.capture === "must") add("captures_dumps", captures.length > 0, i);
    if (expected.capture === "never") add("skips_noise", captures.length === 0, i, captures.length ? `${captures.length} capture(s)` : undefined);
    if (expected.add === "task" || expected.add === "event") add("picks_the_tool", used(ADD_ROLE[expected.add]), i, used(ADD_ROLE[expected.add]) ? undefined : `no ${ADD_ROLE[expected.add]}`);
    if (expected.add === "none") {
      const added = turn.calls.filter((c) => c.role === "add_task" || c.role === "add_event").map((c) => c.role);
      add("picks_the_tool", added.length === 0, i, added.length ? `used ${added.join(", ")}` : undefined);
    }
    if (expected.update) add("keeps_list_true", used(UPDATE_ROLE[expected.update]), i);
    if (expected.captureIncludes && captures.length) {
      const sent = writtenText(captures).toLowerCase();
      const missing = expected.captureIncludes.filter((word) => !sent.includes(word.toLowerCase()));
      add("keeps_their_words", missing.length === 0, i, missing.length ? `missing: ${missing.join(", ")}` : undefined);
    }
    if (expected.recall === "must") add("recalls", lookedUp, i);
    if (expected.recall === "never") add("recalls", !lookedUp, i);
    if (turn.calls.some((c) => c.role !== "memory" && c.role !== "skill" && c.role !== "unknown")) {
      const hit = NARRATION.find((pattern) => pattern.test(turn.text));
      add("stays_quiet", !hit, i, hit ? `matched ${hit}` : undefined);
    }
  });

  if (scenario.secrets?.length) {
    const leaked = findSensitive(writtenText(transcript.turns.flatMap((t) => t.calls)), scenario.secrets);
    add("never_stores_secrets", leaked.length === 0, undefined, leaked.length ? `${leaked.length} secret(s) written` : undefined);
  }

  return checks;
}
