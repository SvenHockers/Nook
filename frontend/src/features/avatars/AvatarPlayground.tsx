import { useEffect, useState } from "react";
import { AgentAvatar } from "./AgentAvatar";
import {
  characters,
  runtimeStates,
  type MotionLevel,
  type RuntimeState,
} from "./model";
export function AvatarPlayground({
  theme,
  setTheme,
}: {
  theme: string;
  setTheme: (theme: string) => void;
}) {
  const [character, setCharacter] = useState(0),
    [state, setState] = useState<RuntimeState>("idle"),
    [size, setSize] = useState(192),
    [motion, setMotion] = useState<MotionLevel>("full"),
    [dense, setDense] = useState(false),
    [cycling, setCycling] = useState(false);
  useEffect(() => {
    if (!cycling) return;
    const timer = setInterval(
      () =>
        setState(
          (s) =>
            runtimeStates[
              (runtimeStates.indexOf(s) + 1) % runtimeStates.length
            ],
        ),
      2400,
    );
    return () => clearInterval(timer);
  }, [cycling]);
  return (
    <div className="work-page">
      <div className="eyebrow">DESIGN PLAYGROUND · SIMULATED STATES</div>
      <h1>A little character.</h1>
      <p className="help">
        One identity, eight expressions. Motion follows system accessibility
        settings.
      </p>
      <div className="playground-controls">
        <label>
          Character
          <select
            value={character}
            onChange={(e) => setCharacter(Number(e.target.value))}
          >
            {characters.map((c, i) => (
              <option key={c.id} value={i}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Runtime state
          <select
            value={state}
            onChange={(e) => setState(e.target.value as RuntimeState)}
          >
            {runtimeStates.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Size
          <select
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          >
            {[32, 64, 96, 128, 192, 240].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Motion
          <select
            value={motion}
            onChange={(e) => setMotion(e.target.value as MotionLevel)}
          >
            {["off", "subtle", "full"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Theme
          <select
            aria-label="Theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          >
            {["system", "light", "dark"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <button className="secondary" onClick={() => setCycling(!cycling)}>
          {cycling ? "Stop simulation" : "Cycle states"}
        </button>
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={dense}
            onChange={(e) => setDense(e.target.checked)}
          />
          15-agent density
        </label>
      </div>
      <div className="avatar-hero">
        <AgentAvatar
          identity={characters[character]}
          state={state}
          size={size}
          motion={motion}
          interactive
          selected
        />
        <h2>{characters[character].name}</h2>
        <p>{state.replaceAll("_", " ")}</p>
      </div>
      <div className={`pose-grid ${dense ? "density-grid" : ""}`}>
        {Array.from({ length: dense ? 15 : 8 }, (_, i) => (
          <div className="pose-card" key={i}>
            <AgentAvatar
              identity={dense ? characters[i % 6] : characters[character]}
              state={runtimeStates[i % 8]}
              size={dense ? 80 : 96}
              motion={motion === "off" ? "off" : "subtle"}
            />
            <strong>
              {dense
                ? characters[i % 6].name
                : runtimeStates[i % 8].replaceAll("_", " ")}
            </strong>
            {dense && (
              <small>{runtimeStates[i % 8].replaceAll("_", " ")}</small>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
