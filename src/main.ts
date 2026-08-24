import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { TransformInterceptor } from './common/transform.interceptor';
async function bootstrap() {
  // bodyParser 必须 false：Better Auth 要读原始请求体；库会为非 auth 路由重新挂回 parser。
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // 统一 /api 前缀：业务 controller 变 /api/portfolio 等。
  // better-auth 路由 /api/auth 由 @thallesp/nestjs-better-auth 自动加入排除列表，不受影响。
  app.setGlobalPrefix('api');
  // 前端与后端不同端口时，允许携带 cookie 跨域
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(new ValidationPipe());
  // 统一响应体：把 null 等返回包成 { code, message, data }，避免空 body
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
