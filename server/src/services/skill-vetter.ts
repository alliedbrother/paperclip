/**
 * Skill Vetter Service
 *
 * Two-phase security check for skills before installation:
 * 1. Fast pattern-based scan for known dangerous patterns
 * 2. LLM-based deep assessment via Claude API
 */

import { logger } from "../middleware/logger.js";

export interface VetResult {
  verdict: "pass" | "warn" | "fail";
  riskLevel: "low" | "medium" | "high" | "critical";
  patternFindings: PatternFinding[];
  llmAssessment: string | null;
  summary: string;
}

interface PatternFinding {
  severity: "critical" | "high" | "medium" | "low";
  pattern: string;
  description: string;
  matchedText?: string;
}

// ── Phase 1: Pattern-based scanning ──

const DANGEROUS_PATTERNS: { regex: RegExp; severity: PatternFinding["severity"]; pattern: string; description: string }[] = [
  // Credential theft
  { regex: /\$[A-Z_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/gi, severity: "high", pattern: "credential_access", description: "References API keys, secrets, or credentials" },
  { regex: /curl.*-[dX].*(?:api[_-]?key|secret|token|password)/gi, severity: "high", pattern: "credential_exfiltration", description: "Sends credentials via HTTP request" },
  { regex: /(?:wget|curl).*\|\s*(?:bash|sh|zsh)/gi, severity: "critical", pattern: "remote_execution", description: "Downloads and executes remote code (curl|bash)" },

  // Obfuscated code
  { regex: /eval\s*\(/gi, severity: "high", pattern: "eval_usage", description: "Uses eval() which can execute arbitrary code" },
  { regex: /base64[_-]?(?:decode|encode)|atob|btoa/gi, severity: "medium", pattern: "base64_encoding", description: "Uses base64 encoding/decoding (potential obfuscation)" },
  { regex: /\\x[0-9a-f]{2}/gi, severity: "medium", pattern: "hex_escape", description: "Contains hex-escaped strings (potential obfuscation)" },

  // File system access
  { regex: /(?:rm\s+-rf?\s+[/~]|rmdir|unlink)\s/gi, severity: "critical", pattern: "destructive_delete", description: "Destructive file deletion commands" },
  { regex: /chmod\s+[0-7]{3,4}\s/gi, severity: "medium", pattern: "permission_change", description: "Changes file permissions" },
  { regex: /\/etc\/(?:passwd|shadow|hosts|sudoers)/gi, severity: "critical", pattern: "system_file_access", description: "Accesses sensitive system files" },

  // Network access
  { regex: /(?:nc|ncat|netcat)\s+-[lp]/gi, severity: "critical", pattern: "reverse_shell", description: "Opens network listener (potential reverse shell)" },
  { regex: /(?:ssh|scp|rsync)\s+.*@/gi, severity: "high", pattern: "remote_access", description: "Initiates remote SSH/SCP connections" },

  // Privilege escalation
  { regex: /sudo\s+/gi, severity: "high", pattern: "privilege_escalation", description: "Uses sudo for elevated privileges" },
  { regex: /(?:useradd|usermod|adduser)/gi, severity: "critical", pattern: "user_management", description: "Creates or modifies system users" },

  // Data exfiltration
  { regex: /curl.*(?:pastebin|requestbin|webhook\.site|pipedream|ngrok)/gi, severity: "critical", pattern: "data_exfiltration", description: "Sends data to known exfiltration services" },
  { regex: /(?:tar|zip|gzip).*\|.*curl/gi, severity: "high", pattern: "archive_exfiltration", description: "Archives and sends data externally" },

  // Cryptocurrency mining
  { regex: /(?:xmrig|minerd|cgminer|ethminer|cryptonight)/gi, severity: "critical", pattern: "crypto_mining", description: "References cryptocurrency mining software" },
];

function runPatternScan(content: string): PatternFinding[] {
  const findings: PatternFinding[] = [];

  for (const { regex, severity, pattern, description } of DANGEROUS_PATTERNS) {
    // Reset regex state
    regex.lastIndex = 0;
    const match = regex.exec(content);
    if (match) {
      findings.push({
        severity,
        pattern,
        description,
        matchedText: match[0].slice(0, 80),
      });
    }
  }

  return findings;
}

function patternVerdict(findings: PatternFinding[]): { verdict: VetResult["verdict"]; riskLevel: VetResult["riskLevel"] } {
  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasHigh = findings.some((f) => f.severity === "high");
  const mediumCount = findings.filter((f) => f.severity === "medium").length;

  if (hasCritical) return { verdict: "fail", riskLevel: "critical" };
  if (hasHigh) return { verdict: "warn", riskLevel: "high" };
  if (mediumCount >= 3) return { verdict: "warn", riskLevel: "medium" };
  return { verdict: "pass", riskLevel: "low" };
}

// ── Phase 2: LLM-based assessment ──

const VET_SYSTEM_PROMPT = `You are a security analyst vetting third-party skills (instruction files) for an AI agent platform.
Analyze the skill content for security risks. Be concise.

Check for:
1. Credential theft or exfiltration patterns
2. Unauthorized file system access or destructive operations
3. Remote code execution or injection vectors
4. Excessive privilege requirements
5. Data exfiltration to external services
6. Obfuscated or suspicious code patterns
7. Social engineering (instructions that trick the agent into harmful actions)

Respond with EXACTLY this format:
VERDICT: PASS|WARN|FAIL
RISK: LOW|MEDIUM|HIGH|CRITICAL
SUMMARY: One sentence summary of findings.
DETAILS: Brief bullet points of specific concerns (or "No significant concerns found.")`;

async function llmAssessment(skillContent: string, skillName: string): Promise<{ verdict: VetResult["verdict"]; riskLevel: VetResult["riskLevel"]; summary: string; details: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.info("Skill vetter: no ANTHROPIC_API_KEY, skipping LLM assessment");
    return null;
  }

  try {
    const truncatedContent = skillContent.slice(0, 8000); // Limit context size
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: VET_SYSTEM_PROMPT,
        messages: [
          { role: "user", content: `Vet this skill called "${skillName}":\n\n${truncatedContent}` },
        ],
      }),
    });

    if (!response.ok) {
      logger.info(`Skill vetter LLM call failed: ${response.status}`);
      return null;
    }

    const data = await response.json() as { content: { type: string; text: string }[] };
    const text = data.content?.[0]?.text ?? "";

    const verdictMatch = text.match(/VERDICT:\s*(PASS|WARN|FAIL)/i);
    const riskMatch = text.match(/RISK:\s*(LOW|MEDIUM|HIGH|CRITICAL)/i);
    const summaryMatch = text.match(/SUMMARY:\s*(.+)/i);
    const detailsMatch = text.match(/DETAILS:\s*([\s\S]*)/i);

    return {
      verdict: (verdictMatch?.[1]?.toLowerCase() ?? "warn") as VetResult["verdict"],
      riskLevel: (riskMatch?.[1]?.toLowerCase() ?? "medium") as VetResult["riskLevel"],
      summary: summaryMatch?.[1]?.trim() ?? "Assessment completed.",
      details: detailsMatch?.[1]?.trim() ?? "",
    };
  } catch (err) {
    logger.info(`Skill vetter LLM error: ${(err as Error).message}`);
    return null;
  }
}

