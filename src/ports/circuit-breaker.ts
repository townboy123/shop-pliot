/**
 * 熔断器端口（与规格文档 §11.6 一致）。契约归 ports，实现归 adapters
 * （进程内两态版：adapters/resilience/circuit-breaker.ts）。
 *
 * 语义（两态）：连续失败达阈值 → 打开（调用快速失败，CIRCUIT_OPEN）→
 * openMs 后自动闭合、计数清零。生产可换集中式实现，ToolExecutionPolicy 无感。
 */

export type CircuitState = 'closed' | 'open';

export interface CircuitBreakerPort {
    canCall(key: string): Promise<{
        allowed: boolean;
        state: CircuitState;
        /** open 状态下预计恢复时间（ms 时间戳） */
        resetAt?: number;
    }>;
    onSuccess(key: string): Promise<void>;
    onFailure(key: string): Promise<void>;
}
