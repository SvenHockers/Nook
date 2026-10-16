import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
const exe = process.argv[2];
if (!exe) throw Error("Pass the backend executable");
const root = mkdtempSync(join(tmpdir(), "nook-ipc-"));
const child = spawn(resolve(exe), ["--rpc", "--data-dir", root], {
  stdio: ["pipe", "pipe", "pipe"],
});
const timer = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
  console.error("Runtime smoke test timed out");
}, 30000);
let step = 0,
  stderr = "";
child.stderr.on("data", (b) => (stderr += b));
const write = (id, method, args = []) =>
  child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
createInterface({ input: child.stdout }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.event) return;
  if (r.error) {
    console.error(r.error);
    child.stdin.end();
    process.exitCode = 1;
    return;
  }
  if (r.id === 1) {
    if (!Array.isArray(r.result.providers))
      throw Error("Missing provider discovery");
    write(2, "SaveNavigation", ['{"theme":"dark"}']);
    step = 1;
  } else if (r.id === 2) {
    write(3, "Navigation");
    step = 2;
  } else if (r.id === 3) {
    if (r.result !== '{"theme":"dark"}')
      throw Error("Navigation did not persist");
    write(4, "Shutdown");
    step = 3;
  } else if (r.id === 4) {
    step = 4;
    child.stdin.end();
  }
});
child.on("exit", (code) => {
  clearTimeout(timer);
  rmSync(root, { recursive: true, force: true });
  if (code !== 0 || step !== 4) {
    console.error(stderr || `Incomplete smoke test: ${step}, exit ${code}`);
    process.exitCode = 1;
  } else
    console.log(
      "Desktop stdio contract, persistence, and graceful shutdown passed.",
    );
});
write(1, "Snapshot");
