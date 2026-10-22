/**
 * 长期记忆端口。
 *
 * 设计意图：
 * - 三层拆分：Store（持久化）/ Extractor（从对话抽取候选记忆）/ Manager（策略编排）。
 *   检索方式（关键词/向量）、抽取方式（规则/LLM）都可独立替换；
 * - 所有接口强制 tenantId + userId 双参数：记忆天然属于"租户内某用户"，
 *   跨用户读写越权在类型层面即被拒绝；
 * - 写入保守策略：只有显式信号（"记住…"）、审批完成、用户确认事实才写，
 *   且写入路径内部强制过 memoryWriteGuard（PII/长度/TTL/租户）。
 */
import type { BaseMessage } from '@langchain/core/messages';
import type { TenantContext, TenantId, UserId } from '../domain/types.js';
import type { MemoryHit, MemoryKind, MemoryRecord } from '../domain/types.js';

/** 记忆写入入参：定位（tenant）+ 内容（kind/key/value）+ 置信度与来源追溯 */
export interface MemoryWriteInput {
    /** 租户上下文（写入路径内部会强制校验租户一致性） */
    tenant: TenantContext;

    /** 记忆类型（决定存储分片与检索范围） */
    kind: MemoryKind;

    /** 记忆键，与 (tenantId, userId, kind) 组成唯一约束 */
    key: string;

    /** 记忆内容（结构由 kind 决定，写入前过 memoryWriteGuard） */
    value: unknown;

    /** 置信度 [0,1]；upsert 时高 confidence 覆盖低 confidence */
    confidence: number;

    /** 过期时长（毫秒）；缺省表示跟随该 kind 的默认 TTL */
    ttlMs?: number;

    /** 来源会话线程 id（审计追溯用） */
    sourceThreadId?: string;

    /** 来源请求 id（审计追溯用） */
    sourceRequestId?: string;

    /** 自由标签（后续过滤/展示用） */
    tags?: string[];
}

/** 记忆检索条件：作用域（租户+用户）+ 查询串 + 过滤与排序参数 */
export interface MemoryQuery {
    /** 租户 id（强制作用域） */
    tenantId: TenantId;

    /** 用户 id（强制作用域） */
    userId: UserId;

    /** 检索文本（关键词匹配或向量化，取决于检索实现） */
    query: string;

    /** 限定检索的记忆类型；缺省 = 全部类型 */
    kinds?: MemoryKind[];

    /** 返回的最大条数（top-k） */
    k?: number;

    /** 最低置信度门槛，低于此值的命中被过滤 */
    minConfidence?: number;

    /** 是否包含已过期记忆；缺省 false = 仅返回未过期 */
    includeExpired?: boolean;
}

/**
 * 记忆持久化端口（三层中的 Store 层）。
 * 职责仅限 CRUD 与检索，不含抽取/策略编排逻辑。
 * 检索实现可替换（关键词/向量），事实源始终是本层。
 */
export interface MemoryStorePort {
    /**
     * 唯一键 (tenantId, userId, kind, key) upsert。
     * 高 confidence 覆盖低 confidence；低 confidence 写入不覆盖已有的高 confidence 记录。
     */
    upsert(input: MemoryWriteInput): Promise<MemoryRecord>;

    /** 按查询条件检索命中记忆，按相关度排序返回 */
    search(input: MemoryQuery): Promise<MemoryHit[]>;

    /** 列出记忆（管理/审计视图用，无相关度排序） */
    list(input: {
        /** 租户 id（强制作用域） */
        tenantId: TenantId;

        /** 用户 id（强制作用域） */
        userId: UserId;

        /** 限定记忆类型；缺省 = 全部 */
        kinds?: MemoryKind[];

        /** 是否包含已过期；缺省 false */
        includeExpired?: boolean;

        /** 返回条数上限；缺省由实现方决定 */
        limit?: number;
    }): Promise<MemoryRecord[]>;

    /** 删除单条记忆；返回是否实际删除（id 不存在或越权时返回 false） */
    delete(input: { tenantId: TenantId; userId: UserId; id: string }): Promise<boolean>;

    /** 物理删除全部过期记忆（后台清理用），返回删除条数 */
    deleteExpired(now: string): Promise<number>;
}

