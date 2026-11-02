import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable } from '@nestjs/common';
import { TeamType } from '@prisma/client';
import { concatAll, firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import 'dotenv/config';
import Redis from 'ioredis';
import { GoogleGenAI, Type } from '@google/genai';

type PlayerOverview = {
  accountId: number;
  totalMatches: number;
  winrate: string;
  averages: {
    kills: number | null;
    deaths: number | null;
    assists: number | null;
    net_worth: number | null;
    souls_at_10m: number | null;
    damage: number | null;
  };
  records: {
    kills: number | null;
    damage: number | null;
    net_worth: number | null;
  };
};

@Injectable()
export class DeadlockService {
  private baseUrl = 'https://api.deadlock-api.com/v1';
  private redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT)
  });
  private ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  })
  constructor(
    private httpService: HttpService,
    private prisma: PrismaService,
  ) {}
  async getPlayerCoachAdvice(account_id: number){
    const cacheKey = `coach:advice:v2:${account_id}`;
    const cachedAdvice = await this.redis.get(cacheKey);
    if(cachedAdvice){
      return {
        account_id,
        fromCache: true,
        coachReport: JSON.parse(cachedAdvice)
      }
    } 
    const [overview, heroes, fbi] = await Promise.all([
      this.getPlayerOverview(account_id),
      this.getPlayerHeroes(account_id),
      this.getPlayerFbiReport(account_id)
    ])
    if(overview.totalMatches === 0){
      throw new BadRequestException(`Нет сохраненных матчей для анализа`);
    }
    const playerContext = `
    Статистика игрока Deadlock (ID: ${account_id}) за ${overview.totalMatches} матчей:
    - Винрейт: ${overview.winrate}
    - Средний KDA: ${Number(overview.averages.kills).toFixed(1)} / ${Number(overview.averages.deaths).toFixed(1)} / ${Number(overview.averages.assists).toFixed(1)}
    - Средний Net Worth к 10-й минуте (лайнинг-стадия): ${Math.round(overview.averages.souls_at_10m ?? 0)}
    - Средний фарм душ (Net Worth): ${Math.round(overview.averages.net_worth ?? 0)}
    - Средний урон: ${Math.round(overview.averages.damage ?? 0)}
    - Индекс порядочности (FBI): ${fbi.trustScore}/100 (${fbi.verdict}), доля фида: ${fbi.metrics?.feedPercentage}
    - Топ-3 героя: ${JSON.stringify(heroes.slice(0, 3))}
  `;

  const response = await this.ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: playerContext,
    config: {
      systemInstruction:
        'Ты — киберспортивный тренер по Deadlock. Отдельно оцени лайнинг-стадию по среднему Net Worth к 10-й минуте и лейт-гейм по среднему итоговому Net Worth. Сравни ранний и поздний темп фарма, затем дай конкретные советы без воды на русском языке.',
      temperature: 0.7,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          playstyle: { type: Type.STRING },
          strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
          weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
          actionableTips: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['playstyle', 'strengths', 'weaknesses', 'actionableTips'],
      },
    },
  });

  const aiJsonString = response.text || '{}';
  await this.redis.set(cacheKey, aiJsonString, 'EX', 6*60*60)
  return {
    account_id,
    fromCache: false,
    coachReport: JSON.parse(aiJsonString)
  }

  }
  async getMatchMetadata(matchId: number) {
    if (!Number.isSafeInteger(matchId) || matchId <= 0) {
      throw new BadRequestException(`Invalid match id: ${matchId}`);
    }

    // Let Axios errors reach BullMQ so it can mark/retry the job correctly.
    // Returning undefined here made the later mapper fail with a misleading error.
    const response = await firstValueFrom(
      this.httpService.get(`${this.baseUrl}/matches/${matchId}/metadata`, {
        params: { disable_steam: true },
      }),
    );

    if (!response.data || typeof response.data !== 'object') {
      throw new BadRequestException(
        `Match metadata response is empty or invalid for match ${matchId}`,
      );
    }

    return response.data;
  }
  mapMatchToParticipants(matchId: number, rawData: any) {
    const matchInfo = rawData?.match_info;

    if (!matchInfo || !Array.isArray(matchInfo.players)) {
      throw new BadRequestException(
        `В матче ${matchId} отсутствуют данные об игроках`,
      );
    }

    const winnerTeam: TeamType =
      matchInfo.winning_team === 0 ? TeamType.HiddenKing : TeamType.Archmother;

    const participants = matchInfo.players.map((player: any) => {
      const statsArray = Array.isArray(player.stats) ? player.stats : [];
      const finalStats =
        statsArray.length > 0 ? statsArray[statsArray.length - 1] : null;
      const isTimedStats = (
        stat: unknown,
      ): stat is { time_stamp_s: number; net_worth: number } =>
        typeof stat === 'object' &&
        stat !== null &&
        'time_stamp_s' in stat &&
        typeof stat.time_stamp_s === 'number' &&
        'net_worth' in stat &&
        typeof stat.net_worth === 'number';
      const statsAtTenMinutes = statsArray
        .filter(isTimedStats)
        .sort(
          (
            a: { time_stamp_s: number; net_worth: number },
            b: { time_stamp_s: number; net_worth: number },
          ) =>
            Math.abs(a.time_stamp_s - 600) - Math.abs(b.time_stamp_s - 600) ||
            a.time_stamp_s - b.time_stamp_s,
        )[0];

      const playerTeam: TeamType =
        player.team === 0 ? TeamType.HiddenKing : TeamType.Archmother;

      return {
        match_id: matchId,
        account_id: player.account_id,
        hero_id: player.hero_id,
        hero_lvl: player.level ?? 1,
        team: playerTeam,
        kills: player.kills ?? 0,
        deaths: player.deaths ?? 0,
        assists: player.assists ?? 0,
        net_worth: player.net_worth ?? 0,
        last_hits: player.last_hits ?? 0,
        denies: player.denies ?? 0,
        damage: finalStats?.player_damage ?? 0,
        is_winner: playerTeam === winnerTeam,
        abandoned: (player.abandon_match_time_s ?? 0) > 0,
        // `items` is a required Json column; older or partial API payloads may omit it.
        items: Array.isArray(player.items) ? player.items : [],
        assigned_lane: player.assigned_lane ?? 0,
        souls_at_10m: statsAtTenMinutes?.net_worth ?? 0,
      };
    });

    return {
      match: {
        match_id: matchId,
        duration: matchInfo.duration_s ?? 0,
        winner_team: winnerTeam,
      },
      participants,
    };
  }
  // 3. Сохранение в БД через Транзакцию (ACID)
  async syncMatchToDb(matchId: number) {
    // Шаг А: Скачиваем и маппим данные ДО открытия транзакции!
    // (Никогда не держим транзакцию БД открытой во время долгих HTTP-запросов)
    const rawData = await this.getMatchMetadata(matchId);
    // console.log(rawData)
    const { match, participants } = this.mapMatchToParticipants(
      matchId,
      rawData,
    );

    // Шаг Б: Открываем интерактивную транзакцию
    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1. Создаем или обновляем запись самого матча (Таблица Match)
        const savedMatch = await tx.match.upsert({
          where: { match_id: match.match_id },
          update: {
            duration: match.duration,
            winner_team: match.winner_team,
          },
          create: {
            match_id: match.match_id,
            duration: match.duration,
            winner_team: match.winner_team,
          },
        });

        // 2. Создаем игроков в таблице Player (чтобы не упал Foreign Key)
        const playersToInsert = participants.map((players: any) => ({
          account_id: players.account_id,
          name: `Player_${players.account_id}`, // Заглушка до интеграции со Steam API
        }));

        await tx.player.createMany({
          data: playersToInsert,
          skipDuplicates: true, // Если игрок уже есть в БД — просто пропускаем его без ошибки
        });

        // 3. Сохраняем статистику всех 12 участников (Таблица MatchParticipant)
        const savedParticipants = await tx.matchParticipant.createMany({
          data: participants,
          skipDuplicates: true, // Защита от дублей по @@unique([account_id, match_id])
        });
        return {
          matchId: savedMatch.match_id,
          newParticipantsSaved: savedParticipants.count,
        };
      },
      {
        maxWait: 5000,
        timeout: 10000,
      },
    );
    const cacheKeysToDelete = participants.flatMap((participant: { account_id: number }) => [
      `coach:advice:v2:${participant.account_id}`,
      `player:overview:${participant.account_id}`,
    ]);
    if (cacheKeysToDelete.length > 0) {
      await this.redis.del(...cacheKeysToDelete);
    }
    console.log(`РЕЗУЛЬТАТ ${result}`)
    return result;
  }
  async getPlayerOverview(accountId: number): Promise<PlayerOverview> {
    const cacheKey = `player:overview:${accountId}`;
    const cachedOverview = await this.redis.get(cacheKey);
    if (cachedOverview) {
      return JSON.parse(cachedOverview) as PlayerOverview;
    }

    const stats = await this.prisma.matchParticipant.aggregate({
      where: { account_id: accountId },
      _count: { match_id: true },
      _avg: {
        kills: true,
        deaths: true,
        assists: true,
        net_worth: true,
        souls_at_10m: true,
        damage: true,
      },
      _max: {
        kills: true,
        damage: true,
        net_worth: true,
      },
    });

    const wins = await this.prisma.matchParticipant.count({
      where: { account_id: accountId, is_winner: true },
    });

    const totalMatches = stats._count.match_id;
    const winrate =
      totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;

    const overview: PlayerOverview = {
      accountId,
      totalMatches,
      winrate: `${winrate}%`,
      averages: stats._avg,
      records: stats._max,
    };

    await this.redis.set(cacheKey, JSON.stringify(overview), 'EX', 1800);
    return overview;
  }
  async getPlayerHeroes(accountId: number) {
    const groups = await this.prisma.matchParticipant.groupBy({
      by: ['hero_id', 'is_winner'],
      where: { account_id: accountId },
      _count: { match_id: true },
    });

    const heroes = new Map<number, { matches: number; wins: number }>();

    for (const group of groups) {
      const hero = heroes.get(group.hero_id) ?? {
        matches: 0,
        wins: 0,
      };

      hero.matches += group._count.match_id;

      if (group.is_winner) {
        hero.wins += group._count.match_id;
      }

      heroes.set(group.hero_id, hero);
    }

    return Array.from(heroes.entries())
      .map(([heroId, stats]) => ({
        heroId,
        matches: stats.matches,
        wins: stats.wins,
        winrate: Number(((stats.wins / stats.matches) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.matches - a.matches);
  }
  async getLaneStats(accountId: number) {
    const groups = await this.prisma.matchParticipant.groupBy({
      //Обязателен ли is_winner?
      by: ['assigned_lane', 'is_winner'],
      where: { account_id: accountId },
      _count: { match_id: true },
      _sum: { net_worth: true },
    });

    const lanes = new Map<
      number,
      { matches: number; wins: number; netWorthTotal: number }
    >();

    for (const group of groups) {
      const lane = lanes.get(group.assigned_lane) ?? {
        matches: 0,
        wins: 0,
        netWorthTotal: 0,
      };

      lane.matches += group._count.match_id;
      lane.netWorthTotal += group._sum.net_worth ?? 0;
      if (group.is_winner) {
        lane.wins += group._count.match_id;
      }
      lanes.set(group.assigned_lane, lane);
    }

    const laneStats = Array.from(lanes.entries())
      .map(([assignedLane, stats]) => ({
        assignedLane,
        matches: stats.matches,
        wins: stats.wins,
        winrate: Number(((stats.wins / stats.matches) * 100).toFixed(1)),
        averageNetWorth: Math.round(stats.netWorthTotal / stats.matches),
      }))
      .sort((a, b) => b.winrate - a.winrate || b.matches - a.matches);

    return {
      accountId,
      bestLane: laneStats[0] ?? null,
      lanes: laneStats,
    };
  }
  async getPlayerTopItems(accountId: number) {
    const participants = await this.prisma.matchParticipant.findMany({
      where: { account_id: accountId },
      select: { items: true },
    });

    const itemCounts = new Map<number, number>();

    for (const participant of participants) {
      if (!Array.isArray(participant.items)) continue;

      for (const item of participant.items) {
        if (
          typeof item === 'object' &&
          item !== null &&
          'item_id' in item &&
          typeof item.item_id === 'number'
        ) {
          const itemId = item.item_id;

          itemCounts.set(itemId, (itemCounts.get(itemId) ?? 0) + 1);
        }
      }
    }

    return Array.from(itemCounts.entries())
      .map(([itemId, purchases]) => ({ itemId, purchases }))
      .sort((a, b) => b.purchases - a.purchases)
      .slice(0, 5);
  }
  async getPlayerFbiReport(account_id: number) {
    const recentMatches = await this.prisma.matchParticipant.findMany({
      where: { account_id: account_id },
      include: { match: { select: { duration: true } } },
      orderBy: { match_id: 'desc' },
      take: 20,
    });
    if (recentMatches.length === 0) {
      return { account_id, status: `Недостаточно данных для расследования` };
    }
    let abandonedCount = 0;
    let feedMatchesCount = 0;
    let totalDeaths = 0;
    let totalKillsAndAssists = 0;
    for (const match of recentMatches) {
      totalDeaths += match.deaths;
      totalKillsAndAssists += match.kills + match.assists;
      if (match.abandoned) {
        abandonedCount++;
      }
      const kda = (match.kills + match.assists) / Math.max(1, match.deaths);
      if (match.deaths >= 10 && kda < 1.0) {
        feedMatchesCount++;
      }
    }
    const matchesAnalyzed = recentMatches.length;
    const feedPercentage = Math.round((feedMatchesCount/matchesAnalyzed)*100);
    const abandonPercentage = Math.round((abandonedCount/matchesAnalyzed)*100);
    let trustScore = 100 - feedPercentage*0.6 - abandonedCount*25;
    trustScore = Math.max(0,Math.min(100,Math.round(trustScore)));
    let verdict = `S tier`;
    if(trustScore<40){
      verdict = `F tier`
    } else if(trustScore<65){
      verdict = `C Tier`
    } else if (trustScore<85){
      verdict = `A tier`
    }
    return {
      account_id,
      matchesAnalyzed,
      trustScore,
      verdict,
      metrics:{
        feedPercentage,
        feedMatchesCount,
        abandonedCount,
        abandonPercentage,
        avgKdaRatio:Number((totalKillsAndAssists/Math.max(1,totalDeaths)).toFixed(2))
      }
    }
  }
  async getBestTeammates(account_id:number){
    const myParticipants = await this.prisma.matchParticipant.findMany({
      where:{account_id:account_id},
      select:{match_id:true,team:true,is_winner:true}
    });
    if (myParticipants.length === 0) {
      return []
    }
    const matchIds = myParticipants.map((m) => m.match_id);
    const allParticipantsInMatches = await this.prisma.matchParticipant.findMany({
      where:{
        match_id:{in:matchIds},
        account_id:{not:account_id}
      },
      select:{
        account_id:true,
        match_id:true,
        team:true,
        is_winner:true,
        kills:true,
        deaths:true,
        assists:true
      }
    });
    const myTeamByMatch = new Map(
      myParticipants.map((m) => [m.match_id,m.team])
    );
    const teammatesStats = new Map<number,{matches:number,wins:number,totalKills:number,totalDeaths:number,totalAssists:number}>();
    for(const player of allParticipantsInMatches){
      const myTeam = myTeamByMatch.get(player.match_id);
      if(player.team !== myTeam){
        continue
      };
      const current = teammatesStats.get(player.account_id) || {
        matches:0,
        wins:0,
        totalKills:0,
        totalDeaths:0,
        totalAssists:0
      };
      current.matches += 1
      if(player.is_winner){
        current.wins += 1
      }
      current.totalKills += player.kills;
      current.totalDeaths += player.deaths;
      current.totalAssists += player.assists;

      teammatesStats.set(player.account_id,current)
    };
    return Array.from(teammatesStats.entries()).map(([teammateId, stat]) => {
      return{
        teammateId,
        sharedMatches:stat.matches,
        wins: stat.wins,
        avgKills:(stat.totalKills/stat.matches).toFixed(1),
        avgDeaths:(stat.totalDeaths/stat.matches).toFixed(1),
        avgAssists:(stat.totalAssists/stat.matches).toFixed(1)
      }
    }).sort((a, b) => b.sharedMatches - a.sharedMatches || b.wins-a.wins).slice(0,5);
  }
}
