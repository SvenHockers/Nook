import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  resolveExpression,
  type AvatarIdentity,
  type MotionLevel,
  type RuntimeState,
} from "./model";
const paths: Record<AvatarIdentity["shape"], string> = {
  squircle:
    "M24 58 Q24 25 57 24 L76 24 Q105 24 105 57 L104 81 Q103 104 77 105 L49 104 Q23 103 23 80Z",
  droplet:
    "M64 18 C75 18 105 56 105 78 Q105 104 65 105 Q24 105 24 78 C24 57 51 18 64 18Z",
  triangle:
    "M64 23 Q73 21 82 38 L106 82 Q117 104 88 105 L39 105 Q13 104 24 81 L48 38 Q55 24 64 23Z",
  round:
    "M107 67 C109 93 94 106 64 106 C34 106 21 92 22 67 C22 41 40 23 65 24 C91 24 106 42 107 67Z",
  oval: "M18 77 C18 51 38 39 64 39 C91 39 111 53 111 78 Q111 105 65 105 Q18 105 18 77Z",
  cloud:
    "M28 60 Q18 34 44 35 Q51 14 73 28 Q96 19 101 49 Q118 58 108 82 Q108 105 81 105 L47 105 Q18 106 19 82 Q13 66 28 60Z",
};
export function AvatarBody({
  identity,
  gradient,
}: {
  identity: AvatarIdentity;
  gradient: string;
}) {
  return (
    <g>
      <path d={paths[identity.shape]} fill={`url(#${gradient})`} />
      <path
        d="M38 45 Q45 32 59 34"
        clipPath={`url(#${gradient}-body)`}
        stroke="white"
        opacity=".28"
        strokeWidth="5"
        strokeLinecap="round"
        fill="none"
      />
    </g>
  );
}
export function AvatarShadow() {
  return (
    <ellipse cx="64" cy="112" rx="32" ry="5" fill="#36314f" opacity=".12" />
  );
}
export function AgentAvatar({
  identity,
  state,
  size = 80,
  motion = "subtle",
  selected = false,
  interactive = false,
}: {
  identity: AvatarIdentity;
  state: RuntimeState;
  size?: number;
  motion?: MotionLevel;
  selected?: boolean;
  interactive?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const ref = useRef<SVGSVGElement>(null);
  const [visible, setVisible] = useState(true);
  const [reaction, setReaction] = useState("");
  useEffect(() => {
    if (state !== "completed" && state !== "error") {
      setReaction("");
      return;
    }
    setReaction(state);
    const timer = setTimeout(() => setReaction(""), 700);
    return () => clearTimeout(timer);
  }, [state]);
  const [pointer, setPointer] = useState<{ x: number; y: number }>();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let inView = true;
    const sync = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      sync();
    });
    observer.observe(el);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  const pose = resolveExpression(identity, state, {
    hovered: !!pointer,
    selected,
    pointer,
  });
  const animated =
    visible &&
    motion !== "off" &&
    size > 48 &&
    !["paused", "disconnected"].includes(state);
  const seed = [...identity.id].reduce((n, c) => n + c.charCodeAt(0), 0);
  return (
    <svg
      ref={ref}
      viewBox="0 0 128 128"
      width={size}
      height={size}
      role="img"
      aria-label={`${identity.name} · ${state.replaceAll("_", " ")}`}
      className={`nook-avatar motion-${animated ? motion : "off"} avatar-${state} reaction-${reaction}`}
      style={
        {
          "--blink-delay": `${-(seed % 9)}s`,
          "--breath-duration": `${5 + (1 - identity.energy) * 4}s`,
        } as CSSProperties
      }
      onPointerMove={
        interactive && size >= 128
          ? (e) => {
              const b = e.currentTarget.getBoundingClientRect();
              setPointer({
                x: ((e.clientX - b.left) / b.width) * 2 - 1,
                y: ((e.clientY - b.top) / b.height) * 2 - 1,
              });
            }
          : undefined
      }
      onPointerLeave={() => setPointer(undefined)}
    >
      <defs>
        <clipPath id={`${id}-body`}>
          <path d={paths[identity.shape]} />
        </clipPath>
        <linearGradient id={id} x1=".2" y1="0" x2=".8" y2="1">
          <stop stopColor={identity.palette[0]} />
          <stop offset="1" stopColor={identity.palette[1]} />
        </linearGradient>
        {[47, 80].map((x, i) => (
          <clipPath key={x} id={`${id}-eye-${i}`}>
            <ellipse
              cx={x}
              cy="65"
              rx={identity.eye === "wide" ? 14 : 12}
              ry="18"
            />
          </clipPath>
        ))}
      </defs>
      <AvatarShadow />
      <g
        className="avatar-pose"
        style={{
          transform: `translateY(${pose.lift}px) rotate(${pose.tilt}deg) scale(${pose.scaleX}, ${pose.scaleY})`,
        }}
      >
        <g className="avatar-breath">
          <AvatarBody identity={identity} gradient={id} />
          <g className="avatar-eyes">
            {[47, 80].map((x, i) => (
              <g key={x} clipPath={`url(#${id}-eye-${i})`}>
                <ellipse cx={x} cy="65" rx="14" ry="18" fill="#fffdf8" />
                <ellipse
                  className="avatar-pupil"
                  cx={x + pose.pupilX + 2}
                  cy={65 + pose.pupilY}
                  rx="6.5"
                  ry="10"
                  fill="#242335"
                />
                <circle
                  cx={x + pose.pupilX + 4}
                  cy={61 + pose.pupilY}
                  r="2"
                  fill="white"
                  opacity=".8"
                />
                <rect
                  className="avatar-lid"
                  x={x - 15}
                  y="45"
                  width="30"
                  height={(1 - pose.openness) * 34}
                  fill={identity.palette[0]}
                />
              </g>
            ))}
          </g>
          {state === "error" && (
            <path
              d="M36 43 l18 4 M72 47 l17 -4"
              fill="none"
              stroke={identity.palette[1]}
              strokeWidth="4"
              strokeLinecap="round"
            />
          )}
        </g>
      </g>
      {size > 48 && (
        <g
          className={`avatar-accent accent-${pose.accent}`}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          stroke={pose.accent === "error" ? "#b44650" : "#bc8523"}
        >
          {pose.accent === "attention" && (
            <path d="M105 24 l5 -8 M112 35 l8 -2" />
          )}
          {pose.accent === "success" && <path d="M107 23 v12 M101 29 h12" />}
          {pose.accent === "error" && <path d="M109 22 v8 M109 36 v1" />}
          {pose.accent === "thinking" && (
            <g fill={identity.palette[1]} stroke="none">
              <circle cx="43" cy="17" r="2" />
              <circle cx="53" cy="13" r="2.5" />
              <circle cx="64" cy="12" r="3" />
            </g>
          )}
        </g>
      )}
    </svg>
  );
}
