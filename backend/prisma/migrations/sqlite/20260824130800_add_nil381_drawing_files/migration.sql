-- CreateTable
CREATE TABLE "DrawingFile" (
    "drawingId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "blobId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("drawingId", "fileId"),
    CONSTRAINT "DrawingFile_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DrawingFile_blobId_fkey" FOREIGN KEY ("blobId") REFERENCES "StoredBlob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DrawingFile_blobId_idx" ON "DrawingFile"("blobId");

-- CreateIndex
CREATE INDEX "DrawingFile_ownerUserId_idx" ON "DrawingFile"("ownerUserId");
