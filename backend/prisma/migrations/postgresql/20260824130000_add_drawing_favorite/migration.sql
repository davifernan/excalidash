-- CreateTable
CREATE TABLE "DrawingFavorite" (
    "userId" TEXT NOT NULL,
    "drawingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DrawingFavorite_pkey" PRIMARY KEY ("userId","drawingId")
);

-- CreateIndex
CREATE INDEX "DrawingFavorite_drawingId_idx" ON "DrawingFavorite"("drawingId");

-- AddForeignKey
ALTER TABLE "DrawingFavorite" ADD CONSTRAINT "DrawingFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawingFavorite" ADD CONSTRAINT "DrawingFavorite_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
