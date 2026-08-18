import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * 统一响应体格式。
 * - code: 0 表示成功（业务错误码可后续扩展，0 = 无错误）
 * - message: 提示文案
 * - data: 任意业务数据，含 null（解决 NestJS 对 null 返回空 body 的问题）
 */
export interface UnifiedResponse<T = unknown> {
  code: number;
  message: string;
  data: T | null;
}

/**
 * 全局响应拦截器：把所有 controller 的成功返回统一包成 { code, message, data }。
 *
 * 解决的问题：NestJS 默认对 `return null` 会发送空响应体（Content-Length: 0），
 * 导致前端 res.json() 解析失败、无限重试。统一包装后 null 也变成合法 JSON。
 *
 * 不处理的情况：抛出的异常会绕过本拦截器（异常过滤器负责），错误响应仍是 Nest 默认格式。
 */
@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, UnifiedResponse<T>>
{
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<UnifiedResponse<T>> {
    return next.handle().pipe(
      map((data) => ({
        code: 0,
        message: 'ok',
        data: data ?? null,
      })),
    );
  }
}
