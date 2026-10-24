import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { DeadlockService } from './deadlock.service';
import { Job, JobData, Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { retry } from 'rxjs';

@Controller('deadlock')
export class DeadlockController {
    constructor(private deadlockService:DeadlockService,@InjectQueue('match-sync-queue') private matchQueue:Queue){}
    @Get(":id")
    async getMappedMatch(@Param("id") id:string){
        const matchId = Number(id);
        const rawMatchData = await this.deadlockService.getMatchMetadata(matchId);
        const cleanOutput = this.deadlockService.mapMatchToParticipants(matchId,rawMatchData);
        return cleanOutput;
    }
    @Post("sync/:id")
    async syncMatch(@Param("id") id:string){
        const matchId = Number(id);
        const job = await this.matchQueue.add(
            "sync-match",
            {matchId},
        {
            jobId:`match-${matchId}`,
            attempts:3,
            backoff:{
                type:`exponential`,
                delay:2000
            }
        })
        return {
            status:"success",
            jobId:job.id,
            message:'Матч поставлен в очередь'
        }

    }
   @Post('sync-batch')
async syncBatch(@Body() body: { matchIds: number[] }) {
  
  const addBulk = await this.matchQueue.addBulk(
    body.matchIds.map((id) => ({
      name: 'sync-match',
      data: { matchId: id },
    })),
  );


  return addBulk
};
    @Get("jobs/:jobId")
    async jobStatus(@Param('jobId') jobId: string){
        const job = await this.matchQueue.getJob(jobId);

        if(!job) {
            throw new NotFoundException(`Job not found`)
        }

        const status = await job.getState();

        return{
            jobId,
            status,
        };
        
    };

    @Get('players/:accountId/overview')
    async getAccountOverview(@Param('accountId') accountId:string ) {
        return this.deadlockService.getPlayerOverview(Number(accountId))
    };

    @Get('players/:accountId/heroes')
    async getAccountHeroes(@Param('accountId') accountId:string ) {
        return this.deadlockService.getPlayerHeroes(Number(accountId))
    };

}
