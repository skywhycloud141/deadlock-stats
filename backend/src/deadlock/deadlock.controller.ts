import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DeadlockService } from './deadlock.service';
import { Queue } from 'bullmq';
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
        const job = await this.matchQueue.add("sync-match",{matchId})
        return {
            status:"success",
            jobId:"match - " + matchId,
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
}

}
