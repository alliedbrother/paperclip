import type { AdapterConfigFieldsProps } from "../types";

/**
 * Human agents have no adapter configuration — they don't execute runs.
 * Show an informational message instead of config fields.
 */
export function HumanConfigFields(_props: AdapterConfigFieldsProps) {
  return (
    <p className="text-xs text-muted-foreground italic">
      Human agents represent real people in the org chart.
      No adapter configuration is needed.
    </p>
  );
}
