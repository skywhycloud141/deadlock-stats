import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable } from '@nestjs/common';
import { TeamType } from '@prisma/client';
import { concatAll, firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import 'dotenv/config';
import Redis from 'ioredis';
import { GoogleGenAI, Type } from '@google/genai';

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
    const cacheKey = `coach:advice:${account_id}`;
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
        'Ты — киберспортивный тренер по Deadlock. Проанализируй цифры игрока и дай конкретные советы без воды на русском языке.',
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
      const statsArray = player.stats || [];
      const finalStats =
        statsArray.length > 0 ? statsArray[statsArray.length - 1] : null;

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
    console.log(`РЕЗУЛЬТАТ ${result}`)
    return result;
  }
  async getPlayerOverview(accountId: number) {
    const stats = await this.prisma.matchParticipant.aggregate({
      where: { account_id: accountId },
      _count: { match_id: true },
      _avg: {
        kills: true,
        deaths: true,
        assists: true,
        net_worth: true,
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

    return {
      accountId,
      totalMatches,
      winrate: `${winrate}%`,
      averages: stats._avg,
      records: stats._max,
    };
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
}
