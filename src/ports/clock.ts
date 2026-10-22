/**
 * Clock 端口。
 *
 * 设计意图（时间可测性）：
 * - 退货窗口、wallClock 预算、记忆 TTL、日志时间戳一律经 Clock 注入；
 * - 全项目禁止散落的 Date.now() / new Date()（端口层实现除外），
 *   测试用 fixedClock 精确推进时间，TTL/窗口/熔断全部可复现。
 */

export interface Clock {
    now(): Date;
    nowMs(): number;
}

/** 生产时钟：直接读系统时间 */
export function systemClock(): Clock {
    return {
        now: () => new Date(),
        nowMs: () => Date.now(),
    };
}

/**
 * 测试固定时钟：所有调用返回同一时刻。
 * @param at 固定时刻（Date | ISO 字符串 | 毫秒时间戳）
 */
export function fixedClock(at: Date | string | number): Clock {
    const t = typeof at === 'object' ? at.getTime() : new Date(at).getTime();
    return {
        now: () => new Date(t),
        nowMs: () => t,
    };
}
