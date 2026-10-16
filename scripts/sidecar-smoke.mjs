import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const exe = process.argv[2];
if (!exe) throw Error("Pass the backend executable");
const source = readFileSync(
  new URL("../src-tauri/src/main.rs", import.meta.url),
  "utf8",
);
const declaration = source.match(/const METHODS:[\s\S]*?=\s*&\[([\s\S]*?)\];/);
assert.ok(declaration, "Desktop METHODS allowlist was not found");
const methods = [...declaration[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
assert.ok(methods.length > 0, "Desktop METHODS allowlist is empty");
const root = mkdtempSync(join(tmpdir(), "nook-ipc-"));
const child = spawn(resolve(exe), ["--rpc", "--data-dir", root], {
  stdio: ["pipe", "pipe", "pipe"],
});
let nextId = 0;
const pending = new Map();
let stderr = "";
child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-8192)));
const rejectPending = (error) => {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
};
const exited = new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", (code) => resolve(code));
});
child.on("error", rejectPending);
child.on("exit", () => rejectPending(Error("Runtime exited before replying")));
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const reply = JSON.parse(line);
    if (reply.event) return;
    const waiter = pending.get(reply.id);
    assert.ok(waiter, `Unexpected reply: ${line}`);
    pending.delete(reply.id);
    waiter.resolve(reply);
  } catch (error) {
    rejectPending(error);
    child.kill();
  }
});
const request = (method, args = []) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
  });
const call = async (method, args = []) => {
  const reply = await request(method, args);
  assert.ok(!reply.error, `${method}: ${reply.error}`);
  return reply.result;
};
const timer = setTimeout(() => {
  rejectPending(Error("Runtime smoke test timed out"));
  child.kill();
}, 30000);
try {
  for (const method of methods) {
    const reply = await request(method);
    assert.ok(
      !reply.error?.includes("Unknown method"),
      `Missing backend command: ${method}`,
    );
  }
  const unknown = await request("UnknownSmokeCommand");
  assert.match(unknown.error, /Unknown method/);
  assert.ok(Array.isArray((await call("Snapshot")).providers));
  await call("SaveNavigation", ['{"theme":"dark"}']);
  assert.equal(await call("Navigation"), '{"theme":"dark"}');
  const project = await call("AddProject", [root]);
  const workflow = await call("CreateWorkflow", [
    {
      projectId: project.id,
      goal: "Smoke-test a persisted workflow",
      tasks: [
        {
          id: "review",
          title: "Review",
          prompt: "Review the work",
          provider: "codex",
          dependsOn: [],
        },
      ],
    },
  ]);
  assert.equal(workflow.tasks[0].state, "ready");
  assert.ok(
    (await call("Snapshot")).workflows.some((w) => w.id === workflow.id),
  );
  const presentation = await request("PresentSession", [
    { sessionId: "missing", revision: 0, arrange: false },
  ]);
  assert.equal(presentation.error, "Session not found");
  await call("Shutdown");
  child.stdin.end();
  assert.equal(await exited, 0, stderr);
  console.log(
    `${methods.length} desktop commands, workflow persistence, presentation validation, and graceful shutdown passed.`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child.kill();
  await exited.catch(() => {});
  lines.close();
  rmSync(root, { recursive: true, force: true });
}
