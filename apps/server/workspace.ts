import { realpathSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep, isAbsolute } from "node:path";

// Optional bind mount of ONE dedicated host folder as /workspace (default is the devicedock-workspace Docker volume).
// This relaxes "nothing from the host is mounted", so the folder is validated hard:
//   - it must be a dedicated directory strictly inside the home folder (Colima mounts $HOME; elsewhere would not work),
//   - never the home folder itself, "/", any ancestor of home, the DeviceDock project (it holds .runtime/bridge-token),
//   - never inside or containing a credential/config directory, and never holding credential files at its top level.
// An agent in autonomous mode can modify everything inside the folder, including any .git/config and hooks. See
// SECURITY.md: never run git inside it on the Mac, fetch from it instead (`./devicedock.sh pull`).

/** Directories under $HOME that hold credentials or app state; the mount must be neither inside nor above them. */
export const SENSITIVE_HOME_DIRS = [
  ".ssh", ".aws", ".gnupg", ".config", ".kube", ".docker", ".azure", ".npm", ".netrc",
  ".claude", ".codex", ".colima", ".lima", "Library", ".local", ".cache", ".password-store",
];
/** Files whose presence at the top of the folder means it is not a plain project folder. */
export const SENSITIVE_TOP_LEVEL = [".ssh", ".aws", ".gnupg", ".netrc", ".env", "id_rsa", "id_ed25519", ".npmrc", "credentials.json"];

export type FsProbe = {
  real(p: string): string;
  isDir(p: string): boolean;
  list(p: string): string[];
};
export const nodeFs: FsProbe = {
  real: (p) => realpathSync(p),
  isDir: (p) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  },
  list: (p) => readdirSync(p),
};

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

/** Returns the resolved folder, or throws an Error explaining exactly why it is refused. */
export function validateWorkspacePath(
  input: string,
  opts: { home?: string; projectRoot: string; fs?: FsProbe },
): string {
  const fs = opts.fs ?? nodeFs;
  const home = fs.real(opts.home ?? homedir());
  if (!input || !isAbsolute(input)) throw new Error("The workspace folder must be an absolute path");
  if (!fs.isDir(input)) throw new Error(`${input} is not an existing directory`);
  const dir = fs.real(resolve(input)); // follows symlinks, so a link cannot smuggle in another place
  const project = fs.real(opts.projectRoot);

  if (dir === sep) throw new Error('Refusing "/" as the workspace');
  if (dir === home || inside(home, dir)) throw new Error("Refusing your home folder (or a folder above it): use a dedicated subfolder");
  if (!inside(dir, home)) throw new Error(`The workspace must be inside your home folder (${home}); Docker only shares that`);
  if (inside(dir, project) || inside(project, dir))
    throw new Error("Refusing the DeviceDock project folder (it holds the bridge token) or anything around it");
  for (const s of SENSITIVE_HOME_DIRS) {
    const sensitive = `${home}${sep}${s}`;
    if (inside(dir, sensitive)) throw new Error(`Refusing ${dir}: inside ~/${s}, which holds credentials or app state`);
  }
  const top = new Set(fs.list(dir));
  const found = SENSITIVE_TOP_LEVEL.filter((n) => top.has(n));
  if (found.length) throw new Error(`Refusing ${dir}: it contains ${found.join(", ")}, which looks like credentials, not a project folder`);
  return dir;
}
