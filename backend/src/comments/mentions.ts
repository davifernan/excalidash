/**
 * A mention is a structured token the client's picker inserts, never free-text
 * `@name` matching. Free-text matching would have to guess between "Anna" and
 * "Anna K" and would break the moment two board members share a first name;
 * a token naming the account id has nothing to guess.
 *
 * The wire form is `@[Display Name](userId)`, the same shape GitHub/Slack use
 * for the same reason. Display text is cosmetic -- only the id is trusted, and
 * only after the caller re-checks it against the board's roster (see
 * `resolveMentionTargets`). A client that fabricates an id for someone with no
 * standing claim on the board simply gets no notification for them; it cannot
 * make the server believe otherwise.
 */
import { mentionTokenPattern as MENTION_TOKEN } from "@excalidash/domain/shared";

export const extractMentionedUserIds = (body: string): string[] => {
  const ids = new Set<string>();
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const userId = match[2];
    if (userId) ids.add(userId);
  }
  return Array.from(ids);
};
