import { Module } from '@nestjs/common';
import { DeadlockService } from './deadlock.service';
import { HttpModule } from '@nestjs/axios';
import { DeadlockController } from './deadlock.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { BullModule } from '@nestjs/bullmq';
import { MatchProcessor } from './match.pocessor';

@Module({
  providers: [DeadlockService, MatchProcessor],
  imports: [
    HttpModule,
    PrismaModule,
    BullModule.registerQueue({
      name: 'match-sync-queue',
    }),
  ],
  controllers: [DeadlockController],
})
export class DeadlockModule {}
