-- CreateTable
CREATE TABLE "DrawingFavorite" (
    "userId" TEXT NOT NULL,
    "drawingId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "drawingId"),
    CONSTRAINT "DrawingFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DrawingFavorite_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DrawingFavorite_drawingId_idx" ON "DrawingFavorite"("drawingId");
