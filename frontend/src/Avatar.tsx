import type { Session } from "./types";
import { AgentAvatar } from "./features/avatars/AgentAvatar";
import { characters, runtimeFromSession } from "./features/avatars/model";
// Preserve persisted numeric identities and wire states; provider is never an identity.
export function Avatar({
  session,
  large = false,
}: {
  session: Pick<Session, "avatar" | "state">;
  large?: boolean;
}) {
  const index = (n: number) =>
    Number.isFinite(n) ? Math.abs(Math.trunc(n)) % characters.length : 0;
  const seed = characters[index(session.avatar.shape)];
  return (
    <AgentAvatar
      identity={{
        ...seed,
        id: `${session.avatar.name}-${session.avatar.shape}`,
        name: session.avatar.name || seed.name,
        palette: characters[index(session.avatar.color)].palette,
      }}
      state={runtimeFromSession[session.state]}
      size={large ? 112 : 64}
    />
  );
}
