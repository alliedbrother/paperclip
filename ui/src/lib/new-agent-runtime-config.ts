import { defaultCreateValues } from "../components/agent-config-defaults";

export function buildNewAgentRuntimeConfig(input?: {
  heartbeatEnabled?: boolean;
  intervalSec?: number;
  isHuman?: boolean;
}) {
  const isHuman = input?.isHuman ?? false;
  return {
    heartbeat: {
      enabled: isHuman ? false : (input?.heartbeatEnabled ?? defaultCreateValues.heartbeatEnabled),
      intervalSec: isHuman ? 0 : (input?.intervalSec ?? defaultCreateValues.intervalSec),
      wakeOnDemand: !isHuman,
      cooldownSec: 10,
      maxConcurrentRuns: isHuman ? 0 : 1,
    },
  };
}
