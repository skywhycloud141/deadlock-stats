/*
  Warnings:

  - You are about to drop the column `player_match_outcome` on the `MatchParticipant` table. All the data in the column will be lost.
  - Added the required column `is_winner` to the `MatchParticipant` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `team` on the `MatchParticipant` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "TeamType" AS ENUM ('Amber', 'Sapphire');

-- AlterTable
ALTER TABLE "MatchParticipant" DROP COLUMN "player_match_outcome",
ADD COLUMN     "is_winner" BOOLEAN NOT NULL,
DROP COLUMN "team",
ADD COLUMN     "team" "TeamType" NOT NULL;
