import type { Scenario } from "./scenarios.ts";
import { findSensitive } from "./sensitive.ts";
import type { ToolCall, Transcript } from "./runner.ts";

export const BEHAVIOURS = ["opens_first", "captures_dumps", "keeps_their_words", "skips_noise", "never_stores_secrets", "recalls", "stays_quiet"] as const;
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
  /\b(open_brain|capture tool|recall tool)\b/i,
];

const WRITE_ROLES = new Set(["capture", "memory"]);
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
    const captures = turn.calls.filter((c) => c.role === "capture");
    const used = (role: string) => turn.calls.some((c) => c.role === role);

    if (expected.capture === "must") add("captures_dumps", captures.length > 0, i);
    if (expected.capture === "never") add("skips_noise", captures.length === 0, i, captures.length ? `${captures.length} capture(s)` : undefined);
    if (expected.captureIncludes && captures.length) {
      const sent = writtenText(captures).toLowerCase();
      const missing = expected.captureIncludes.filter((word) => !sent.includes(word.toLowerCase()));
      add("keeps_their_words", missing.length === 0, i, missing.length ? `missing: ${missing.join(", ")}` : undefined);
    }
    if (expected.recall === "must") add("recalls", used("recall"), i);
    if (expected.recall === "never") add("recalls", !used("recall"), i);
    if (turn.calls.some((c) => c.role === "open" || c.role === "capture" || c.role === "recall")) {
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
