import { z } from 'zod';
import type { McpServerConfig } from '../mcp/types.js';
import type { AgentMode, MemoryKind } from '../domain/types.js';

// ---------------------------------------------------------------
// 常量与枚举
// ---------------------------------------------------------------

/** LLM 提供方。'fake' 为无外部依赖的假实现，用于测试与离线开发。 */
export type LlmProvider = 'openai' | 'fake';

/** 日志级别，从 fatal（最严重，只记录）到 trace（最详细）。 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

// ---------------------------------------------------------------
// 子配置
// ---------------------------------------------------------------

/**
 * 上下文窗口策略：控制进入 LLM 的历史消息如何裁剪与压缩。
 *
 * 裁剪顺序（由 context 管理器执行）：
 *   1. 保留 system 消息（若 keepSystemMessages）
 *   2. 保留最近 keepRecentMessages 条不参与压缩
 *   3. 超出 maxHistoryMessages / maxHistoryTokens 的更早消息，
 *      按 compactionStrategy 处理（丢弃或摘要）
 */
export interface ContextPolicyConfig {
    /** 是否在裁剪时始终保留 system prompt 消息。 */
    keepSystemMessages: boolean;

    /** 历史消息条数硬上限，超出即触发压缩。 */
    maxHistoryMessages: number;

    /** 历史消息 token 总量软上限，与条数上限任一命中即触发压缩。 */
    maxHistoryTokens: number;

    /** 压缩方式：'drop' 直接丢弃旧消息；'summarize' 用 LLM 生成摘要替换。 */
    compactionStrategy: 'drop' | 'summarize';

    /** 压缩时豁免的最近消息条数，保证近邻上下文原样保留。 */
    keepRecentMessages: number;
}

/**
 * 长期记忆策略：什么能写入记忆库、每类记忆活多久、检索时给多少。
 *
 * 写入侧：extractor 决定抽取方式（规则便宜但粗、llm 准但耗 token），
 *         minConfidenceToWrite 是写入门槛，防止噪声污染记忆库。
 * 读取侧：maxMemoriesPerContext + maxMemoryTokens 双上限，防止记忆挤占对话上下文。
 */
export interface MemoryPolicyConfig {
    /** 总开关：关闭后不读不写记忆库（记忆相关工具仍可注册但返回空）。 */
    enabled: boolean;

    /** 单次注入对话的记忆 token 总量上限。 */
    maxMemoryTokens: number;

    /** 单次注入对话的记忆条数上限。 */
    maxMemoriesPerContext: number;

    /** 写入最低置信度（0~1）。低于此值的抽取结果直接丢弃。 */
    minConfidenceToWrite: number;

    /** 偏好类记忆 TTL（如"用户偏好顺丰"）。默认 180 天。 */
    preferenceTtlMs: number;

    /** 事实类记忆 TTL（如"用户收货地址在上海"）。默认 90 天——事实会过期。 */
    factTtlMs: number;

    /** 事件类记忆 TTL（如"上周退过一单"）。默认 365 天。 */
    episodicTtlMs: number;

    /** 流程类记忆 TTL（如"该用户退货习惯走上门取件"）。默认 180 天。 */
    proceduralTtlMs: number;

    /** 记忆抽取器：'rule' 规则匹配（零成本）；'llm' 模型抽取（更准、有成本）。 */
    extractor: 'rule' | 'llm';

    /** 允许写入的记忆类别白名单，未列出的类别即使抽取到也不落库。 */
    allowKinds: MemoryKind[];
}

/**
 * 工具执行策略：超时、重试、熔断、去重。
 *
 * 读操作与写操作重试分开控制（writeMaxAttempts）：
 * 写操作有副作用（创建退货单等），盲目重试可能重复下单，
 * 默认不重试，幂等键方案落地后可显式放开。
 */
export interface ToolExecutionConfig {
    /** 单次工具调用超时（毫秒）。 */
    defaultTimeoutMs: number;

    /** 读操作最大尝试次数（含首次）。 */
    maxAttempts: number;

    /** 写操作最大尝试次数。默认 1 = 不重试。 */
    writeMaxAttempts: number;

    /** 指数退避初始延迟（毫秒）。 */
    baseDelayMs: number;

    /** 指数退避延迟上限（毫秒）。 */
    maxDelayMs: number;

    /** 退避是否加随机抖动（防止失败后集中重试形成惊群）。 */
    jitter: boolean;

