import type { TranscriptEntry } from "../types";

/** Human agents don't produce stdout — pass through as plain text. */
export function parseHumanStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
