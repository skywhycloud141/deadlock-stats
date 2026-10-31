import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { DeadlockService } from './deadlock.service';
import { Job, JobData, Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { retry, throttleTime } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

@Controller('deadlock')
export class DeadlockController {
  constructor(
    private deadlockService: DeadlockService,
    private prisma: PrismaService,
    @InjectQueue('match-sync-queue') private matchQueue: Queue,
  ) {}
  @Get(':id')
  async getMappedMatch(@Param('id') id: string) {
    const matchId = Number(id);
    const rawMatchData = await this.deadlockService.getMatchMetadata(matchId);
    const cleanOutput = this.deadlockService.mapMatchToParticipants(
      matchId,
      rawMatchData,
    );
    return cleanOutput;
  }
  @Post('sync/:id')
  async syncMatch(@Param('id') id: string) {
    const matchId = Number(id);
    const job = await this.matchQueue.add(
      'sync-match',
      { matchId },
    //   {
    //     jobId: `match-${matchId}`,
    //     attempts: 3,
    //     backoff: {
    //       type: `exponential`,
    //       delay: 2000,
    //     },
    //   },
    );
    return {
      status: 'success',
      jobId: job.id,
      message: 'Матч поставлен в очередь',
    };
  }
  @Post('sync-batch')
  async syncBatch(@Body() body: { matchIds: number[] }) {
    const addBulk = await this.matchQueue.addBulk(
      body.matchIds.map((id) => ({
        name: 'sync-match',
        data: { matchId: id },
      })),
    );

    return addBulk;
  }
  @Get('jobs/:jobId')
  async jobStatus(@Param('jobId') jobId: string) {
    const job = await this.matchQueue.getJob(jobId);

    if (!job) {
      throw new NotFoundException(`Job not found`);
    }

    const status = await job.getState();

    return {
      jobId,
      status,
      failedReason: job.failedReason || null,
      attemptsMade: job.attemptsMade,
    };
  }

  @Get('players/:accountId/overview')
  async getAccountOverview(@Param('accountId') accountId: string) {
    return this.deadlockService.getPlayerOverview(Number(accountId));
  }

  @Get('players/:accountId/heroes')
  async getAccountHeroes(@Param('accountId') accountId: string) {
    return this.deadlockService.getPlayerHeroes(Number(accountId));
  }
  @Get('players/:accountId/matches')
  async getPlayerMatches(accountId: number, page = 1, limit = 10) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));

    const skip = (safePage - 1) * safeLimit;

    const [matches, total] = await this.prisma.$transaction([
      this.prisma.matchParticipant.findMany({
        where: { account_id: accountId },
        include: {
          match: {
            select: {
              duration: true,
            },
          },
        },
        orderBy: {
          match_id: 'desc',
        },
        skip,
        take: safeLimit,
      }),

      this.prisma.matchParticipant.count({
        where: { account_id: accountId },
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
  };
  @Get('players/:accountId/fbi')
  async getFbiReport(@Param("accountId") accountId:string) {
    return this.deadlockService.getPlayerFbiReport(Number(accountId))
  }
  @Get('players/:accountId/coach') 
  async getPlayerCoach(@Param('accountId') accountId:string){
    return this.deadlockService.getPlayerCoachAdvice(Number(accountId))
  }
  @Get('players/:accountId/teammates')
  async getBestTeammates(@Param(`accountId`) accountId:string){
    return this.deadlockService.getBestTeammates(Number(accountId))
  }
}
