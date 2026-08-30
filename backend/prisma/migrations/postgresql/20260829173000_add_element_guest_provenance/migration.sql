CREATE TABLE "DrawingElementGuestProvenance" (
    "drawingId" TEXT NOT NULL,
    "elementId" TEXT NOT NULL,
    "everGuestTouched" BOOLEAN NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DrawingElementGuestProvenance_pkey" PRIMARY KEY ("drawingId","elementId")
);

CREATE INDEX "DrawingElementGuestProvenance_drawingId_everGuestTouched_idx" ON "DrawingElementGuestProvenance"("drawingId", "everGuestTouched");

ALTER TABLE "DrawingElementGuestProvenance" ADD CONSTRAINT "DrawingElementGuestProvenance_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