    /** 熔断器：连续失败达到阈值后快速失败一段时间，给下游喘息窗口。 */
    circuitBreaker: {
        /** 熔断开关。 */
        enabled: boolean;

        /** 连续失败多少次触发熔断。 */
        failureThreshold: number;

        /** 熔断打开持续时间（毫秒），期间直接快速失败。 */
        openMs: number;

        /** 半开状态允许的探测请求数，探测成功则恢复、失败则重回打开。 */
        halfOpenMax: number;
    };
    /** 去重：相同入参在 TTL 内复用结果，singleFlight 合并并发同参请求。 */
    dedupe: {
        /** 去重开关。 */
        enabled: boolean;

        /** 去重结果缓存时长（毫秒），过期后重新真实调用。 */
        cacheTtlMs: number;

        /** 并发的相同请求是否合并为一次底层调用（single-flight 模式）。 */
        singleFlight: boolean;
    };
}

/**
 * Agent 执行模式及其各自的运行约束。
 * mode 决定主路由走 workflow / react / plan_solve / hybrid。
 */
export interface AgentConfig {
    /** 当前执行模式（影响图的拓扑分支选择）。 */
    mode: AgentMode; // ← 引用定义

    /** ReAct 模式约束：循环次数、防卡死、工具白名单。 */
    react: {
        /** 思考-行动循环最大轮数，防止无限循环。 */
        maxIterations: number;

        /** 同一工具相同参数的连续调用上限（模型复读卡死的主要形态）。 */
        maxSameToolCalls: number;

        /** ReAct 模式可用工具白名单，白名单外的工具不注册给模型。 */
        allowedTools: string[];

        /** 达到轮数上限时：true = 强制生成总结回答；false = 直接失败。 */
        finalizeOnLimit: boolean;
    };

    /** Plan-and-Solve 模式约束：计划步数、重规划次数、工具调用预算。 */
    planSolve: {
        /** 初始计划的最大步骤数。 */
        maxSteps: number;

        /** 执行中发现计划失效时允许的重规划次数。 */
        maxReplans: number;

        /** 单次执行的工具调用总预算。 */
        maxToolIterations: number;

        /** Plan-Solve 模式可用工具白名单。 */
        allowedTools: string[];
    };
}

/**
 * MCP（Model Context Protocol）外部工具接入配置。
 *
 * 安全模型：默认拒绝（defaultPolicy: 'deny'），只有命中允许前缀的
 * MCP 工具才会注册给模型——外部工具面不可信，白名单收敛爆炸半径。
 */
export interface McpConfig {
    /** 总开关：关闭时不连接任何 MCP server。 */
    enabled: boolean;

    /** 未命中白名单的 MCP 工具的默认策略：'deny' 不注册；'sandbox' 注册但标记受限。 */
    defaultPolicy: 'deny' | 'sandbox';

    /** 单次 MCP 工具调用超时（毫秒）。 */
    requestTimeoutMs: number;

    /** 要连接的 MCP server 列表。 */
    servers: McpServerConfig[]; // ← 引用 mcp/types.ts
}

// ---------------------------------------------------------------
// 顶层配置
// ---------------------------------------------------------------

/**
 * 应用总配置（值对象）。
 *
 * 生命周期：进程入口 loadConfig() 构造一次，此后以依赖注入方式
 * 在整个依赖图中流转；节点/工具禁止直接读 process.env，
 * 保证"换配置 = 换注入对象"，测试可任意构造 AppConfig 而无需环境变量。
 */
export interface AppConfig {
    /** LLM 提供方（'fake' 时 model/llmBaseUrl 不生效）。 */
    llmProvider: LlmProvider;

    /** 模型名，如 'gpt-4o-mini'。 */
    model: string;
    /**
     * OpenAI 兼容端点（自定义代理 / vLLM / Ollama / OneAPI 等的 base URL）。
     * 缺省（undefined）→ 使用 OpenAI 官方 API；仅 llmProvider=openai 时生效。
     */
    llmBaseUrl?: string;

    /** 业务数据库（SQLite）文件路径。 */
    dbPath: string;

    /** LangGraph checkpoint 持久化路径（中断恢复依赖此文件）。 */
    checkpointPath: string;

    /** 日志级别。 */
    logLevel: LogLevel;

    /** HTTP 服务配置。 */
    server: {
        /** 监听端口。 */
        port: number;

        /** 单个 HTTP 请求的总超时（毫秒），应 ≥ budget.maxWallClockMs。 */
        requestTimeoutMs: number;
    };

