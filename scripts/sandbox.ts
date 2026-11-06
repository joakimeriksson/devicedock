import {
  startSandbox,
  docker,
  container,
  verifyManaged,
} from "../apps/server/sandbox.ts";
const op = process.argv[2];
try {
  if (op === "start") {
    await startSandbox();
    console.log("Sandbox started.");
  } else if (op === "stop") {
    await verifyManaged();
    await docker(["stop", container]);
    console.log("Sandbox stopped; workspace and credentials preserved.");
  } else if (op === "clean") {
    await verifyManaged();
    await docker(["rm", "-f", container]);
    console.log(
      "Container removed. Volumes preserved. See README for explicit data removal.",
    );
  } else throw Error("Use start, stop, or clean");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
