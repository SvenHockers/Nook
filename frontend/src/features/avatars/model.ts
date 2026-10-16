import type { State } from "../../types";
export const runtimeStates = [
  "idle",
  "thinking",
  "working",
  "waiting_for_input",
  "completed",
  "error",
  "paused",
  "disconnected",
] as const;
export type RuntimeState = (typeof runtimeStates)[number];
export type MotionLevel = "off" | "subtle" | "full";
export interface AvatarIdentity {
  id: string;
  name: string;
  shape: "squircle" | "droplet" | "triangle" | "round" | "oval" | "cloud";
  palette: readonly [string, string];
  eye: "wide" | "oval" | "focused" | "sleepy";
  energy: number;
}
export interface AvatarInteraction {
  hovered: boolean;
  selected: boolean;
  pointer?: { x: number; y: number };
}
export interface AvatarPose {
  openness: number;
  pupilX: number;
  pupilY: number;
  tilt: number;
  lift: number;
  scaleX: number;
  scaleY: number;
  accent: "none" | "thinking" | "activity" | "attention" | "success" | "error";
}
export const characters: readonly AvatarIdentity[] = [
  {
    id: "clio",
    name: "Clio",
    shape: "squircle",
    palette: ["#dabaff", "#8661d6"],
    eye: "oval",
    energy: 0.35,
  },
  {
    id: "orby",
    name: "Orby",
    shape: "droplet",
    palette: ["#b3ddff", "#4784db"],
    eye: "focused",
    energy: 0.7,
  },
  {
    id: "vale",
    name: "Vale",
    shape: "triangle",
    palette: ["#adf2dc", "#30ac8c"],
    eye: "oval",
    energy: 0.3,
  },
  {
    id: "sunny",
    name: "Sunny",
    shape: "round",
    palette: ["#fff0a5", "#e8ae3d"],
    eye: "wide",
    energy: 0.8,
  },
  {
    id: "dot",
    name: "Dot",
    shape: "oval",
    palette: ["#ffc0bd", "#df737e"],
    eye: "focused",
    energy: 0.25,
  },
  {
    id: "nyx",
    name: "Nyx",
    shape: "cloud",
    palette: ["#ada0d0", "#625379"],
    eye: "sleepy",
    energy: 0.2,
  },
];
export const runtimeFromSession: Record<State, RuntimeState> = {
  starting: "thinking",
  working: "working",
  waiting: "waiting_for_input",
  completed: "completed",
  stopped: "idle",
  failed: "error",
  disconnected: "disconnected",
};
const clamp = (n: number, limit: number) =>
  Number.isFinite(n) ? Math.max(-limit, Math.min(limit, n)) : 0;
export function resolveExpression(
  identity: AvatarIdentity,
  state: RuntimeState,
  interaction: AvatarInteraction,
): AvatarPose {
  const pose: AvatarPose = {
    openness: identity.eye === "sleepy" ? 0.58 : 0.88,
    pupilX: 0,
    pupilY: 1,
    tilt: 0,
    lift: 0,
    scaleX: 1,
    scaleY: 1,
    accent: "none",
  };
  switch (state) {
    case "thinking":
      Object.assign(pose, {
        pupilX: -3,
        pupilY: -4,
        tilt: -3,
        accent: "thinking",
      });
      break;
    case "working":
      Object.assign(pose, { openness: 0.75, pupilY: 0, accent: "activity" });
      break;
    case "waiting_for_input":
      Object.assign(pose, {
        openness: 1,
        lift: -1,
        scaleY: 1.02,
        accent: "attention",
      });
      break;
    case "completed":
      Object.assign(pose, { openness: 0.9, accent: "success" });
      break;
    case "error":
      Object.assign(pose, {
        openness: 0.65,
        pupilX: -2,
        tilt: -2,
        accent: "error",
      });
      break;
    case "paused":
      Object.assign(pose, { openness: 0.45 });
      break;
    case "disconnected":
      Object.assign(pose, { openness: 0.12 });
      break;
  }
  // Attention and inactive states take precedence over playful interaction.
  if (["idle", "thinking", "working", "completed"].includes(state)) {
    if (interaction.selected) pose.lift = -2;
    if (interaction.hovered && interaction.pointer) {
      pose.pupilX = clamp(interaction.pointer.x * 4, 4);
      pose.pupilY = clamp(interaction.pointer.y * 4, 4);
    }
  }
  return pose;
}
