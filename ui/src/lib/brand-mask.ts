/**
 * Global DOM text masking for AtomClaw branding.
 *
 * Observes ALL text content in the DOM and replaces "paperclip" references
 * with "atomclaw" equivalents. This is the nuclear option — catches everything
 * that individual component-level masking might miss (JSON dumps, config forms,
 * transcripts, env var displays, etc.)
 *
 * Replacements:
 *   /home/paperclip       → $ATOMCLAW_HOME
 *   .paperclip/           → .atomclaw/
 *   [paperclip]           → [atomclaw]
 *   paperclip-skills-     → atomclaw-skills-
 *   paperclipWorkspace    → atomclawWorkspace
 *   paperclipWorkspaces   → atomclawWorkspaces
 *   PAPERCLIP_            → ATOMCLAW_
 *   "paperclip"           → "atomclaw"  (in JSON key contexts)
 *
 * Does NOT affect:
 *   - <input> and <textarea> values (so config editing still works)
 *   - @paperclipai package imports (code-level, not in DOM text)
 */

const REPLACEMENTS: [RegExp, string][] = [
  [/\/home\/paperclip/g, "$ATOMCLAW_HOME"],
  [/\.paperclip\//g, ".atomclaw/"],
  [/\[paperclip\]/g, "[atomclaw]"],
  [/paperclip-skills-/g, "atomclaw-skills-"],
  [/"paperclipWorkspace"/g, '"atomclawWorkspace"'],
  [/"paperclipWorkspaces"/g, '"atomclawWorkspaces"'],
  [/PAPERCLIP_/g, "ATOMCLAW_"],
  [/paperclip\.(ing|dev)/g, "atomclaw.$1"], // docs.paperclip.ing → docs.atomclaw.ing
];

function maskText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function processNode(node: Node) {
  // Only process text nodes
  if (node.nodeType === Node.TEXT_NODE) {
    const original = node.textContent;
    if (!original) return;
    // Quick check — skip if no "paperclip" at all (case-insensitive)
    if (!/paperclip|PAPERCLIP|\.paperclip/i.test(original)) return;
    // Skip if inside an input/textarea/contentEditable (don't corrupt editable values)
    const parent = node.parentElement;
    if (parent && (parent.tagName === "INPUT" || parent.tagName === "TEXTAREA")) return;
    // Walk up to check for contentEditable ancestor (editors save DOM text)
    let ancestor = parent;
    while (ancestor) {
      if (ancestor.isContentEditable) return;
      ancestor = ancestor.parentElement;
    }
    const masked = maskText(original);
    if (masked !== original) {
      node.textContent = masked;
    }
  }
}

function processTree(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current: Text | null;
  while ((current = walker.nextNode() as Text | null)) {
    nodes.push(current);
  }
  for (const n of nodes) {
    processNode(n);
  }
}

let observer: MutationObserver | null = null;

export function startBrandMask() {
  if (observer) return; // Already running

  // Process the whole document initially
  processTree(document.body);

  // Watch for future DOM changes
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Process added nodes
      for (const added of mutation.addedNodes) {
        if (added.nodeType === Node.TEXT_NODE) {
          processNode(added);
        } else if (added.nodeType === Node.ELEMENT_NODE) {
          processTree(added);
        }
      }
      // Process character data changes (text content updates)
      if (mutation.type === "characterData" && mutation.target) {
        processNode(mutation.target);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
