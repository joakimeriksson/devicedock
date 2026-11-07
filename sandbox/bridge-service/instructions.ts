import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Agent instructions live in /workspace/AGENTS.md and CLAUDE.md. They were once copied in only when missing, so
// improvements never reached an existing workspace. Now DeviceDock owns ONE marked section of those files and
// refreshes it at every start; anything else in the file belongs to the user and is never touched.

export const VERSION = 2;
const BEGIN = /<!-- devicedock:begin v\d+ -->/;
const END = "<!-- devicedock:end -->";
/** SHA-256 of earlier whole-file seeds. A file that still matches one byte for byte was never edited by the user. */
export const LEGACY_SHA256 = ["d77656bba86f6cc7a05e6b62d377894de988197e99eb47f964b4994bfd58777e"];

const wrap = (block: string) => `<!-- devicedock:begin v${VERSION} -->\n${block.trim()}\n${END}\n`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The file's new content: `existing` with the DeviceDock section added or refreshed. */
export function mergeManaged(existing: string | undefined, block: string, legacy = LEGACY_SHA256): string {
  const section = wrap(block);
  if (existing === undefined || existing.trim() === "") return section;
  const begin = existing.search(BEGIN);
  const end = existing.indexOf(END);
  if (begin !== -1 && end > begin) return existing.slice(0, begin) + section + existing.slice(end + END.length).replace(/^\n/, "");
  if (legacy.includes(sha(existing))) return section; // an untouched old seed: replace the whole file
  return existing.replace(/\s*$/, "\n\n") + section; // the user's own file: keep it, append our section
}

export function syncInstructions(path: string, source: string) {
  const block = readFileSync(source, "utf8");
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const after = mergeManaged(before, block);
  if (after !== before) writeFileSync(path, after);
}
