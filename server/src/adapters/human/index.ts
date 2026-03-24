import type { ServerAdapterModule } from "../types.js";

/**
 * Human adapter — a noop adapter for human proxy agents.
 *
 * Human agents appear in the org chart and can be managers / assignees,
 * but they never execute heartbeat runs.  The heartbeat scheduler already
 * skips agents whose heartbeat policy is disabled, so this adapter's
 * `execute` should never be called in practice.  If it is, it returns
 * immediately with a noop result.
 */
export const humanAdapter: ServerAdapterModule = {
  type: "human",

  async execute() {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
    };
  },

  async testEnvironment() {
    return {
      adapterType: "human",
      status: "pass" as const,
      checks: [
        {
          code: "human.noop",
          level: "info" as const,
          message: "Human agents do not require an execution environment.",
        },
      ],
      testedAt: new Date().toISOString(),
    };
  },

  models: [],
  supportsLocalAgentJwt: false,
  agentConfigurationDoc: `# human agent configuration

Adapter: human

Human agents represent real people in the org chart.
They do not execute heartbeat runs — they participate as
managers, issue assignees, and goal owners through the UI.

No adapter configuration is needed.
`,
};
