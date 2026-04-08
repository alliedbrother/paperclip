import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

type AgentRow = typeof agents.$inferSelect;

interface ActorInfo {
  type: "agent" | "board";
  agentId?: string | null;
  userId?: string | null;
}

interface CreateChangeRequestOpts {
  targetAgentId: string;
  targetAgentName: string;
  companyId: string;
  changeType: string;
  patchRoute: string;
  changes: Record<string, unknown>;
  currentValues: Record<string, unknown>;
  requestedBy: { agentId?: string | null; userId?: string | null; name: string };
}

interface ChangeRequestPayload {
  targetAgentId: string;
  changeType: string;
  patchRoute: string;
  changes: Record<string, unknown>;
  currentValues: Record<string, unknown>;
  requestedBy: { agentId?: string | null; userId?: string | null; name: string };
}

export function changeApprovalService(db: Db) {
  async function getById(id: string): Promise<AgentRow | null> {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Walk up the reportsTo chain from the target agent's parent to find
   * the nearest human agent (adapterType === "human").
   */
  async function findNearestHumanApprover(agentId: string): Promise<AgentRow | null> {
    const target = await getById(agentId);
    if (!target) return null;

    // Start from the target's parent (not the target itself)
    const visited = new Set<string>([agentId]);
    let currentId: string | null = target.reportsTo ?? null;

    while (currentId && !visited.has(currentId) && visited.size < 50) {
      visited.add(currentId);
      const agent = await getById(currentId);
      if (!agent) break;
      if (agent.adapterType === "human") return agent;
      currentId = agent.reportsTo ?? null;
    }

    // Fallback: find any human agent in the company
    const [fallbackHuman] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, target.companyId), eq(agents.adapterType, "human")))
      .limit(1);
    return fallbackHuman ?? null;
  }

  /**
   * Determine whether a change to the target agent requires approval.
   * Skip approval if:
   * - No human approver found in the chain
   * - The actor is a board user linked to the approving human agent
   * - The target agent itself is human and the actor is that human's board user
   */
  async function requiresApproval(
    targetAgentId: string,
    actor: ActorInfo,
  ): Promise<{ needed: boolean; approverId: string | null }> {
    const approver = await findNearestHumanApprover(targetAgentId);

    if (!approver) {
      // No human agents exist — allow board users (they ARE humans),
      // block AI agents
      if (actor.type === "board") {
        return { needed: false, approverId: null };
      }
      logger.info(`Change blocked: no human approver found for agent ${targetAgentId}`);
      return { needed: true, approverId: null };
    }

    // ALL changes require human approval — both board users and AI agents.
    // This ensures thorough change management with full audit trail.
    // The human approver reviews and accepts/rejects from the Approvals tab.
    return { needed: true, approverId: approver.id };
  }

  /**
   * Classify what type of change is being made based on the PATCH body keys.
   */
  function classifyChangeType(changes: Record<string, unknown>, patchRoute: string): string {
    if (patchRoute === "budget") return "Budget";
    if (patchRoute === "permissions") return "Permissions";
    if (patchRoute === "instructions-path" || patchRoute === "instructions-bundle") return "Instructions";
    if ("budgetMonthlyCents" in changes) return "Budget";
    if ("permissions" in changes || "canCreateAgents" in changes) return "Permissions";
    return "Configuration";
  }

  /** UUID pattern for agent ID detection */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const AGENT_REF_KEYS = /reportsTo|assignee|agentId|managerId/i;

  /**
   * Resolve a UUID to an agent name if the field looks like an agent reference.
   */
  async function resolveAgentName(path: string, value: string): Promise<string> {
    if (!AGENT_REF_KEYS.test(path) || !UUID_RE.test(value)) return value;
    const agent = await getById(value);
    return agent ? `${agent.name} (${value.slice(0, 8)})` : value;
  }

  /**
   * Format a human-readable diff of changes, deep-diffing nested objects,
   * redacting sensitive values, and resolving agent IDs to names.
   */
  async function formatChangeSummary(
    changes: Record<string, unknown>,
    currentValues: Record<string, unknown>,
  ): Promise<string> {
    const diffs: string[] = [];

    async function walk(path: string, newVal: unknown, oldVal: unknown) {
      if (isObj(newVal) && isObj(oldVal)) {
        const allKeys = new Set([...Object.keys(newVal), ...Object.keys(oldVal)]);
        for (const k of allKeys) {
          await walk(path ? `${path}.${k}` : k, (newVal as Record<string, unknown>)[k], (oldVal as Record<string, unknown>)[k]);
        }
        return;
      }
      let newStr = redactSensitive(path, fmtLeaf(newVal));
      let oldStr = redactSensitive(path, fmtLeaf(oldVal));
      if (newStr === oldStr) return;

      // Resolve agent UUIDs to names
      newStr = await resolveAgentName(path, newStr);
      oldStr = await resolveAgentName(path, oldStr);

      if (oldVal === undefined) {
        diffs.push(`- **${path}**: _(added)_ → ${truncate(newStr, 80)}`);
      } else if (newVal === undefined) {
        diffs.push(`- **${path}**: ${truncate(oldStr, 80)} → _(removed)_`);
      } else {
        diffs.push(`- **${path}**: ${truncate(oldStr, 80)} → ${truncate(newStr, 80)}`);
      }
    }

    for (const key of Object.keys(changes)) {
      await walk(key, changes[key], currentValues[key]);
    }
    return diffs.length > 0 ? diffs.join("\n") : "- (no visible field changes)";
  }

  function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  function fmtLeaf(v: unknown): string {
    if (v === undefined || v === null) return "(not set)";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v);
  }

  const SENSITIVE_KEYS = /api[_-]?key|secret|token|password|credential/i;
  function redactSensitive(path: string, value: string): string {
    if (SENSITIVE_KEYS.test(path) && value.length > 8) {
      return value.slice(0, 8) + "****";
    }
    return value;
  }

  /**
   * Check if there's already an open change request for the same agent and change type.
   */
  async function hasOpenChangeRequest(
    companyId: string,
    targetAgentName: string,
    changeType: string,
  ): Promise<boolean> {
    const titlePattern = `Change Approval: ${targetAgentName} - ${changeType}`;
    const openStatuses = ["backlog", "todo", "in_progress"];
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.title, titlePattern),
          inArray(issues.status, openStatuses),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Create a change approval issue assigned to the human approver.
   */
  async function createChangeRequest(opts: CreateChangeRequestOpts) {
    const {
      targetAgentId, targetAgentName, companyId,
      changeType, patchRoute, changes, currentValues, requestedBy,
    } = opts;

    const payload: ChangeRequestPayload = {
      targetAgentId,
      changeType,
      patchRoute,
      changes,
      currentValues,
      requestedBy,
    };

    const payloadJson = JSON.stringify(payload);
    const diffSummary = await formatChangeSummary(changes, currentValues);

    // Resolve requester name: if it's an agent ID, look up the name
    let requesterDisplay = requestedBy.name;
    if (requestedBy.agentId) {
      const requesterAgent = await getById(requestedBy.agentId);
      if (requesterAgent) requesterDisplay = requesterAgent.name;
    } else if (requesterDisplay === "local-board" || requesterDisplay === "board") {
      requesterDisplay = "Board User";
    }

    const description = [
      `**Agent:** ${targetAgentName}`,
      `**Change Type:** ${changeType}`,
      `**Requested By:** ${requesterDisplay}`,
      ``,
      `### Proposed Changes`,
      ``,
      diffSummary,
      ``,
      `---`,
      `<!-- CHANGE_REQUEST_PAYLOAD`,
      payloadJson,
      `-->`,
    ].join("\n");

    const approver = await findNearestHumanApprover(targetAgentId);
    if (!approver) throw new Error("No human approver found");

    const title = `Change Approval: ${targetAgentName} - ${changeType}`;

    const issue = await db.transaction(async (tx) => {
      const [company] = await tx
        .update(companies)
        .set({ issueCounter: sql`${companies.issueCounter} + 1` })
        .where(eq(companies.id, companyId))
        .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

      const issueNumber = company.issueCounter;
      const identifier = `${company.issuePrefix}-${issueNumber}`;

      const [created] = await tx.insert(issues).values({
        companyId,
        issueNumber,
        identifier,
        title,
        description,
        status: "todo",
        priority: "high",
        assigneeAgentId: approver.id,
        originKind: "change_approval",
      }).returning();

      return created;
    });

    logger.info(`Change approval issue created: ${issue.identifier} for ${targetAgentName} (${changeType})`);

    return issue;
  }

  /**
   * Extract the JSON payload from an issue's description.
   */
  function extractPayload(description: string | null): ChangeRequestPayload | null {
    if (!description) return null;
    const match = description.match(/<!-- CHANGE_REQUEST_PAYLOAD\n([\s\S]*?)\n-->/);
    if (!match?.[1]) return null;
    try {
      return JSON.parse(match[1]) as ChangeRequestPayload;
    } catch {
      return null;
    }
  }

  /**
   * Apply a change from an approved change request issue.
   */
  async function applyChange(issueId: string): Promise<{ ok: true; agent: AgentRow }> {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("Issue not found");

    const payload = extractPayload(issue.description);
    if (!payload) throw new Error("Could not parse change request payload from issue description");

    const agent = await getById(payload.targetAgentId);
    if (!agent) throw new Error("Target agent not found");

    // Apply the change based on patchRoute
    const updateData: Partial<typeof agents.$inferInsert> = {};

    if (payload.patchRoute === "evolution") {
      // Self-evolution: apply instruction file changes
      const proposals = payload.changes.proposals as { type: string; filePath: string; operation: string; sectionHeader?: string; content: string }[] | undefined;
      if (proposals && proposals.length > 0) {
        for (const proposal of proposals) {
          if (proposal.type === "instructions_file") {
            // Write the instruction file content
            // For now, store as a metadata entry; actual file write requires the instructions service
            // which needs the agent's workspace path. We'll log the approved change.
            logger.info(`Evolution approved for agent ${agent.name}: ${proposal.operation} on ${proposal.filePath}`);
          }
        }
      }
      // Mark issue as done without DB agent update
      await db
        .update(issues)
        .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(issues.id, issueId));

      logger.info(`Evolution proposal approved: ${issue.identifier} for agent ${agent.name}`);
      return { ok: true as const, agent };
    }

    if (payload.patchRoute === "budget") {
      const cents = payload.changes.budgetMonthlyCents;
      if (typeof cents === "number") {
        updateData.budgetMonthlyCents = cents;
      }
    } else if (payload.patchRoute === "permissions") {
      const perms = payload.changes as Record<string, unknown>;
      updateData.permissions = { ...((agent.permissions ?? {}) as Record<string, unknown>), ...perms };
    } else {
      // General config: apply all changed fields
      const allowedFields = new Set([
        "name", "role", "title", "reportsTo", "capabilities",
        "adapterType", "adapterConfig", "runtimeConfig",
        "budgetMonthlyCents", "metadata", "icon",
      ]);
      for (const [key, value] of Object.entries(payload.changes)) {
        if (allowedFields.has(key)) {
          (updateData as Record<string, unknown>)[key] = value;
        }
      }
    }

    // Apply update
    const [updated] = await db
      .update(agents)
      .set({ ...updateData, updatedAt: new Date() })
      .where(eq(agents.id, payload.targetAgentId))
      .returning();

    // Mark issue as done
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, issueId));

    logger.info(`Change approved and applied: ${issue.identifier} for agent ${agent.name}`);

    return { ok: true, agent: updated };
  }

  /**
   * Reject a change request.
   */
  async function rejectChange(issueId: string, reason?: string): Promise<{ ok: true }> {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("Issue not found");

    await db
      .update(issues)
      .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, issueId));

    logger.info(`Change rejected: ${issue.identifier}${reason ? ` — ${reason}` : ""}`);

    return { ok: true };
  }

  return {
    findNearestHumanApprover,
    requiresApproval,
    classifyChangeType,
    createChangeRequest,
    hasOpenChangeRequest,
    extractPayload,
    applyChange,
    rejectChange,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
