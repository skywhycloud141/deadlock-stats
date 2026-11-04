-- CreateTable
CREATE TABLE "Patch" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "url" TEXT NOT NULL,
    "contentHtml" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Patch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatchHeroChange" (
    "patchId" TEXT NOT NULL,
    "heroId" INTEGER NOT NULL,
    "summary" TEXT,
    "changeText" TEXT NOT NULL,

    CONSTRAINT "PatchHeroChange_pkey" PRIMARY KEY ("patchId","heroId")
);

-- CreateTable
CREATE TABLE "Hero" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "icon_url" TEXT,

    CONSTRAINT "Hero_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "icon_url" TEXT,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Patch_url_key" ON "Patch"("url");

-- CreateIndex
CREATE INDEX "Patch_publishedAt_idx" ON "Patch"("publishedAt");

-- CreateIndex
CREATE INDEX "PatchHeroChange_heroId_idx" ON "PatchHeroChange"("heroId");

-- AddForeignKey
ALTER TABLE "PatchHeroChange" ADD CONSTRAINT "PatchHeroChange_patchId_fkey" FOREIGN KEY ("patchId") REFERENCES "Patch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatchHeroChange" ADD CONSTRAINT "PatchHeroChange_heroId_fkey" FOREIGN KEY ("heroId") REFERENCES "Hero"("id") ON DELETE CASCADE ON UPDATE CASCADE;