    /**
     * 执行预算：三线约束（步数 / 工具调用 / token）+ 墙钟时间，
     * 任一线耗尽即触发降级。防止模型循环烧钱、用户超时等待。
     */
    budget: {
        /** 图执行最大超步数。 */
        maxSteps: number;

        /** 单次会话最大工具调用次数。 */
        maxToolCalls: number;

        /** 单次会话最大 token 消耗（含所有 LLM 调用累计）。 */
        maxTokens: number;

        /** 墙钟时间上限（毫秒）。默认 55s，为 HTTP 超时 60s 留出收尾余量。 */
        maxWallClockMs: number;
    };

    /** 澄清追问策略：意图不明确时最多追问几轮，超过则转 unknown 分支。 */
    clarify: { maxRounds: number };

    /** 限流：防止滥用与下游过载的双维度限速。 */
    rateLimit: {
        /** 全局工具调用速率（次/分钟）。 */
        toolCallsPerMinute: number;

        /** 单用户聊天请求速率（次/分钟）。 */
        chatsPerMinutePerUser: number;
    };

    /** 上下文窗口裁剪策略。 */
    context: ContextPolicyConfig;

    /** 长期记忆策略。 */
    memory: MemoryPolicyConfig;

    /** 工具执行策略（超时/重试/熔断/去重）。 */
    tool: ToolExecutionConfig;

    /** Agent 模式与运行约束。 */
    agent: AgentConfig;

    /** MCP 外部工具接入。 */
    mcp: McpConfig;

    /** 检索实现选择（政策检索与长期记忆检索共用）。 */
    retriever: RetrieverConfig;
}

/**
 * 检索配置（政策检索与长期记忆检索共用同一选择）。
 * lancedb 模式使用本地嵌入模型（models/Xenova/bge-small-zh-v1.5，384 维），
 * 离线可用、不消耗 API 额度。
 */
export interface RetrieverConfig {
    /** keyword：SQLite 关键词（零依赖默认）；lancedb：本地向量检索 */
    kind: 'keyword' | 'lancedb';

    /** LanceDB 数据目录 */
    lancedbUri: string;

    /** 本地模型目录根（含 Xenova/bge-small-zh-v1.5） */
    modelsPath: string;

    /** 嵌入模型名（相对 modelsPath） */
    embedModel: string;
}

// ---------------------------------------------------------------
// 加载与校验
// ---------------------------------------------------------------

/**
 * 环境变量 zod schema：只做"入口收口"校验与类型转换（字符串 → number/boolean），
 * 全部字段可选，缺省值在 defaults 里集中给出——保证 loadConfig({}) 永远返回合法 AppConfig，
 * 测试与本地开发无需准备任何环境变量。
 */

/**
 * 布尔环境变量解析。
 *
 * z.coerce.boolean 会把任意非空字符串（包括 'false'）当 true，
 * 因此这里显式白名单：仅 'false' / '0' / 'no' → false，其余非空 → true。
 */
const booleanEnv = z.preprocess(
    (v) => (v === undefined ? undefined : !(v === 'false' || v === '0' || v === 'no')),
    z.boolean().optional()
);

/**
 * 环境变量 zod schema：只做"入口收口"校验与类型转换（字符串 → number/boolean）。
 *
 * 全部字段可选，缺省值在 defaults() 里集中给出——保证 loadConfig({})
 * 永远返回合法 AppConfig，测试与本地开发无需准备任何环境变量。
 *
 * 环境变量 → 配置字段的映射约定：
 *   MAX_STEPS / MAX_TOOL_CALLS / MAX_TOKENS / MAX_WALL_CLOCK_MS → budget
 *   AGENT_MODE → agent.mode；RETRIEVER 系列 → retriever
 */
