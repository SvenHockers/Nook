import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const backend = fileURLToPath(new URL("../backend/", import.meta.url));
if (!existsSync(`${backend}/Cargo.toml`)) {
  throw Error(
    "Missing backend/Cargo.toml. Restore the Rust backend directory before starting Nook.",
  );
}
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
    /^host: (.+)$/m,
  )?.[1];
const targets = ["aarch64-apple-darwin", "x86_64-pc-windows-msvc"];
if (!targets.includes(target))
  throw Error(`Unsupported Nook desktop target: ${target}`);
const exe = target.endsWith("windows-msvc") ? ".exe" : "";
// Run inside backend/ so its .cargo/config.toml applies.
execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "--bin",
    "nook-backend",
    "--target",
    target,
  ],
  { stdio: "inherit", cwd: backend },
);
mkdirSync(`${root}/src-tauri/binaries`, { recursive: true });
copyFileSync(
  `${backend}/target/${target}/release/nook-backend${exe}`,
  `${root}/src-tauri/binaries/nook-backend-${target}${exe}`,
);
