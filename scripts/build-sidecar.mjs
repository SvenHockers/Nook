import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
    /^host: (.+)$/m,
  )?.[1];
const targets = {
  "aarch64-apple-darwin": ["darwin", "arm64"],
  "x86_64-pc-windows-msvc": ["windows", "amd64"],
};
if (!targets[target]) throw Error(`Unsupported Nook desktop target: ${target}`);
const [GOOS, GOARCH] = targets[target];
mkdirSync("src-tauri/binaries", { recursive: true });
execFileSync(
  "go",
  [
    "build",
    "-trimpath",
    "-ldflags=-s -w",
    "-o",
    `src-tauri/binaries/nook-backend-${target}${GOOS === "windows" ? ".exe" : ""}`,
    ".",
  ],
  { stdio: "inherit", env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: "0" } },
);
