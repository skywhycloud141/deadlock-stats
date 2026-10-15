/*
  Warnings:

  - You are about to drop the column `duration` on the `MatchParticipant` table. All the data in the column will be lost.
  - You are about to drop the column `match_result` on the `MatchParticipant` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "MatchParticipant" DROP COLUMN "duration",
DROP COLUMN "match_result";
