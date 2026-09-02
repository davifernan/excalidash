/**
 * Lets an authorised user read an existing share link's address back.
 *
 * The problem this solves, measured 02.09.2026: a link's token exists only in
 * the browser that created it, because the row stores `tokenHash` and nothing
 * else. Before the "a share link keeps its address" change (#310) every
 * settings change rotated the secret, so a token happened to be in hand
 * whenever the dialog was open. Keeping the address stable removed that side
 * effect, and reopening the dialog on an existing link left the copy button
 * with nothing to copy -- and no way to say so.
 *
 * Plain text in the database is not the answer: a database copy would then be a
 * pile of working links. The token is stored encrypted with AES-256-GCM under a
 * key the application holds, so reading it back needs the running instance and
 * not merely its data. `tokenHash` remains the lookup key and is untouched --
 * this is strictly additional.
 *
 * The key is derived from the instance's JWT secret with HKDF and a fixed info
 * label, so there is no new secret to deploy or rotate. The consequence is
 * deliberate and worth stating: rotating JWT_SECRET makes previously stored
 * ciphertexts undecryptable. Links keep working -- lookup is by hash -- they
 * simply become unreadable again, exactly as they are today. Recovery degrades;
 * access does not.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = "v1";
const INFO = "excalidash:share-link-token:v1";

const deriveKey = (secret: string): Buffer =>
  Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), INFO, KEY_BYTES));

/**
 * `v1.<iv>.<ciphertext>.<authTag>`, all base64url. Versioned so a future scheme
 * change can be told apart from corruption rather than guessed at.
 */
export const encryptShareLinkToken = (token: string, secret: string): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
};

/**
 * Returns `null` rather than throwing for anything that cannot be read: a row
 * written before this existed, a value from a different key (JWT_SECRET was
 * rotated), or a tampered one. The caller's job is to show the link when it is
 * available and say it is not when it is not -- a thrown error there would turn
 * "cannot show the address" into "cannot open the share dialog".
 */
export const decryptShareLinkToken = (stored: string | null, secret: string): string | null => {
  if (!stored) return null;
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const [, ivPart, cipherPart, tagPart] = parts;
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveKey(secret),
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(cipherPart, "base64url")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    // GCM authentication failed, or the parts are not what they claim to be.
    return null;
  }
};