const envSchema = z.object({
    /** LLM 提供方，见 {@link LlmProvider}。 */
    LLM_PROVIDER: z.enum(['openai', 'fake']).optional(),

    /** 模型名，如 gpt-4o-mini。 */
    LLM_MODEL: z.string().optional(),

    /** OpenAI API Key（敏感信息，仅存于 .env，不入库）。 */
    LLM_API_KEY: z.string().optional(),

    /** OpenAI 兼容端点 base URL（代理 / vLLM / Ollama 等）。 */
    LLM_BASE_URL: z.string().optional(),

    /** SQLite 数据库路径。 */
    DB_PATH: z.string().optional(),

    /** checkpoint 持久化路径。 */
    CHECKPOINT_PATH: z.string().optional(),

    /** 日志级别。 */
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),

    /** HTTP 监听端口（正整数）。 */
    PORT: z.coerce.number().int().positive().optional(),

    /** HTTP 请求总超时（毫秒，正整数）。 */
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

    /** 执行预算：最大超步数。 */
    MAX_STEPS: z.coerce.number().int().positive().optional(),

    /** 执行预算：最大工具调用次数（非负整数）。 */
    MAX_TOOL_CALLS: z.coerce.number().int().nonnegative().optional(),

    /** 执行预算：最大 token 消耗。 */
    MAX_TOKENS: z.coerce.number().int().positive().optional(),

    /** 执行预算：墙钟时间上限（毫秒）。 */
    MAX_WALL_CLOCK_MS: z.coerce.number().int().positive().optional(),

    /** 澄清最多追问轮数。 */
    MAX_CLARIFY_ROUNDS: z.coerce.number().int().nonnegative().optional(),

    /** Agent 执行模式。 */
    AGENT_MODE: z.enum(['workflow', 'react', 'plan_solve', 'hybrid']).optional(),

    /** 长期记忆开关（布尔型环境变量，支持 'false'/'0'/'no'）。 */
    MEMORY_ENABLED: booleanEnv,

    /** MCP 外部工具开关。 */
    MCP_ENABLED: booleanEnv,

    /** 检索实现：keyword=SQLite 关键词（默认）；lancedb=本地向量检索（bge-small-zh） */
    RETRIEVER: z.enum(['keyword', 'lancedb']).optional(),

    /** LanceDB 数据目录。 */
    LANCEDB_URI: z.string().optional(),

    /** 本地嵌入模型：models 目录根 + 相对模型名（models/Xenova/bge-small-zh-v1.5） */
    MODELS_PATH: z.string().optional(),

    /** 本地嵌入模型：相对模型名 */
    EMBED_MODEL: z.string().optional(),
});

/**
 * loadConfig 的默认配置（与 .env.example 对齐），集中一处便于对照修改。
 *
 * 默认值取向：
 *   - llmProvider: 'fake'  → 克隆即跑，零外部依赖；
 *   - tool.writeMaxAttempts: 1 → 写操作默认不重试（副作用风险），
 *     幂等键方案落地后可显式放开；
 *   - mcp.defaultPolicy: 'deny' → 未命中 allowPrefixes 的 MCP 工具
 *     一律不注册（默认拒绝）；
 *   - budget.maxWallClockMs: 55s → 为 HTTP 超时 60s 留收尾余量。
 */
function defaults(): AppConfig {
    const base: AppConfig = {
        llmProvider: 'fake',
        model: 'gpt-4o-mini',
        dbPath: './data/shoppilot.db',
        checkpointPath: './data/checkpoints.db',
        logLevel: 'info',
        server: { port: 3000, requestTimeoutMs: 60_000 },
        budget: { maxSteps: 24, maxToolCalls: 12, maxTokens: 120_000, maxWallClockMs: 55_000 },
        clarify: { maxRounds: 3 },
        rateLimit: { toolCallsPerMinute: 30, chatsPerMinutePerUser: 10 },
        context: {
            keepSystemMessages: true,
            maxHistoryMessages: 24,
            maxHistoryTokens: 6_000,
            compactionStrategy: 'summarize',
            keepRecentMessages: 6,
        },
        memory: {
            enabled: true,
            maxMemoryTokens: 1_000,
            maxMemoriesPerContext: 8,
            minConfidenceToWrite: 0.6,
            // TTL：偏好 180d / 事实 90d / 事件 365d / 流程 180d
            preferenceTtlMs: 180 * 24 * 3600_000,
            factTtlMs: 90 * 24 * 3600_000,
            episodicTtlMs: 365 * 24 * 3600_000,
            proceduralTtlMs: 180 * 24 * 3600_000,
            extractor: 'rule',
            allowKinds: ['preference', 'fact', 'episodic', 'procedural'],
        },
        tool: {
            defaultTimeoutMs: 15_000,
            maxAttempts: 3,
            writeMaxAttempts: 1, // 写操作默认不重试（副作用风险），幂等键重试需显式放开
            baseDelayMs: 200,
            maxDelayMs: 2_000,
            jitter: true,
            circuitBreaker: { enabled: true, failureThreshold: 5, openMs: 30_000, halfOpenMax: 1 },
            dedupe: { enabled: true, cacheTtlMs: 60_000, singleFlight: true },
        },
        agent: {
            mode: 'workflow',
            react: {
                maxIterations: 6,
                maxSameToolCalls: 2,
                allowedTools: [
                    'searchProducts',
                    'getOrder',
                    'getLogistics',
                    'checkReturnEligibility',
                ],
                finalizeOnLimit: true,
            },
            planSolve: {
                maxSteps: 6,
                maxReplans: 1,
                maxToolIterations: 12,
                allowedTools: [
                    'searchProducts',
                    'getOrder',
                    'getLogistics',
                    'checkReturnEligibility',
                ],
            },
        },
        mcp: {
            enabled: false,
            defaultPolicy: 'deny', // 未命中 allowPrefixes 的 MCP 工具一律不注册（默认拒绝）
            requestTimeoutMs: 30_000,
            servers: [],
        },
        retriever: {
            kind: 'keyword',
            lancedbUri: './data/lancedb',
            modelsPath: './models',
            embedModel: 'Xenova/bge-small-zh-v1.5', // 本地中文嵌入模型（384 维）
        },
    };
    return base;
}

