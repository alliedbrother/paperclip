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
      if (!agent) return null;
      if (agent.adapterType === "human") return agent;
      currentId = agent.reportsTo ?? null;
    }
    return null;
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
      return { needed: false, approverId: null };
    }

    // If the actor is a board user linked to the approving human agent, skip approval
    if (actor.type === "board" && actor.userId && approver.linkedUserId === actor.userId) {
      return { needed: false, approverId: approver.id };
    }

    // If the actor IS the approver agent (agent making changes to its own reports)
    if (actor.type === "agent" && actor.agentId === approver.id) {
      return { needed: false, approverId: approver.id };
    }

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

  /**
   * Format a human-readable diff of changes, deep-diffing nested objects
   * and redacting sensitive values.
   */
  function formatChangeSummary(
    changes: Record<string, unknown>,
    currentValues: Record<string, unknown>,
  ): string {
    const diffs: string[] = [];

    function walk(path: string, newVal: unknown, oldVal: unknown) {
      if (isObj(newVal) && isObj(oldVal)) {
        const allKeys = new Set([...Object.keys(newVal), ...Object.keys(oldVal)]);
        for (const k of allKeys) {
          walk(path ? `${path}.${k}` : k, (newVal as Record<string, unknown>)[k], (oldVal as Record<string, unknown>)[k]);
        }
        return;
      }
      const newStr = redactSensitive(path, fmtLeaf(newVal));
      const oldStr = redactSensitive(path, fmtLeaf(oldVal));
      if (newStr === oldStr) return;

      if (oldVal === undefined) {
        diffs.push(`- **${path}**: _(added)_ → \`${truncate(newStr, 60)}\``);
      } else if (newVal === undefined) {
        diffs.push(`- **${path}**: \`${truncate(oldStr, 60)}\` → _(removed)_`);
      } else {
        diffs.push(`- **${path}**: \`${truncate(oldStr, 60)}\` → \`${truncate(newStr, 60)}\``);
      }
    }

    for (const key of Object.keys(changes)) {
      walk(key, changes[key], currentValues[key]);
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
    const diffSummary = formatChangeSummary(changes, currentValues);

    const description = [
      `**Agent:** ${targetAgentName}`,
      `**Change Type:** ${changeType}`,
      `**Requested By:** ${requestedBy.name}`,
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
