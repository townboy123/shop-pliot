/**
 * 限流器端口。契约归 ports，实现归 adapters
 * （进程内版：adapters/resilience/rate-limiter.ts）。
 *
 * 设计意图：
 * - 限流是横切关注点：API 层限 chat 频率，工具护栏限 tool 频率，共用同一接口；
 * - 生产可换 Redis 实现调用方零改动——靠的是本端口，不是实现的位置。
 */

export interface RateLimitDecision {
    /** 是否放行本次调用；false 时调用方应拒绝（如返回 429） */
    allowed: boolean;

    /** 窗口内剩余配额（allowed=false 时为 0） */
    remaining: number;

    /** 当前窗口重置时间（ms 时间戳） */
    resetAt: number;
}

export interface RateLimiterPort {
    /**
     * 记一次命中并判断是否放行。
     * @param key 限流键（如 `chat:{tenantId}:{userId}` / `tool:{tenantId}:{userId}`）
     * @param limit 窗口内允许的最大次数
     * @param windowMs 窗口长度（ms）
     */
    hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}