/**
 * 记忆抽取端口（三层中的 Extractor 层）。
 * 从对话中识别候选记忆，可替换实现（规则 / LLM）；
 * 只负责"抽取"，不负责校验与写入——调用方负责后续 guard 与写入。
 */
export interface MemoryExtractorPort {
    /** 从对话中抽取候选记忆（调用方负责后续 guard 与写入） */
    extract(input: {
        /** 图/会话当前状态（供抽取器补充上下文，结构由实现方约定） */
        state: unknown;

        /** 待抽取的对话消息序列 */
        messages: BaseMessage[];

        /** 租户上下文 */
        tenant: TenantContext;
    }): Promise<MemoryWriteInput[]>;
}

/**
 * 记忆管理器（三层中的 Manager 层）：对外的统一门面。
 * 编排 Store / Extractor / memoryWriteGuard / 渲染，上层只依赖本接口。
 */
export interface MemoryManager {
    /**
     * 检索记忆（内部委托 Store.search，附加租户/用户作用域）。
     *
     * @param tenant 租户上下文
     * @param query 检索文本
     * @param opts 可选过滤：类型 / top-k / 最低置信度
     */
    retrieve(
        tenant: TenantContext,
        query: string,
        opts?: { kinds?: MemoryKind[]; k?: number; minConfidence?: number },
    ): Promise<MemoryHit[]>;

    /**
     * 写入记忆（内部强制过 memoryWriteGuard：PII/长度/TTL/租户）。
     * 守卫拒绝时抛错，调用方需处理。
     */
    remember(input: MemoryWriteInput): Promise<MemoryRecord>;

    /**
     * 抽取 + 写入的组合流程：extract 产出候选 → 逐条过 guard → upsert。
     *
     * @returns 实际写入成功的记忆列表（被 guard 拒绝的候选不出现在结果中）
     */
    extractAndRemember(input: {
        /** 图/会话当前状态（透传给 Extractor） */
        state: unknown;

        /** 待抽取的对话消息序列 */
        messages: BaseMessage[];

        /** 租户上下文 */
        tenant: TenantContext;
    }): Promise<MemoryRecord[]>;

    /** 删除单条记忆；返回是否实际删除（id 不存在或越权时返回 false） */
    forget(input: { tenant: TenantContext; id: string }): Promise<boolean>;

    /** 列出记忆（记忆管理 API §21.6 用；强制 tenant + user 作用域） */
    list(input: {
        /** 租户上下文（userId 从中取，强制作用域） */
        tenant: TenantContext;

        /** 限定记忆类型；缺省 = 全部 */
        kinds?: MemoryKind[];

        /** 是否包含已过期；缺省 false */
        includeExpired?: boolean;

        /** 返回条数上限 */
        limit?: number;
    }): Promise<MemoryRecord[]>;

    /**
     * 把命中记忆渲染为可注入视图的 SystemMessage（name: "long_term_memory"）。
     * @param hits 检索命中列表（按相关度排序）
     * @param tokenBudget 记忆 token 预算；超出预算的低分记忆被丢弃
     * @returns 渲染后的 SystemMessage；null 表示无有效记忆，不需要注入
     */
    buildMemoryMessage(hits: MemoryHit[], tokenBudget: number): BaseMessage | null;
}

/**
 * 记忆向量检索器（可选替换 KeywordMemoryRetriever，LanceDB 实现）。
 *
 * 设计意图：检索与存储解耦——store（SQLite）仍是事实源，
 * 向量索引是"可重建的派生物"：indexRecord 在写入后异步同步，
 * 检索只读向量库；索引损坏可随时由 store 全量重建。
 */
export interface MemoryVectorRetriever {
    /** 向量语义检索；入参/出参与 Store.search 同构，便于互换 */
    search(input: MemoryQuery): Promise<MemoryHit[]>;

    /** 写入/更新后同步向量索引（实现方应容忍重复调用，幂等） */
    indexRecord(record: MemoryRecord): Promise<void>;

    /**
     * 从 store 全量重建索引（可选能力）。
     * 首次启用 lancedb 或索引损坏时调用；返回重建的记录条数。
     * 未声明该方法 = 实现不支持重建（如纯外挂索引服务）。
     */
    rebuild?(): Promise<number>;
}
