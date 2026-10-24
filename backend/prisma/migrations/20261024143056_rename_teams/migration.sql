/*
  Warnings:

  - The values [Amber,Sapphire] on the enum `TeamType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "TeamType_new" AS ENUM ('HiddenKing', 'Archmother');
ALTER TABLE "MatchParticipant" ALTER COLUMN "team" TYPE "TeamType_new" USING ("team"::text::"TeamType_new");
ALTER TYPE "TeamType" RENAME TO "TeamType_old";
ALTER TYPE "TeamType_new" RENAME TO "TeamType";
DROP TYPE "public"."TeamType_old";
COMMIT;
