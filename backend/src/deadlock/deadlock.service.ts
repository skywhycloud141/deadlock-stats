import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class DeadlockService {
    private baseUrl = 'https://api.deadlock-api.com/v1';
    constructor(private httpService:HttpService){}
    async getMatchMetadata(matchId:number){
        try {
            const response = await firstValueFrom(
                this.httpService.get(`${this.baseUrl}/matches/${matchId}/metadata`, {
                    params:{
                        disable_steam:true,
                    }
                })
            )
            return response.data;
        } catch (error) {
            console.error(error);
        }
    }
      mapMatchToParticipants(matchId: number, rawData: any) {
    const players = rawData?.match_info?.players;
    if (!players || !Array.isArray(players)) {
      return [];
    }

    return players.map((player: any) => {
      const finalStats = player.stats?.length 
        ? player.stats[player.stats.length - 1] 
        : null;

      const teamName = player.team === 0 ? 'Amber' : 'Sapphire';

      return {
        matchId: matchId,
        accountId: player.account_id,
        heroId: player.hero_id,
        team: teamName,
        kills: player.kills || 0,
        deaths: player.deaths || 0,
        assists: player.assists || 0,
        souls: player.net_worth || 0,
        damage: finalStats ? finalStats.player_damage : 0,
        abandoned: player.abandon_match_time_s > 0
      };
    });
  }
}
