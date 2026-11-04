/*
  Warnings:

  - You are about to drop the `PatchHeroChange` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "PatchChangeType" AS ENUM ('GENERAL', 'HERO', 'ITEM');

-- DropForeignKey
ALTER TABLE "PatchHeroChange" DROP CONSTRAINT "PatchHeroChange_heroId_fkey";

-- DropForeignKey
ALTER TABLE "PatchHeroChange" DROP CONSTRAINT "PatchHeroChange_patchId_fkey";

-- DropTable
DROP TABLE "PatchHeroChange";

-- CreateTable
CREATE TABLE "PatchChange" (
    "id" TEXT NOT NULL,
    "patchId" TEXT NOT NULL,
    "type" "PatchChangeType" NOT NULL,
    "changeText" TEXT NOT NULL,
    "heroId" INTEGER,
    "itemId" INTEGER,
    "details" JSONB,

    CONSTRAINT "PatchChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatchChange_patchId_idx" ON "PatchChange"("patchId");

-- CreateIndex
CREATE INDEX "PatchChange_heroId_idx" ON "PatchChange"("heroId");

-- CreateIndex
CREATE INDEX "PatchChange_itemId_idx" ON "PatchChange"("itemId");

-- AddForeignKey
ALTER TABLE "PatchChange" ADD CONSTRAINT "PatchChange_patchId_fkey" FOREIGN KEY ("patchId") REFERENCES "Patch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatchChange" ADD CONSTRAINT "PatchChange_heroId_fkey" FOREIGN KEY ("heroId") REFERENCES "Hero"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatchChange" ADD CONSTRAINT "PatchChange_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
