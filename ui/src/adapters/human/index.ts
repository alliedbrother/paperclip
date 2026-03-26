import type { UIAdapterModule } from "../types";
import { parseHumanStdoutLine } from "./parse-stdout";
import { HumanConfigFields } from "./config-fields";
import { buildHumanConfig } from "./build-config";

export const humanUIAdapter: UIAdapterModule = {
  type: "human",
  label: "Human",
  parseStdoutLine: parseHumanStdoutLine,
  ConfigFields: HumanConfigFields,
  buildAdapterConfig: buildHumanConfig,
};
