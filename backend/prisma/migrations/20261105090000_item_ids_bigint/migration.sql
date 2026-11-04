-- Deadlock item IDs are unsigned 32-bit values and may exceed PostgreSQL INTEGER.
ALTER TABLE "PatchChange" DROP CONSTRAINT "PatchChange_itemId_fkey";

ALTER TABLE "Item"
  ALTER COLUMN "id" TYPE BIGINT USING "id"::BIGINT;

ALTER TABLE "PatchChange"
  ALTER COLUMN "itemId" TYPE BIGINT USING "itemId"::BIGINT;

ALTER TABLE "PatchChange"
  ADD CONSTRAINT "PatchChange_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "Item"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
