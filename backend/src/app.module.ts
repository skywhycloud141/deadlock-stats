import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { DeadlockModule } from './deadlock/deadlock.module';
import { BullModule } from '@nestjs/bullmq'

@Module({
  imports: [PrismaModule, DeadlockModule,BullModule.forRoot({
    connection:{
      host:'localhost',
      port:6379
    }
  })],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
