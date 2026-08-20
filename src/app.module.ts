import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { auth } from './lib/auth';
import { PrismaModule } from './prisma/prisma.module';
import { PortfolioModule } from './portfolio/portfolio.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // Better Auth：自动挂载 /api/auth/* 路由、注册全局 AuthGuard（默认所有路由需登录）、
    // 为非 auth 路由重新挂回 body parser。
    AuthModule.forRoot({ auth }),
    PrismaModule,
    PortfolioModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
