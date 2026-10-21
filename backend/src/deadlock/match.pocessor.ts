import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { DeadlockService } from "./deadlock.service";

@Processor('match-sync-queue')
export class MatchProcessor extends WorkerHost {
    constructor(private deadlockService:DeadlockService){
        super();
    };
   async process(job: Job<{matchId:number}>){
        console.log(`Фоновая загрузка матча: ${job.data.matchId}`);
        const result = await this.deadlockService.syncMatchToDb(job.data.matchId);
        console.log(`Матч ${job.data.matchId} успешно сохранен`);
        return result;
    }
}