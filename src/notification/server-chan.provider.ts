import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationProvider,
  NotificationMessage,
  NotificationResult,
} from './notification';

/**
 * Server酱（方糖）微信推送实现。
 *
 * 文档：https://sct.ftqq.com/
 * 接口：POST https://sctapi.ftqq.com/{sendKey}.send  body: { title, desp }
 * - title 必填，desp 为 Markdown 正文
 * - 响应 JSON：{ code: 0, message: 'OK' } 表示成功
 *
 * 失败降级（不抛错），返回 { ok: false, reason }。
 */
@Injectable()
export class ServerChanProvider extends NotificationProvider {
  private readonly logger = new Logger(ServerChanProvider.name);
  private readonly baseUrl =
    process.env.SERVERCHAN_BASE_URL ?? 'https://sctapi.ftqq.com';

  async send(
    sendKey: string,
    message: NotificationMessage,
  ): Promise<NotificationResult> {
    if (!sendKey) {
      return { ok: false, reason: '缺少 SendKey' };
    }

    const url = `${this.baseUrl}/${encodeURIComponent(sendKey)}.send`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: message.title,
          desp: message.desp,
        }),
      });

      const result = (await response.json().catch(() => null)) as {
        code?: number;
        message?: string;
      } | null;
      const ok = result?.code === 0;
      if (ok) {
        this.logger.log(`Server酱推送成功：${message.title}`);
      } else {
        this.logger.warn(
          `Server酱推送失败：${JSON.stringify(result) ?? response.status}`,
        );
      }
      return {
        ok,
        reason: ok ? undefined : (result?.message ?? `HTTP ${response.status}`),
      };
    } catch (error) {
      const reason = `网络请求失败：${(error as Error).message}`;
      this.logger.error(reason);
      return { ok: false, reason };
    }
  }
}
