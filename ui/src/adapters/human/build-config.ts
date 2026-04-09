import type { CreateConfigValues } from "../types";

/** Human agents need no adapter config. */
export function buildHumanConfig(_v: CreateConfigValues): Record<string, unknown> {
  return {};
}
