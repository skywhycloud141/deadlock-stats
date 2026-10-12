import { Controller, Get, Param } from '@nestjs/common';
import { DeadlockService } from './deadlock.service';

@Controller('deadlock')
export class DeadlockController {
    constructor(private deadlockService:DeadlockService){}
    @Get(":id")
    async getMappedMatch(@Param("id") id:string){
        const matchId = Number(id);
        const rawMatchData = await this.deadlockService.getMatchMetadata(matchId);
        const cleanOutput = this.deadlockService.mapMatchToParticipants(matchId,rawMatchData);
        return cleanOutput;
    }
}
