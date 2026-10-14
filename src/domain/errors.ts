/**
 * 领域错误类型。
 *
 * 设计意图：
 * - 全项目用"类型化错误"在层间传递失败语义：API 错误中间件只认 DomainError.code
 *   → HTTP 状态码映射，业务层不需要知道 HTTP 的存在（端口—适配器原则）。
 * - GuardrailViolation / BudgetExceeded 在 instrumentNode 中"原样抛出"，
 *   其他异常被捕获降级为 node_error——这是图不崩的关键约定。
 */

/** 所有领域错误的基类：code 是稳定契约（HTTP 映射与日志检索依赖它） */
export class DomainError extends Error {
    constructor(
        message: string,
        public readonly code: string,
    ) {
        super(message);
        this.name = new.target.name;
    }
}

/** 404 */
export class NotFoundError extends DomainError {}

/** 403（跨租户审批、跨用户记忆访问等横向越权） */
export class ForbiddenError extends DomainError {}

/** 422（护栏违规，code 形如 GUARDRAIL_INPUT_LENGTH） */
export class GuardrailViolation extends DomainError {}

/** 503（硬预算 requestTimeoutMs 超时；软预算不走这里，走优雅降级） */
export class BudgetExceeded extends DomainError {}

/** 工具执行失败（图内捕获降级，不直接映射 HTTP） */
export class ToolExecutionError extends DomainError {}

/** 长期记忆读写失败（记忆是"尽力而为"语义，失败不阻断主流程） */
export class MemoryError extends DomainError {}

/** 409（thread 并发锁、重复 approve 无幂等结果） */
export class ConflictError extends DomainError {}

/** 401（缺失 x-tenant-id / x-user-id） */
export class UnauthenticatedError extends DomainError {}
