import { describe, expect, it } from "vitest";
import { decryptShareLinkToken, encryptShareLinkToken } from "./shareLinkSecret";

const SECRET = "a-jwt-secret-that-is-long-enough-to-be-real";
const TOKEN = "huLuP9nHdOBoAo3B0aBAKX5SAj-pwMcR";

describe("share link token storage", () => {
  it("reads back exactly what it stored", () => {
    expect(decryptShareLinkToken(encryptShareLinkToken(TOKEN, SECRET), SECRET)).toBe(TOKEN);
  });

  it("never writes the token where a database reader could see it", () => {
    // The whole point of encrypting rather than storing plain text: a copy of
    // the row must not be a working URL.
    //
    // Checking for the literal string is not enough -- a red probe that stored
    // `base64url(token)` passed that check while being plain text in all but
    // name. So decode every part too.
    const stored = encryptShareLinkToken(TOKEN, SECRET);
    expect(stored).not.toContain(TOKEN);
    for (const part of stored.split(".")) {
      expect(Buffer.from(part, "base64url").toString("utf8")).not.toBe(TOKEN);
      expect(Buffer.from(part, "base64").toString("utf8")).not.toBe(TOKEN);
    }
  });

  it("produces a different ciphertext each time, so equal links are not linkable", () => {
    expect(encryptShareLinkToken(TOKEN, SECRET)).not.toBe(encryptShareLinkToken(TOKEN, SECRET));
  });

  it("refuses a value encrypted under a different secret", () => {
    // This is what a rotated JWT_SECRET looks like. It must degrade to "cannot
    // show the address", never to a wrong address or a thrown error.
    const stored = encryptShareLinkToken(TOKEN, SECRET);
    expect(decryptShareLinkToken(stored, `${SECRET}-rotated`)).toBeNull();
  });

  it("refuses a tampered ciphertext instead of returning something", () => {
    const stored = encryptShareLinkToken(TOKEN, SECRET);
    const parts = stored.split(".");
    const flipped = Buffer.from(parts[2], "base64url");
    flipped[0] = flipped[0] ^ 0xff;
    parts[2] = flipped.toString("base64url");
    expect(decryptShareLinkToken(parts.join("."), SECRET)).toBeNull();
  });

  it("treats a link stored before this existed as simply unavailable", () => {
    // Rows predating the column carry null, and that must not throw: the share
    // dialog still has to open.
    expect(decryptShareLinkToken(null, SECRET)).toBeNull();
    expect(decryptShareLinkToken("", SECRET)).toBeNull();
  });

  it("refuses a value that is not in the versioned shape", () => {
    expect(decryptShareLinkToken("garbage", SECRET)).toBeNull();
    expect(decryptShareLinkToken("v2.a.b.c", SECRET)).toBeNull();
    expect(decryptShareLinkToken(TOKEN, SECRET)).toBeNull();
  });
});
