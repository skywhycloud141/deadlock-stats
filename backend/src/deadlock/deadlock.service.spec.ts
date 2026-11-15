import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { BadRequestException } from '@nestjs/common';
import { DeadlockService } from './deadlock.service';
import { PrismaService } from '../prisma/prisma.service';
import { TeamType } from '@prisma/client';

// Мокаем внешние библиотеки, чтобы при создании DeadlockService
// Jest не открывал реальное соединение к Redis и не требовал ключ Gemini
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    quit: jest.fn(),
  }));
});

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: jest.fn(),
    },
  })),
  Type: {
    OBJECT: 'OBJECT',
    STRING: 'STRING',
    ARRAY: 'ARRAY',
  },
}));

describe('DeadlockService', () => {
  let service: DeadlockService;

  // Заглушка (Mock) для методов PrismaService
  const mockPrismaService = {
    match: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
    player: {
      createMany: jest.fn(),
      upsert: jest.fn(),
    },
    matchParticipant: {
      createMany: jest.fn(),
      findMany: jest.fn(),
      aggregate: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  // Заглушка для HttpService
  const mockHttpService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeadlockService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: HttpService, useValue: mockHttpService },
      ],
    }).compile();

    service = module.get<DeadlockService>(DeadlockService);
    jest.clearAllMocks();
  });

  it('сервис должен быть успешно инициализирован', () => {
    expect(service).toBeDefined();
  });

  // =========================================================================
  // БЛОК 1: Тестирование маппера сырого JSON (mapMatchData)
  // =========================================================================
  describe('mapMatchData', () => {
    it('должен корректно парсить JSON матча, брать финальный урон и фильтровать проданные предметы', () => {
      // 1. Arrange: тестовый слепок на основе ответа Deadlock API
      const rawMockJson = {
        match_info: {
          duration_s: 2518,
          winning_team: 0, // 0 = Amber
          players: [
            {
              account_id: 1927934624,
              hero_id: 1,
              level: 36,
              team: 0,
              kills: 5,
              deaths: 15,
              assists: 18,
              net_worth: 49309,
              last_hits: 169,
              denies: 0,
              abandon_match_time_s: 0,
              items: [
                { item_id: 1593133799, sold_time_s: 0 },   // Остался в инвентаре
                { item_id: 1548066885, sold_time_s: 461 }, // Был продан на 461 сек
              ],
              stats: [
                { time_stamp_s: 180, player_damage: 1487 },
                { time_stamp_s: 2518, player_damage: 28890 }, // Финальный слепок
              ],
            },
          ],
        },
      };

      // 2. Act
      const result = service.mapMatchToParticipants(777, rawMockJson);

      // 3. Assert
      expect(result.match).toEqual({
        match_id: 777,
        duration: 2518,
        winner_team: TeamType.HiddenKing,
      });

      expect(result.participants).toHaveLength(1);
      expect(result.participants[0]).toMatchObject({
        match_id: 777,
        account_id: 1927934624,
        hero_id: 1,
        hero_lvl: 36,
        team: TeamType.HiddenKing,
        kills: 5,
        deaths: 15,
        assists: 18,
        net_worth: 49309,
        last_hits: 169,
        denies: 0,
        damage: 28890,
        is_winner: true,
        abandoned: false,
      });

      if ('items' in result.participants[0]) {
        expect((result.participants[0] as any).items).toEqual([1593133799]);
      }
    });
    it('выбрасывает BadRequestException при пустом JSON', () => {
      expect(() => service.mapMatchToParticipants(777, {})).toThrow(
        BadRequestException,
      );
    });
    
  });

  // =========================================================================
  // БЛОК 2: Тестирование алгоритма порядочности (getPlayerFbiReport)
  // =========================================================================
  describe('getPlayerFbiReport', () => {
    it('должен выдать низкий рейтинг (ранг F) игроку, который ливает и фидит', async () => {
      // 1. Arrange
      mockPrismaService.matchParticipant.findMany.mockResolvedValue([
        {
          match_id: 1,
          account_id: 999,
          kills: 1,
          deaths: 15,
          assists: 2,
          abandoned: true,
          match: { duration: 1800 },
        },
        {
          match_id: 2,
          account_id: 999,
          kills: 0,
          deaths: 12,
          assists: 4,
          abandoned: true,
          match: { duration: 2000 },
        },
      ]);

      // 2. Act
      const report = await service.getPlayerFbiReport(999);

      // 3. Assert
      expect(mockPrismaService.matchParticipant.findMany).toHaveBeenCalledTimes(1);
      expect(report.trustScore).toBe(0);
      expect(report.verdict).toContain('F');
      expect(report.metrics?.feedPercentage).toBe(100);
      expect(report.metrics?.abandonedCount).toBe(2);
    });

    it('должен выдать максимальный рейтинг (ранг S) за три матча без ливов и с хорошим KDA', async () => {
      mockPrismaService.matchParticipant.findMany.mockResolvedValue([
        {
          match_id: 3,
          account_id: 999,
          kills: 19,
          deaths: 9,
          assists: 12,
          abandoned: false,
          match: { duration: 1800 },
        },
        {
          match_id: 2,
          account_id: 999,
          kills: 19,
          deaths: 9,
          assists: 12,
          abandoned: false,
          match: { duration: 2000 },
        },
        {
          match_id: 1,
          account_id: 999,
          kills: 19,
          deaths: 9,
          assists: 12,
          abandoned: false,
          match: { duration: 2200 },
        },
      ]);

      const report = await service.getPlayerFbiReport(999);

      expect(report.matchesAnalyzed).toBe(3);
      expect(report.trustScore).toBe(100);
      expect(report.verdict).toBe('S tier');
      expect(report.metrics).toEqual({
        feedPercentage: 0,
        feedMatchesCount: 0,
        abandonedCount: 0,
        abandonPercentage: 0,
        avgKdaRatio: 3.44,
      });
    });
  });

  // =========================================================================
  // БЛОК 3: Тестирование общей аналитики (getPlayerOverview)
  // =========================================================================
  describe('getPlayerOverview', () => {
    it('рассчитывает winrate по количеству побед и матчей', async () => {
      mockPrismaService.matchParticipant.aggregate.mockResolvedValue({
        _count: { match_id: 10 },
        _avg: {
          kills: 19,
          deaths: 9,
          assists: 12,
          net_worth: 49309,
          souls_at_10m: 12000,
          damage: 28890,
        },
        _max: { kills: 30, damage: 50000, net_worth: 70000 },
      });
      mockPrismaService.matchParticipant.count.mockResolvedValue(6);

      const overview = await service.getPlayerOverview(999);

      expect(mockPrismaService.matchParticipant.aggregate).toHaveBeenCalled();
      expect(mockPrismaService.matchParticipant.count).toHaveBeenCalled();
      expect(overview.totalMatches).toBe(10);
      expect(overview.winrate).toBe('60%');
    });

    it("возвращает winrate '0%' и не NaN% при отсутствии матчей", async () => {
      mockPrismaService.matchParticipant.aggregate.mockResolvedValue({
        _count: { match_id: 0 },
        _avg: {
          kills: null,
          deaths: null,
          assists: null,
          net_worth: null,
          souls_at_10m: null,
          damage: null,
        },
        _max: { kills: null, damage: null, net_worth: null },
      });
      mockPrismaService.matchParticipant.count.mockResolvedValue(0);

      const overview = await service.getPlayerOverview(999);

      expect(overview.totalMatches).toBe(0);
      expect(overview.winrate).toBe('0%');
      expect(overview.winrate).not.toBe('NaN%');
    });
  });
});
