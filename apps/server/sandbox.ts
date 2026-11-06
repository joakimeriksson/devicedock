import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const exec = promisify(execFile);
export const container = "devicedock-sandbox";
export const bridgePort = 47832;
export async function docker(args: string[]) {
  return (
    await exec("docker", args, { timeout: 120000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
}
export async function health() {
  const result: {
    docker: boolean;
    container: boolean;
    agent: boolean;
    error?: string;
  } = { docker: false, container: false, agent: false };
  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 5000,
    });
    result.docker = true;
    result.container =
      (await docker([
        "inspect",
        "--format",
        "{{.State.Running}}",
        container,
      ])) === "true";
    if (result.container) {
      await docker(["exec", container, "codex", "--version"]);
      result.agent = true;
    }
  } catch (e) {
    result.error = (e as Error).message.slice(0, 350);
  }
  return result;
}
export async function getBridgeToken() {
  return (await readFile(".runtime/bridge-token", "utf8")).trim();
}
export async function verifyManaged() {
  const label = await docker([
    "inspect",
    "--format",
    '{{index .Config.Labels "devicedock.managed"}}',
    container,
  ]);
  if (label !== "true")
    throw Error(
      "A container with this name already exists and is not managed by DeviceDock",
    );
}
export async function sandboxExists(run: typeof docker = docker) {
  const names = await run([
    "container", "ls", "--all",
    "--filter", `name=^/${container}$`,
    "--format", "{{.Names}}",
  ]);
  return names.split("\n").some(name => name.trim() === container);
}
export async function startSandbox() {
  await mkdir(".runtime", { recursive: true, mode: 0o700 });
  let token: string;
  try {
    token = await getBridgeToken();
  } catch {
    token = randomBytes(32).toString("hex");
    await writeFile(".runtime/bridge-token", token, { mode: 0o600 });
  }
  const exists = await sandboxExists();
  if (exists) {
    await verifyManaged();
    await docker(["start", container]);
  } else {
    await docker(["volume", "create", "devicedock-workspace"]);
    await docker(["volume", "create", "devicedock-home"]);
    await docker([
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "devicedock.managed=true",
      "--user",
      "1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--cpus=2",
      "--memory=2g",
      "--pids-limit=256",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--mount",
      "type=volume,src=devicedock-workspace,dst=/workspace",
      "--mount",
      "type=volume,src=devicedock-home,dst=/home/node",
      "-p",
      `127.0.0.1:${bridgePort}:47832`,
      "devicedock-sandbox:local",
    ]);
  }
  // Send the token over stdin, never in command arguments or Docker environment metadata.
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "sh",
        "-c",
        "umask 077; cat > /home/node/.bridge-token",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error("Could not provision bridge token")),
    );
    p.stdin.end(token);
  });
}
