/*
  Warnings:

  - Added the required column `damage` to the `MatchParticipant` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "MatchParticipant" ADD COLUMN     "damage" INTEGER NOT NULL;
