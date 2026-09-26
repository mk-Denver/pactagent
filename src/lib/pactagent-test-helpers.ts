import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SECRET_MARKERS = [
  "PRIVATE-DOCUMENT",
  "PRIVATE-PROMPT",
  "PRIVATE-RESULT",
  "PRIVATE-PROOF",
  "PRIVATE-WITNESS",
  "PRIVATE-SECRET",
  "nsec1",
  "cashuA",
  "cashuB",
] as const;

export function scanForSecrets(value: unknown): string[] {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return SECRET_MARKERS.filter((m) => serialized.includes(m));
}

export interface ServerHandle {
  child: ChildProcess;
  baseUrl: string;
  apiToken: string;
  stateDir: string;
}

export async function startTestServer(env: Record<string, string | undefined>): Promise<ServerHandle> {
  const port = 4500 + Math.floor(Math.random() * 600);
  const apiToken = env.PACTAGENT_RUNTIME_API_TOKEN ?? randomBytes(24).toString("hex");
  const stateDir = await mkdtemp(join(tmpdir(), "pactagent-test-"));
  const repoRoot = process.cwd();
  const nextBin = join(repoRoot, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "localhost"], {
    cwd: repoRoot,
    env: { ...process.env, PACTAGENT_RUNTIME_API_TOKEN: apiToken, PACTAGENT_LIVE_STATE_DIRECTORY: stateDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForReady(`http://localhost:${port}`, child);
  return { child, baseUrl: `http://localhost:${port}`, apiToken, stateDir };
}

export async function waitForReady(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/api/status`);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Server did not become ready within 90s");
}

export async function stopTestServer(server: ServerHandle): Promise<void> {
  if (server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.child.kill("SIGKILL");
      resolve();
    }, 5000);
    server.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await rm(server.stateDir, { recursive: true, force: true });
}
