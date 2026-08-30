/**
 * Cursor chat's wire contract (NIL-637, Zweig B): the socket event name and
 * the text length cap, the two values `backend/src/server/socketCursorChat.ts`
 * and `frontend/src/pages/editor/cursorChat.ts` each declared independently,
 * with the frontend side's own comment reading "Matches the server's cap;
 * the server is still the one that enforces it" -- a claim with nothing
 * behind it but a human remembering to update both sides together.
 *
 * The two sides are NOT symmetric beyond this: the server is the one that
 * validates and rejects an over-cap message outright
 * (`socketCursorChat.ts`'s `parseCursorChatPayload`); the frontend only
 * truncates a remote bubble for display, since by the time it sees a
 * message the server has already accepted it. That asymmetry is
 * deliberate and stays local to each side -- only the cap value and the
 * event name are the actual shared contract.
 */

export const CURSOR_CHAT_EVENT = "cursor-chat";

/** Long enough for a sentence, short enough that it cannot become an essay. */
export const CURSOR_CHAT_TEXT_MAX_LENGTH = 140;
