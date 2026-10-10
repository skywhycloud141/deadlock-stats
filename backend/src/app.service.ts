
import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';

interface PlayerMatch {
  account_id: number;
  match_id: number;
  hero_id: number;
  hero_level: number;
  start_time: number;
  game_mode: number;
  player_kills: number;
  player_deaths: number;
  player_assists: number;
  net_worth: number;
  match_duration_s: number;
  match_result: number;
  team_abandoned: boolean | null;
  abandoned_time_s: number | null;
  objectives_mask_team0: number;
  objectives_mask_team1: number;
}

@Injectable()
export class AppService implements OnModuleInit {
  private readonly logger = new Logger(AppService.name);

  async onModuleInit(): Promise<void> {
    const accountId = "76561199617480231";
    const matchId = "113471271";

    try {
      const url =
        `https://api.deadlock-api.com/v1/players/${accountId}/match-history`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `API вернул HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const matches: PlayerMatch[] = await response.json();

      const match = matches.find(
        (item) => String(item.match_id) === matchId,
      );

      if (!match) {
        this.logger.warn(
          `Матч ${matchId} не найден в полученной истории игрока ${accountId}`,
        );
        return;
      }

      const result = {
        account_id: match.account_id,
        match_id: match.match_id,
        hero_id: match.hero_id,
        hero_level: match.hero_level,
        start_time: match.start_time,
        game_mode: match.game_mode,
        player_kills: match.player_kills,
        player_deaths: match.player_deaths,
        player_assists: match.player_assists,
        net_worth: match.net_worth,
        match_duration_s: match.match_duration_s,
        match_result: match.match_result,
        team_abandoned: match.team_abandoned,
        abandoned_time_s: match.abandoned_time_s,
        objectives_mask_team0: match.objectives_mask_team0,
        objectives_mask_team1: match.objectives_mask_team1,
      };

      this.logger.log(JSON.stringify(result, null, 2));
    } catch (error) {
      this.logger.error(
        'Не удалось получить матч из Deadlock API',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