/**
 * 加载并校验配置（进程生命周期内只在入口调用一次）。
 *
 * 设计意图：配置只在进程入口 load 一次（index.ts），此后以 AppConfig
 * 值对象在依赖图中流转；节点/工具禁止读 process.env，保证
 * "换配置 = 换注入对象"，测试可任意构造 AppConfig。
 *
 * 失败语义：环境变量不合法直接抛错——配置错误属于部署期错误，
 * 宁可启动失败也不带病运行（fail-fast）。
 *
 * @param env 环境变量来源（默认 process.env；测试可传入固定对象实现确定性）
 * @returns 完整的 AppConfig，env 未提供的字段取 defaults() 中的缺省值
 * @throws 当环境变量校验失败时抛出包含 zod 错误详情的 Error
 *
 * @example
 * // 生产：从 process.env 加载
 * const cfg = loadConfig();
 *
 * // 测试：注入固定环境变量，无需 mock process.env
 * const cfg = loadConfig({ LLM_PROVIDER: 'fake', PORT: '0' });
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const parsed = envSchema.safeParse(env);
    // 环境变量不合法直接抛错：配置错误属于部署期错误，宁可启动失败也不带病运行
    if (!parsed.success) {
        throw new Error(`Invalid environment config: ${parsed.error.message}`);
    }
    const e = parsed.data;
    const cfg = defaults();

    if (e.LLM_PROVIDER) cfg.llmProvider = e.LLM_PROVIDER;
    if (e.LLM_MODEL) cfg.model = e.LLM_MODEL;
    if (e.LLM_BASE_URL) cfg.llmBaseUrl = e.LLM_BASE_URL;
    if (e.DB_PATH) cfg.dbPath = e.DB_PATH;
    if (e.CHECKPOINT_PATH) cfg.checkpointPath = e.CHECKPOINT_PATH;
    if (e.LOG_LEVEL) cfg.logLevel = e.LOG_LEVEL;
    if (e.PORT) cfg.server.port = e.PORT;
    if (e.REQUEST_TIMEOUT_MS) cfg.server.requestTimeoutMs = e.REQUEST_TIMEOUT_MS;
    if (e.MAX_STEPS) cfg.budget.maxSteps = e.MAX_STEPS;
    if (e.MAX_TOOL_CALLS) cfg.budget.maxToolCalls = e.MAX_TOOL_CALLS;
    if (e.MAX_TOKENS) cfg.budget.maxTokens = e.MAX_TOKENS;
    if (e.MAX_WALL_CLOCK_MS) cfg.budget.maxWallClockMs = e.MAX_WALL_CLOCK_MS;
    if (e.MAX_CLARIFY_ROUNDS) cfg.clarify.maxRounds = e.MAX_CLARIFY_ROUNDS;
    if (e.AGENT_MODE) cfg.agent.mode = e.AGENT_MODE;
    if (e.MEMORY_ENABLED !== undefined) cfg.memory.enabled = e.MEMORY_ENABLED;
    if (e.MCP_ENABLED !== undefined) cfg.mcp.enabled = e.MCP_ENABLED;
    if (e.RETRIEVER) cfg.retriever.kind = e.RETRIEVER;
    if (e.LANCEDB_URI) cfg.retriever.lancedbUri = e.LANCEDB_URI;
    if (e.MODELS_PATH) cfg.retriever.modelsPath = e.MODELS_PATH;
    if (e.EMBED_MODEL) cfg.retriever.embedModel = e.EMBED_MODEL;

    return cfg;
}
