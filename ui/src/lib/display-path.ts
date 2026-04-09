/**
 * Masks infrastructure paths for display.
 * Replaces /home/paperclip with $ATOMCLAW_HOME in user-visible strings.
 * Also masks .paperclip/ data directories.
 */
export function displayPath(path: string | null | undefined): string {
  if (!path) return "";
  return path
    .replace(/\/home\/paperclip/g, "$ATOMCLAW_HOME")
    .replace(/\.paperclip\//g, ".atomclaw/");
}

/**
 * Masks paths in a block of text (e.g. stderr output, log messages).
 */
export function displayText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\/home\/paperclip/g, "$ATOMCLAW_HOME")
    .replace(/\.paperclip\//g, ".atomclaw/")
    .replace(/\[paperclip\]/g, "[atomclaw]")
    .replace(/paperclip-skills-/g, "atomclaw-skills-");
}
