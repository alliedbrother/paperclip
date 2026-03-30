import { useState } from "react";
import { cn } from "../lib/utils";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Plain circle with no interactivity — used inside dropdown options. */
function StatusCircle({ status, className }: { status: string; className?: string }) {
  const colorClass = issueStatusIcon[status] ?? issueStatusIconDefault;
  return (
    <span
      className={cn(
        "relative inline-flex h-4 w-4 rounded-full border-2 shrink-0",
        colorClass,
        className,
      )}
    >
      {status === "done" && (
        <span className="absolute inset-0 m-auto h-2 w-2 rounded-full bg-current" />
      )}
    </span>
  );
}

interface StatusIconProps {
  status: string;
  onChange?: (status: string) => void;
  className?: string;
  showLabel?: boolean;
}

export function StatusIcon({ status, onChange, className, showLabel }: StatusIconProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);

  const circle = <StatusCircle status={status} className={cn(onChange && !showLabel && "cursor-pointer", className)} />;

  // ── Read-only (no onChange) ──
  if (!onChange) {
    if (showLabel) {
      return (
        <span className="inline-flex items-center gap-1.5">
          {circle}
          <span className="text-sm">{statusLabel(status)}</span>
        </span>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{circle}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">{statusLabel(status)}</TooltipContent>
      </Tooltip>
    );
  }

  // ── Editable with label visible — no tooltip needed ──
  if (showLabel) {
    return (
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
            {circle}
            <span className="text-sm">{statusLabel(status)}</span>
          </button>
        </PopoverTrigger>
        <StatusDropdown status={status} onChange={onChange} onClose={() => setPopoverOpen(false)} />
      </Popover>
    );
  }

  // ── Editable icon-only — tooltip on hover, popover on click ──
  return (
    <Tooltip open={popoverOpen ? false : undefined}>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <span className="inline-flex">{circle}</span>
          </PopoverTrigger>
        </TooltipTrigger>
        <StatusDropdown status={status} onChange={onChange} onClose={() => setPopoverOpen(false)} />
      </Popover>
      <TooltipContent side="top" className="text-xs">{statusLabel(status)}</TooltipContent>
    </Tooltip>
  );
}

/** Shared dropdown used by all editable StatusIcon variants. Uses plain StatusCircle to avoid recursive tooltips. */
function StatusDropdown({
  status,
  onChange,
  onClose,
}: {
  status: string;
  onChange: (status: string) => void;
  onClose: () => void;
}) {
  return (
    <PopoverContent className="w-40 p-1" align="start">
      {allStatuses.map((s) => (
        <Button
          key={s}
          variant="ghost"
          size="sm"
          className={cn("w-full justify-start gap-2 text-xs", s === status && "bg-accent")}
          onClick={() => {
            onChange(s);
            onClose();
          }}
        >
          <StatusCircle status={s} />
          {statusLabel(s)}
        </Button>
      ))}
    </PopoverContent>
  );
}
