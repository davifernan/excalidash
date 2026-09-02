-- Lets an authorised user read an existing share link back (see
-- backend/src/authz/shareLinkSecret.ts). Nullable on purpose: rows written
-- before this stay readable-as-unavailable rather than needing a backfill,
-- and lookup keeps using tokenHash.
ALTER TABLE "DrawingLinkShare" ADD COLUMN "tokenCipher" TEXT;
