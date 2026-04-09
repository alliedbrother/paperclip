import { useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, Search } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";
import { useAgentOrder } from "../hooks/useAgentOrder";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Agent } from "@paperclipai/shared";

function defaultAgentTab(agent: Agent): string {
  return agent.adapterType === "human" ? "issues" : "dashboard";
}

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  const [search, setSearch] = useState("");
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);

  const visibleAgents = useMemo(() => {
    const filtered = (agents ?? []).filter(
      (a: Agent) => a.status !== "terminated"
    );
    return filtered;
  }, [agents]);
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedAgents } = useAgentOrder({
    agents: visibleAgents,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });

  // Group agents by department: CEO at top, then each CXO with their subtree
  const groupedAgents = useMemo(() => {
    const all = visibleAgents;
    if (all.length === 0) return [];

    const byId = new Map(all.map((a) => [a.id, a]));

    // Find the root (CEO — no reportsTo)
    const ceo = all.find((a) => !a.reportsTo);

    // Find CXOs (direct reports of CEO)
    const cxos = all
      .filter((a) => ceo && a.reportsTo === ceo.id)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Collect all descendants of an agent
    function getDescendants(parentId: string): Agent[] {
      const children = all.filter((a) => a.reportsTo === parentId);
      const result: Agent[] = [];
      for (const child of children) {
        result.push(child);
        result.push(...getDescendants(child.id));
      }
      return result;
    }

    const groups: { label: string; agents: Agent[] }[] = [];

    // CEO group (just the CEO)
    if (ceo) {
      groups.push({ label: "Executive", agents: [ceo] });
    }

    // Each CXO + their full subtree
    for (const cxo of cxos) {
      const descendants = getDescendants(cxo.id);
      const members = [cxo, ...descendants].sort((a, b) => a.name.localeCompare(b.name));
      const label = cxo.title ?? cxo.name;
      groups.push({ label, agents: members });
    }

    // Orphans (agents not in any group — no CEO parent chain)
    const grouped = new Set(groups.flatMap((g) => g.agents.map((a) => a.id)));
    const orphans = all.filter((a) => !grouped.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
    if (orphans.length > 0) {
      groups.push({ label: "Other", agents: orphans });
    }

    return groups;
  }, [visibleAgents]);

  const filteredAgents = useMemo(() => {
    if (!search.trim()) return groupedAgents;
    const q = search.toLowerCase();
    return groupedAgents
      .map((g) => ({
        ...g,
        agents: g.agents.filter((a: Agent) =>
          a.name.toLowerCase().includes(q) || (a.title ?? "").toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.agents.length > 0);
  }, [groupedAgents, search]);

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;

  function agentNavUrl(agent: Agent): string {
    return `${agentUrl(agent)}/${defaultAgentTab(agent)}`;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90"
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
              Agents
            </span>
          </CollapsibleTrigger>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openNewAgent();
            }}
            className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label="New agent"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      <CollapsibleContent>
        <div className="px-3 pb-1.5">
          <div className="flex items-center gap-1.5 rounded-md border border-border/50 bg-accent/30 px-2 py-1">
            <Search className="h-3 w-3 text-muted-foreground/60 shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents..."
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none min-w-0"
            />
          </div>
        </div>
        <div className="mt-0.5 max-h-[45vh] overflow-y-auto">
          {filteredAgents.map((group) => (
            <div key={group.label} className="mb-1">
              <div className="px-4 pt-2 pb-0.5">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  {group.label}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                {group.agents.map((agent: Agent) => {
                  const runCount = liveCountByAgent.get(agent.id) ?? 0;
                  return (
                    <NavLink
                      key={agent.id}
                      to={agentNavUrl(agent)}
                      onClick={() => {
                        if (isMobile) setSidebarOpen(false);
                      }}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
                        activeAgentId === agentRouteRef(agent)
                          ? "bg-accent text-foreground"
                          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground"
                      )}
                    >
                      <AgentIcon icon={agent.icon} adapterType={agent.adapterType} className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
                      <span className="flex-1 truncate">{agent.name}</span>
                      {(agent.pauseReason === "budget" || runCount > 0) && (
                        <span className="ml-auto flex items-center gap-1.5 shrink-0">
                          {agent.pauseReason === "budget" ? (
                            <BudgetSidebarMarker title="Agent paused by budget" />
                          ) : null}
                          {runCount > 0 ? (
                            <span className="relative flex h-2 w-2">
                              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                            </span>
                          ) : null}
                          {runCount > 0 ? (
                            <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
                              {runCount} live
                            </span>
                          ) : null}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
