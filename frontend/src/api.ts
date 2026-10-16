import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { API, Project } from "./types";
import { createDemo } from "./demo";
export const demo = new URLSearchParams(location.search).get("demo") === "1";
const callbacks = new Set<() => void>();
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  if (!isTauri())
    throw Error(
      "Open Nook as a desktop app to connect your agents. Browser preview: ?demo=1.",
    );
  return invoke<T>("backend_call", { method, args });
}
const native: API = {
  CreateWorkflow: (r) => call("CreateWorkflow", r),
  StartWorkflowTask: (r) => call("StartWorkflowTask", r),
  AcceptWorkflowTask: (r) => call("AcceptWorkflowTask", r),
  WorkflowEvidence: (r) => call("WorkflowEvidence", r),
  Snapshot: () => call("Snapshot"),
  AddProject: async () => {
    const path = await open({
      directory: true,
      multiple: false,
      title: "Choose a project folder",
    });
    return path
      ? call<Project>("AddProject", path)
      : { id: "", name: "", path: "", git: false, context: [] };
  },
  Launch: (r) => call("Launch", r),
  Send: (id, text) => call("Send", id, text),
  Stop: (id) => call("Stop", id),
  Respond: (r) => call("Respond", r),
  Events: (id, after) => call("Events", id, after),
  RefreshProviders: () => call("RefreshProviders"),
  ChooseExecutable: async (id) => {
    const path = await open({
      multiple: false,
      title: `Choose the native ${id} executable`,
    });
    if (path) await call("SetExecutable", id, path);
  },
  Context: (id, items, project) => call("Context", id, items, project),
  ChooseContext: async (kind) =>
    (await open({
      directory: kind === "folder",
      multiple: false,
      title: "Choose a reference " + kind,
    })) || "",
  Archive: (id) => call("Archive", id),
  Rename: (id, title) => call("Rename", id, title),
  Changes: (id) => call("Changes", id),
  ExportPatch: async (id) => {
    const path = await save({
      title: "Export tracked changes",
      defaultPath: "nook-changes.patch",
      filters: [{ name: "Git patch", extensions: ["patch"] }],
    });
    return path ? call<string>("ExportPatch", id, path) : "";
  },
  Reveal: (id) => call("Reveal", id),
  Notify: async (title, body) => {
    let allowed = await isPermissionGranted();
    if (!allowed) allowed = (await requestPermission()) === "granted";
    if (allowed) sendNotification({ title, body });
  },
  Navigation: () => call("Navigation"),
  SaveNavigation: (v) => call("SaveNavigation", v),
};
export const api: API = demo
  ? createDemo(() => callbacks.forEach((f) => f()))
  : native;
export function subscribe(fn: () => void) {
  if (demo) {
    callbacks.add(fn);
    return () => {
      callbacks.delete(fn);
    };
  }
  let disposed = false;
  let off: (() => void) | undefined;
  if (isTauri())
    listen("nook:changed", fn).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
  return () => {
    disposed = true;
    off?.();
  };
}
