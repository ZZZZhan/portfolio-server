import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * 全局异常过滤器：把所有异常统一包装成 { code, message, data }。
 *
 * 与 TransformInterceptor 的成功体 { code:0, message:'ok', data } 对齐：
 * - 成功：code=0
 * - 失败：code=httpStatus, message=可读文案, data=null
 *
 * 捕获范围：@Catch() 全量捕获
 * - HttpException（含 ValidationPipe/BadRequest/NotFound/Unauthorized 等）→ 取 status + message
 * - 非 Http 异常（裸 Error / Prisma / 未知抛错）→ 500
 *
 * 日志：4xx warn，5xx error（带 stack），避免 401/400 刷 error。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const r = res as Record<string, unknown>;
        const raw = (r['message'] as unknown) ?? (r['error'] as unknown) ?? exception.message;
        if (Array.isArray(raw)) {
          message = raw.map(String).join('; ');
        } else if (raw != null) {
          message = String(raw);
        } else {
          message = exception.message;
        }
      } else {
        message = exception.message;
      }
    } else if (exception instanceof Error) {
      // 非 Http 异常：如 snapshot.service 里 `throw new Error('组合不存在')`
      // 统一归为 500，避免泄露内部实现时可在此做白名单映射
      message = exception.message || message;
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} ${status} - ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} ${status} - ${message}`);
    }

    response.status(status).json({
      code: status,
      message,
      data: null,
    });
  }
}
