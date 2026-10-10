-- CreateTable
CREATE TABLE "Player" (
    "account_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "Match" (
    "match_id" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL,
    "winner_team" TEXT NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("match_id")
);

-- CreateTable
CREATE TABLE "MatchParticipant" (
    "id" TEXT NOT NULL,
    "account_id" INTEGER NOT NULL,
    "match_id" INTEGER NOT NULL,
    "hero_id" INTEGER NOT NULL,
    "hero_lvl" INTEGER NOT NULL,
    "team" INTEGER NOT NULL,
    "denies" INTEGER NOT NULL,
    "net_worth" INTEGER NOT NULL,
    "last_hits" INTEGER NOT NULL,
    "match_result" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL,
    "kills" INTEGER NOT NULL,
    "deaths" INTEGER NOT NULL,
    "assists" INTEGER NOT NULL,
    "player_match_outcome" INTEGER NOT NULL,
    "abandoned" BOOLEAN NOT NULL,

    CONSTRAINT "MatchParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MatchParticipant_account_id_match_id_key" ON "MatchParticipant"("account_id", "match_id");

-- AddForeignKey
ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Player"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("match_id") ON DELETE RESTRICT ON UPDATE CASCADE;
