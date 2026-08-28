-- Historical behavior is data, not an accidental column default:
-- link guests can read comments, but cannot upload files. Keep both halves
-- explicit so a later instance-wide enable does not opt old boards in.
ALTER TABLE "SystemConfig" ADD COLUMN "guestUploadEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SystemConfig" ADD COLUMN "guestCommentVisibilityEnabled" BOOLEAN NOT NULL DEFAULT true;
UPDATE "SystemConfig"
SET "guestUploadEnabled" = false,
    "guestCommentVisibilityEnabled" = true;

ALTER TABLE "Drawing" ADD COLUMN "guestUploadEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Drawing" ADD COLUMN "guestCommentVisibilityEnabled" BOOLEAN NOT NULL DEFAULT true;
UPDATE "Drawing"
SET "guestUploadEnabled" = false,
    "guestCommentVisibilityEnabled" = true;
