import { Controller, Get, Param, Post } from '@nestjs/common';
import { DeadlockService } from './deadlock.service';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

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
            jobId:job.id,
            message:'Матч поставлен в очередь'
        }

    }
}
