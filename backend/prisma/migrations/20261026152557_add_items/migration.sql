/*
  Warnings:

  - Added the required column `items` to the `MatchParticipant` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "MatchParticipant" ADD COLUMN     "items" JSONB NOT NULL;
