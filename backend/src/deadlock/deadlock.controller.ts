import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { DeadlockService } from './deadlock.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('Deadlock')
@Controller('deadlock')
export class DeadlockController {
  constructor(
    private deadlockService: DeadlockService,
    private prisma: PrismaService,
    @InjectQueue('match-sync-queue') private matchQueue: Queue,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Получить и преобразовать метаданные матча' })
  @ApiParam({ name: 'id', description: 'Числовой ID матча', example: 12345678 })
  @ApiOkResponse({ description: 'Матч и преобразованные данные его участников' })
  @ApiBadRequestResponse({ description: 'Некорректный ID или отсутствуют данные матча' })
  async getMappedMatch(@Param('id') id: string) {
    const matchId = Number(id);
    const rawMatchData = await this.deadlockService.getMatchMetadata(matchId);
    return this.deadlockService.mapMatchToParticipants(matchId, rawMatchData);
  }

  @Post('sync/:id')
  @ApiOperation({ summary: 'Поставить синхронизацию матча в очередь' })
  @ApiParam({ name: 'id', description: 'Числовой ID матча', example: 12345678 })
  @ApiOkResponse({
    description: 'Матч поставлен в очередь',
    schema: {
      example: {
        status: 'success',
        jobId: '42',
        message: 'Матч поставлен в очередь',
      },
    },
  })
  async syncMatch(@Param('id') id: string) {
    const matchId = Number(id);
    const job = await this.matchQueue.add('sync-match', { matchId });
    return {
      status: 'success',
      jobId: job.id,
      message: 'Матч поставлен в очередь',
    };
  }

  @Post('sync-batch')
  @ApiOperation({ summary: 'Поставить несколько матчей в очередь синхронизации' })
  @ApiBody({
    description: 'Список ID матчей для синхронизации',
    schema: {
      type: 'object',
      required: ['matchIds'],
      properties: {
        matchIds: {
          type: 'array',
          items: { type: 'integer' },
          example: [12345678, 12345679],
        },
      },
    },
  })
  @ApiOkResponse({ description: 'Результат добавления задач в очередь' })
  async syncBatch(@Body() body: { matchIds: number[] }) {
    return this.matchQueue.addBulk(
      body.matchIds.map((id) => ({
        name: 'sync-match',
        data: { matchId: id },
      })),
    );
  }

  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Получить состояние задачи синхронизации' })
  @ApiParam({ name: 'jobId', description: 'ID задачи BullMQ', example: '42' })
  @ApiOkResponse({
    description: 'Текущее состояние задачи',
    schema: {
      example: {
        jobId: '42',
        status: 'completed',
        failedReason: null,
        attemptsMade: 1,
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Задача с таким ID не найдена' })
  async jobStatus(@Param('jobId') jobId: string) {
    const job = await this.matchQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundException('Job not found');
    }

    return {
      jobId,
      status: await job.getState(),
      failedReason: job.failedReason || null,
      attemptsMade: job.attemptsMade,
    };
  }

  @Get('players/:accountId/overview')
  @ApiOperation({ summary: 'Получить сводную статистику игрока' })
  @ApiParam({ name: 'accountId', description: 'Steam account ID игрока', example: 123456 })
  @ApiOkResponse({ description: 'Количество матчей, винрейт, средние показатели и рекорды' })
  async getAccountOverview(@Param('accountId') accountId: string) {
    return this.deadlockService.getPlayerOverview(Number(accountId));
  }

  @Get('players/:accountId/heroes')
  @ApiOperation({ summary: 'Получить статистику игрока по героям' })
  @ApiParam({ name: 'accountId', description: 'Steam account ID игрока', example: 123456 })
  @ApiOkResponse({ description: 'Герои с количеством матчей, побед и винрейтом' })
  async getAccountHeroes(@Param('accountId') accountId: string) {
    return this.deadlockService.getPlayerHeroes(Number(accountId));
  }

  @Get('players/:accountId/matches')
  @ApiOperation({ summary: 'Получить матчи игрока с пагинацией' })
  @ApiParam({ name: 'accountId', description: 'Steam account ID игрока', example: 123456 })
  @ApiQuery({ name: 'page', required: false, description: 'Номер страницы (от 1)', example: 1 })
  @ApiQuery({ name: 'limit', required: false, description: 'Размер страницы (от 1 до 100)', example: 10 })
  @ApiOkResponse({ description: 'Матчи игрока и данные пагинации' })
  async getPlayerMatches(
    @Param('accountId') accountId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '10',
  ) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10));
    const numericAccountId = Number(accountId);
    const skip = (safePage - 1) * safeLimit;

    const [matches, total] = await this.prisma.$transaction([
      this.prisma.matchParticipant.findMany({
        where: { account_id: numericAccountId },
        include: { match: { select: { duration: true } } },
        orderBy: { match_id: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.matchParticipant.count({
        where: { account_id: numericAccountId },
      }),
    ]);

    return {
      data: matches.map((participant) => ({
        matchId: participant.match_id,
        heroId: participant.hero_id,
        kills: participant.kills,
        deaths: participant.deaths,
        assists: participant.assists,
        isWinner: participant.is_winner,
        duration: participant.match.duration,
      })),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  @Get('players/:accountId/fbi')
  @ApiOperation({ summary: 'Получить FBI-отчёт игрока по последним матчам' })
  @ApiParam({ name: 'accountId', description: 'Steam account ID игрока', example: 123456 })
  @ApiOkResponse({ description: 'Оценка доверия, вердикт и метрики поведения' })
  async getFbiReport(@Param('accountId') accountId: string) {
    return this.deadlockService.getPlayerFbiReport(Number(accountId));
  }

  @Get('players/:accountId/coach')
  @ApiOperation({ summary: 'Получить советы ИИ-тренера по статистике игрока' })
  @ApiParam({ name: 'accountId', description: 'Steam account ID игрока', example: 123456 })
  @ApiOkResponse({ description: 'Стиль игры, сильные и слабые стороны, практические советы' })
  async getPlayerCoach(@Param('accountId') accountId: string) {
    return this.deadlockService.getPlayerCoachAdvice(Number(accountId));
  }

  @Get('players/:accountId/teammates')
  @ApiOperation({ summary: 'Получить лучших общих союзников игрока' })
  @ApiParam({ name: 'accountId', description: 'Steam account ID игрока', example: 123456 })
  @ApiOkResponse({ description: 'До пяти союзников с числом общих матчей и средней статистикой' })
  async getBestTeammates(@Param('accountId') accountId: string) {
    return this.deadlockService.getBestTeammates(Number(accountId));
  }
}
