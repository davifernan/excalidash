/**
 * The wire form for a mention: `@[Display Name](userId)`. Matches the
 * backend's `extractMentionedUserIds` exactly -- see
 * backend/src/comments/mentions.ts for why a structured token beats
 * free-text `@name` matching.
 */
const MENTION_TOKEN = /@\[([^\]\n]{1,120})\]\(([0-9a-fA-F-]{8,64})\)/g;

export const mentionToken = (name: string, userId: string): string => `@[${name}](${userId})`;

export type MentionSegment =
  { kind: "text"; text: string } | { kind: "mention"; name: string; userId: string };

/** Split a comment body into plain text and mention segments, for display. */
export const splitMentionSegments = (body: string): MentionSegment[] => {
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ kind: "text", text: body.slice(lastIndex, index) });
    segments.push({ kind: "mention", name: match[1], userId: match[2] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < body.length) segments.push({ kind: "text", text: body.slice(lastIndex) });
  return segments;
};
