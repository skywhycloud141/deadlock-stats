import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable } from '@nestjs/common';
import { TeamType } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DeadlockService {
    private baseUrl = 'https://api.deadlock-api.com/v1';
    constructor(private httpService:HttpService,private prisma:PrismaService){}
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
       const matchInfo = rawData?.match_info;

    if (!matchInfo || !Array.isArray(matchInfo.players)) {
      throw new BadRequestException(`В матче ${matchId} отсутствуют данные об игроках`);
    }

    const winnerTeam: TeamType =
      matchInfo.winning_team === 0 ? TeamType.Amber : TeamType.Sapphire;

    const participants = matchInfo.players.map((player: any) => {
      const statsArray = player.stats || [];
      const finalStats = statsArray.length > 0 ? statsArray[statsArray.length - 1] : null;

      const playerTeam: TeamType =
        player.team === 0 ? TeamType.Amber : TeamType.Sapphire;

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
    const { match, participants } = this.mapMatchToParticipants(matchId, rawData);

    // Шаг Б: Открываем интерактивную транзакцию
    const result = await this.prisma.$transaction(async (tx) => {
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
      const playersToInsert = participants.map((players:any) => ({
        account_id: players.account_id,
        name: `Player_${players.account_id}`, // Заглушка до интеграции со Steam API
      }));

      await tx.player.createMany({
        data: playersToInsert,
        skipDuplicates: true, // Если игрок уже есть в БД — просто пропускаем его без ошибки
      });

      // 3. Сохраняем статистику всех 12 участников (Таблица MatchParticipant)
      const savedParticipants = await tx.matchParticipant.createMany({
        data: participants,
        skipDuplicates: true, // Защита от дублей по @@unique([account_id, match_id])
      });

      return {
        matchId: savedMatch.match_id,
        newParticipantsSaved: savedParticipants.count,
      };
    });
    return result;
  };
}
