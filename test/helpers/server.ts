import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Starts the real server as a child process; `ready` resolves with its log once it listens. */
export function startServer(env: Record<string, string>): { child: ChildProcess; ready: Promise<string> } {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../src/server.ts", import.meta.url))], {
    // Nothing from the developer's own .env or shell may leak into the server under test.
    env: { PATH: process.env.PATH ?? "", AUTH_DB: ":memory:", ...env },
    cwd: fileURLToPath(new URL("../helpers/", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout?.on("data", (d) => {
      out += String(d);
      if (out.includes("nutboard →")) resolve(out);
    });
    child.stderr?.on("data", (d) => {
      out += String(d);
    });
    child.on("exit", (code) => reject(new Error(`server exited with ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15_000).unref();
  });
  return { child, ready };
}