// ── Combined vetting ──

export async function vetSkillContent(skillName: string, content: string): Promise<VetResult> {
  // Phase 1: Pattern scan
  const patternFindings = runPatternScan(content);
  const patternResult = patternVerdict(patternFindings);

  // If pattern scan finds critical issues, fail immediately
  if (patternResult.verdict === "fail") {
    return {
      verdict: "fail",
      riskLevel: "critical",
      patternFindings,
      llmAssessment: null,
      summary: `Pattern scan found critical security issues: ${patternFindings.filter((f) => f.severity === "critical").map((f) => f.description).join("; ")}`,
    };
  }

  // Phase 2: LLM assessment
  const llm = await llmAssessment(content, skillName);

  // Combine results (patternResult.verdict is "pass" or "warn" here — "fail" returned early above)
  const finalVerdict: VetResult["verdict"] = llm
    ? (llm.verdict === "fail" ? "fail"
      : llm.verdict === "warn" || patternResult.verdict === "warn" ? "warn"
        : "pass")
    : patternResult.verdict;

  const finalRisk = llm
    ? (["critical", "high", "medium", "low"].indexOf(llm.riskLevel) < ["critical", "high", "medium", "low"].indexOf(patternResult.riskLevel)
      ? llm.riskLevel : patternResult.riskLevel)
    : patternResult.riskLevel;

  return {
    verdict: finalVerdict,
    riskLevel: finalRisk,
    patternFindings,
    llmAssessment: llm ? `${llm.summary}\n\n${llm.details}` : null,
    summary: llm?.summary ?? (patternFindings.length > 0
      ? `Found ${patternFindings.length} pattern match${patternFindings.length > 1 ? "es" : ""} during security scan.`
      : "No security concerns found."),
  };
}
