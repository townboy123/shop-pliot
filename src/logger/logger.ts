import { pino, type Logger as PinoLogger } from 'pino';

/**
 * 日志端口（ports 层）。
 *
 * 设计意图：
 * - 应用代码只依赖此接口，不直接 import pino——"换日志实现 = 换 adapter"，
 *   测试时可注入内存实现收集日志做断言（与 AppConfig 的注入哲学一致）；
 * - 方法签名采用结构化风格：第一参数是字段对象，第二参数是消息模板，
 *   避免字符串拼接（结构化日志才能按字段检索、聚合）；
 * - child() 用于派生携带上下文绑定的子 logger（如 { tenantId, requestId }），
 *   每个请求开始时 child 一次，之后整条调用链的日志自动带上下文，无需逐条传。
 *
 * 与 LogLevel（config 层）的对应关系：fatal / error / warn / info / debug。
 */
export interface Logger {
    /** 致命错误：进程即将不可用，只记录不修复。 */
    fatal(obj: unknown, msg?: string): void;

    /** 错误：当前操作失败但有兜底（降级/重试），需要人工关注。 */
    error(obj: unknown, msg?: string): void;

    /** 警告：操作成功但出现异常信号（如接近预算上限、熔断器半开）。 */
    warn(obj: unknown, msg?: string): void;

    /** 信息：关键业务事件（请求开始/结束、工具调用、interrupt/resume）。 */
    info(obj: unknown, msg?: string): void;

    /** 调试：开发期排查用的细节（prompt 内容、中间状态），生产默认关闭。 */
    debug(obj: unknown, msg?: string): void;

    /** 派生携带固定绑定字段的子 logger（绑定会出现在该子 logger 的每条日志里）。 */
    child(bindings: Record<string, unknown>): Logger;
}

/**
 * createLogger 支持的级别白名单。
 *
 * ⚠️ 注意：必须与 config 层的 LogLevel 枚举保持一致——
 * 不在此处的合法级别（如 'trace'）会被静默回退为 info（见 createLogger）。
 */
const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug'] as const;

/**
 * 创建根 logger（进程启动时调用一次，之后经依赖图注入）。
 *
 * @param level 日志级别字符串；非法值回退为 'info' 而非抛错——
 *              日志配置错误不应阻止进程启动（与 loadConfig 的 fail-fast 不同：
 *              配置整体不合法要崩，单个级别字段打错字可以降级）。
 * @returns 符合 Logger 端口的 pino 适配器
 */
export function createLogger(level: string): Logger {
    // 非法 level 时回退到 info，避免启动崩溃
    const safeLevel = (LEVELS as readonly string[]).includes(level) ? level : 'info';

    const root: PinoLogger = pino({
        level: safeLevel,
        // Node 20.6+ 原生 ESM，pino 默认就是 JSON 输出，开发环境可选美化：
        // transport: process.env.NODE_ENV === 'production'
        // 	? undefined
        // 	: { target: 'pino-pretty' },  // 需另装 pino-pretty
    });

    return wrapPino(root);
}

/**
 * 将 pino 实例包装为 Logger 端口实现。
 *
 * 为什么逐方法包一层而不是直接 `return root as Logger`：
 * - pino 的方法有重载（(msg) / (obj, msg) / (obj, msg, ...args)），
 *   包装层收窄为端口约定的一套签名，调用方类型体验一致；
 * - child 递归包装，保证派生出的子 logger 也走端口类型，
 *   不让 PinoLogger 类型泄漏到端口之外。
 */
function wrapPino(p: PinoLogger): Logger {
    return {
        fatal: (obj, msg) => p.fatal(obj, msg),
        error: (obj, msg) => p.error(obj, msg),
        warn: (obj, msg) => p.warn(obj, msg),
        info: (obj, msg) => p.info(obj, msg),
        debug: (obj, msg) => p.debug(obj, msg),
        child: (bindings) => wrapPino(p.child(bindings)),
    };
}
