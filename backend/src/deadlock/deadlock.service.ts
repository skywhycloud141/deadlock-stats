import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PatchChangeType, TeamType } from '@prisma/client';
import { load } from 'cheerio';
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
  private readonly logger = new Logger(DeadlockService.name);
  private readonly baseUrl = 'https://api.deadlock-api.com/v1';
  private readonly patchesBaseUrl = 'https://api.deadlock-api.com/v2';
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT)
  });
  private readonly ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  })
  constructor(
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
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
    const profiles = await this.fetchSteamProfiles(participants.map((player:any) => player.account_id))
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
        const playersToInsert = participants.map((player: any) => {
          const accountId = player.account_id;
          const profile = profiles.get(accountId);
            
          return {
            account_id: accountId,
            name: profile?.name,
            avatar_url:profile?.avatarUrl
          }
        });

        await Promise.all(
          playersToInsert.map((player:any) =>
            tx.player.upsert({
              where: { account_id: player.account_id },
              update: {
                ...(player.name ? { name: player.name } : {}),
                ...(player.avatar_url ? { avatar_url: player.avatar_url } : {}),
              },
              create: player,
            }),
          ),
        );

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


  async syncPatches() {
    let feedData: unknown;
    let heroData: unknown;
    let itemData: unknown;

    try {
      const [feedResponse, heroResponse, itemResponse] = await Promise.all([
        firstValueFrom(
          this.httpService.get<unknown>(`${this.patchesBaseUrl}/patches`),
        ),
        firstValueFrom(
          this.httpService.get<unknown>(`${this.baseUrl}/assets/heroes`),
        ),
        firstValueFrom(
          this.httpService.get<unknown>(`${this.baseUrl}/assets/items`),
        ),
      ]);
      feedData = feedResponse.data;
      heroData = heroResponse.data;
      itemData = itemResponse.data;
    } catch (error: unknown) {
      this.logger.error(
        'Failed to fetch patch notes or game assets from Deadlock API',
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException(
        'Deadlock API is temporarily unavailable',
      );
    }

    if (
      !Array.isArray(feedData) ||
      !Array.isArray(heroData) ||
      !Array.isArray(itemData)
    ) {
      throw new ServiceUnavailableException(
        'Deadlock API returned an invalid patches or assets response',
      );
    }

    const feed = feedData.map(parsePatchFeedItem);
    const heroes = heroData.map(parseHeroAsset);
    const items = itemData.map(parseItemAsset);

    if (
      feed.some((patch) => patch === null) ||
      heroes.some((hero) => hero === null) ||
      items.some((item) => item === null)
    ) {
      throw new ServiceUnavailableException(
        'Deadlock API returned an entry with an invalid shape',
      );
    }

    const validFeed = feed.filter((patch): patch is PatchFeedItem => patch !== null);
    const validHeroes = heroes.filter((hero): hero is HeroAsset => hero !== null);
    const validItems = items.filter((item): item is ItemAsset => item !== null);

    if (validFeed.length === 0) {
      throw new ServiceUnavailableException(
        'Deadlock API returned no valid patch notes',
      );
    }

    if (validHeroes.length > 0) {
      await this.prisma.hero.createMany({
        data: validHeroes.map((hero) => ({
          id: hero.id,
          name: hero.name,
          icon_url: hero.iconUrl,
        })),
        skipDuplicates: true,
      });
    }

    if (validItems.length > 0) {
      await this.prisma.item.createMany({
        data: validItems.map((item) => ({
          id: item.id,
          name: item.name,
          icon_url: item.iconUrl,
        })),
        skipDuplicates: true,
      });
    }

    let changesStored = 0;
    for (const feedItem of validFeed) {
      const publishedAt = new Date(feedItem.pub_date);
      let patchUrl: string;
      try {
        patchUrl = new URL(feedItem.link).toString();
      } catch {
        this.logger.warn(`Skipping patch with invalid URL: ${feedItem.title}`);
        continue;
      }

      if (Number.isNaN(publishedAt.getTime())) {
        this.logger.warn(`Skipping patch with invalid date: ${feedItem.title}`);
        continue;
      }

      const patch = await this.prisma.patch.upsert({
        where: { url: patchUrl },
        create: {
          source: feedItem.source,
          title: feedItem.title,
          publishedAt,
          url: patchUrl,
          contentHtml: feedItem.content,
        },
        update: {
          source: feedItem.source,
          title: feedItem.title,
          publishedAt,
          contentHtml: feedItem.content,
        },
      });

      const parsedContent = await this.parsePatchContent(
        feedItem.content,
        patch.id,
      );
      changesStored += parsedContent.changesCount;
    }

    this.logger.log(
      `Synced ${validFeed.length} patch notes and stored ${changesStored} changes`,
    );

    return {
      patchNotesReceived: validFeed.length,
      heroesAvailable: validHeroes.length,
      itemsAvailable: validItems.length,
      changesStored,
    };
  }

  async parsePatchContent(content: string, patchId: string) {
    if (content.trim().length === 0) {
      throw new BadRequestException('Patch content must not be empty');
    }

    if (patchId.trim().length === 0) {
      throw new BadRequestException('Patch ID must not be empty');
    }

    const [heroes, items] = await Promise.all([
      this.prisma.hero.findMany({ select: { id: true, name: true } }),
      this.prisma.item.findMany({ select: { id: true, name: true } }),
    ]);

    const heroLookup = new Map(
      heroes.map((hero) => [normalizeAssetName(hero.name), hero.id]),
    );
    const itemLookup = new Map(
      items.map((item) => [normalizeAssetName(item.name), item.id]),
    );
    const changes = this.extractPatchChanges(content, heroLookup, itemLookup);

    return this.prisma.$transaction(async (transaction) => {
      const patch = await transaction.patch.update({
        where: { id: patchId },
        data: { contentHtml: content },
      });

      await transaction.patchChange.deleteMany({ where: { patchId } });
      if (changes.length > 0) {
        await transaction.patchChange.createMany({
          data: changes.map((change) => ({ ...change, patchId })),
        });
      }

      return { patchId: patch.id, changesCount: changes.length };
    });
  }

  private extractPatchChanges(
    content: string,
    heroLookup: Map<string, number>,
    itemLookup: Map<string, bigint>,
  ): PatchChangeDraft[] {
    const $ = load(content);
    $('script, style, noscript, img').remove();
    $('br').replaceWith('\n');
    $('li').each((_, element) => {
      $(element).prepend('- ');
    });
    $('p, div, li, h1, h2, h3, h4').each((_, element) => {
      $(element).append('\n');
    });

    const lines = $.root()
      .text()
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0);

    const changes: PatchChangeDraft[] = [];
    let currentType: PatchChangeType = PatchChangeType.GENERAL;
    let currentHeroId: number | undefined;
    let currentItemId: bigint | undefined;
    let currentSection = 'General';

    for (const line of lines) {
      const isBullet = /^[-•*]\s*/.test(line);
      const text = line.replace(/^[-•*]\s*/, '').trim();
      const sectionLabel = normalizeAssetName(text.replace(/[:：]\s*$/, ''));

      if (sectionLabel === 'general' || sectionLabel === 'gameplay update') {
        currentType = PatchChangeType.GENERAL;
        currentHeroId = undefined;
        currentItemId = undefined;
        currentSection = text.replace(/[:：]\s*$/, '');
        continue;
      }

      if (sectionLabel === 'heroes') {
        currentType = PatchChangeType.HERO;
        currentHeroId = undefined;
        currentItemId = undefined;
        currentSection = 'Heroes';
        continue;
      }

      if (sectionLabel === 'items') {
        currentType = PatchChangeType.ITEM;
        currentHeroId = undefined;
        currentItemId = undefined;
        currentSection = 'Items';
        continue;
      }

      const exactHeroId = heroLookup.get(sectionLabel);
      if (exactHeroId !== undefined) {
        currentType = PatchChangeType.HERO;
        currentHeroId = exactHeroId;
        currentItemId = undefined;
        currentSection = text.replace(/[:：]\s*$/, '');
        continue;
      }

      const exactItemId = itemLookup.get(sectionLabel);
      if (exactItemId !== undefined) {
        currentType = PatchChangeType.ITEM;
        currentItemId = exactItemId;
        currentHeroId = undefined;
        currentSection = text.replace(/[:：]\s*$/, '');
        continue;
      }

      let changeText = text;
      const separatorIndex = text.indexOf(':');
      if (separatorIndex > 0) {
        const label = normalizeAssetName(text.slice(0, separatorIndex));
        const heroId = heroLookup.get(label);
        const itemId = itemLookup.get(label);

        if (heroId !== undefined) {
          currentType = PatchChangeType.HERO;
          currentHeroId = heroId;
          currentItemId = undefined;
          currentSection = text.slice(0, separatorIndex).trim();
          changeText = text.slice(separatorIndex + 1).trim();
        } else if (itemId !== undefined) {
          currentType = PatchChangeType.ITEM;
          currentItemId = itemId;
          currentHeroId = undefined;
          currentSection = text.slice(0, separatorIndex).trim();
          changeText = text.slice(separatorIndex + 1).trim();
        }
      }

      if (!isBullet || changeText.length === 0) {
        continue;
      }

      changes.push({
        type: currentType,
        changeText,
        ...(currentHeroId === undefined ? {} : { heroId: currentHeroId }),
        ...(currentItemId === undefined ? {} : { itemId: currentItemId }),
        details: { section: currentSection },
      });
    }

    return changes;
  }

  async getPatches(page = 1, limit = 20) {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeLimit = Number.isFinite(limit)
      ? Math.min(100, Math.max(1, Math.floor(limit)))
      : 20;

    const [patches, total] = await this.prisma.$transaction([
      this.prisma.patch.findMany({
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: {
          changes: {
            orderBy: { id: 'asc' },
            include: {
              hero: { select: { id: true, name: true, icon_url: true } },
              item: { select: { id: true, name: true, icon_url: true } },
            },
          },
        },
      }),
      this.prisma.patch.count(),
    ]);

    return {
      data: patches.map((patch) => ({
        ...patch,
        changes: patch.changes.map((change) => ({
          ...change,
          itemId: change.itemId?.toString() ?? null,
          item: change.item
            ? {
                ...change.item,
                id: change.item.id.toString(),
              }
            : null,
        })),
      })),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }
  async fetchSteamProfiles(account_ids:number[]) {
    const apiKey = process.env.STEAM_API_KEY;
    if(!apiKey || account_ids.length === 0){
      return new Map();
    };
    const steamIds64 = account_ids.map((id) => (76561197960265728n+BigInt(id)).toString())
    
    try {
      const url = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/";
      const response = await firstValueFrom(this.httpService.get(url,{
        params:{
          key:apiKey,
          steamids: steamIds64.join(","),
        }
      }
    ))
    const players = response.data?.response?.players || []
    const profileMap = new Map<number,{
      name:string,
      avatarUrl:string
    }>()
    for(const player of players){
      const accountId = Number(BigInt(player.steamid) - 76561197960265728n)
      profileMap.set(accountId,{
        name:player.personaname,
        avatarUrl:player.avatarfull
      })
    }
    return profileMap;
    } catch (error) {
      return new Map();
    }
  }
}

type PatchFeedItem = {
  source: 'forum' | 'steam';
  title: string;
  pub_date: string;
  link: string;
  content: string;
};

type HeroAsset = {
  id: number;
  name: string;
  iconUrl: string | null;
};

type ItemAsset = {
  id: bigint;
  name: string;
  iconUrl: string | null;
};

type PatchChangeDraft = {
  type: PatchChangeType;
  changeText: string;
  heroId?: number;
  itemId?: bigint;
  details: { section: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePatchFeedItem(value: unknown): PatchFeedItem | null {
  if (
    !isRecord(value) ||
    (value.source !== 'forum' && value.source !== 'steam') ||
    typeof value.title !== 'string' ||
    typeof value.pub_date !== 'string' ||
    typeof value.link !== 'string' ||
    typeof value.content !== 'string'
  ) {
    return null;
  }

  return {
    source: value.source,
    title: value.title,
    pub_date: value.pub_date,
    link: value.link,
    content: value.content,
  };
}

function parseHeroAsset(value: unknown): HeroAsset | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    typeof value.name !== 'string'
  ) {
    return null;
  }

  const images = isRecord(value.images) ? value.images : {};
  const iconUrl =
    typeof images.icon_hero_card === 'string'
      ? images.icon_hero_card
      : typeof images.icon_image_small === 'string'
        ? images.icon_image_small
        : null;

  return { id: value.id, name: value.name, iconUrl };
}

function parseItemAsset(value: unknown): ItemAsset | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    typeof value.name !== 'string'
  ) {
    return null;
  }

  const iconUrl =
    typeof value.image === 'string'
      ? value.image
      : typeof value.image_webp === 'string'
        ? value.image_webp
        : null;

  return { id: BigInt(value.id), name: value.name, iconUrl };
}

function normalizeAssetName(name: string): string {
  return name
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
