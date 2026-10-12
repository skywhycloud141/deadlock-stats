import { Module } from '@nestjs/common';
import { DeadlockService } from './deadlock.service';
import { HttpModule } from '@nestjs/axios';
import { DeadlockController } from './deadlock.controller';

@Module({
  providers: [DeadlockService],
  imports:[HttpModule],
  controllers: [DeadlockController]
})
export class DeadlockModule {}
