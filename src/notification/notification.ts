/**
 * NotificationProvider —— 推送适配器抽象类（DI 缝）。
 *
 * 对外微信推送集中在抽象背后，便于：
 * 1. 测试注入 fake（不入网验证文案 / 调用）
 * 2. 未来换服务商（PushPlus / 企微 / Bark）只换一个实现并切换模块绑定
 * 3. 与 PriceProvider 同一模式：抽象类充当 DI token，调用方只依赖抽象
 */

/**
 * 一条推送到微信的消息（Server酱支持 title + Markdown desp）。
 */
export interface NotificationMessage {
  title: string;
  /** Markdown 正文 */
  desp: string;
}

/**
 * 推送结果标记：成功或失败（含是否因缺 key / 网络原因失败）。
 */
export interface NotificationResult {
  ok: boolean;
  reason?: string;
}

/**
 * 抽象类 —— 同时充当 Nest DI token。
 * 具体实现（ServerChan / fake）继承它并实现 send。
 * 模块里用 `{ provide: NotificationProvider, useClass: ServerChanProvider }` 绑定。
 */
export abstract class NotificationProvider {
  /**
   * 用给定的推送凭据（如 Server酱 SendKey）发送一条消息。
   * 实现应自行捕获网络异常，返回 { ok: false, reason } 而非抛错，
   * 避免单个推送失败拖垮调用链（对齐 PriceProvider 的降级风格）。
   *
   * @param sendKey 推送凭据（用户配置的 SendKey）
   * @param message title + Markdown desp
   */
  abstract send(
    sendKey: string,
    message: NotificationMessage,
  ): Promise<NotificationResult>;
}
