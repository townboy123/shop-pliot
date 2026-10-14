/**
 * 领域模型。
 *
 * 设计意图：
 * - 领域层是整个项目的"契约核心"，被 ports / adapters / services / graph 共同引用，
 *   因此只放纯类型与纯数据结构，禁止引入任何运行时依赖（不 import LangChain / DB / Node 模块）。
 * - ApprovalPayload 使用 discriminated union（以 kind 字段区分），
 *   让退货审批与未来的 MCP 工具审批能复用同一个 humanApproval 节点与 /api/approve 协议，
 *   扩展新审批类型时不改图拓扑（switch(kind) 即可收窄类型）。
 */

// ---------------------------------------------------------------
// 基础标识
// ---------------------------------------------------------------

/** 租户标识。数据隔离的第一级边界：所有持久化记录都携带此字段。 */
export type TenantId = string;

/** 最终用户标识，租户内唯一。长期记忆与限流按 (tenantId, userId) 维度组织。 */
export type UserId = string;

/** 会话线程标识，对应 LangGraph 的 thread_id / checkpoint 命名空间。 */
export type ThreadId = string;

/**
 * 多租户上下文：所有 Service / Repository / Tool 的第一参数。
 *
 * 设计意图（多租户第一参数原则）：
 * - 租户身份必须显式传递，禁止从全局变量 / AsyncLocalStorage 等隐式来源读取，
 *   保证任何一层都能从函数签名上看出"这次调用属于谁"，横向越权在类型层面就无处藏身。
 */
/**
 * 多租户上下文：所有 Service / Repository / Tool 的第一参数。
 *
 * 设计意图（多租户第一参数原则）：
 * - 租户身份必须显式传递，禁止从全局变量 / AsyncLocalStorage 等隐式来源读取，
 *   保证任何一层都能从函数签名上看出"这次调用属于谁"，横向越权在类型层面就无处藏身。
 * - 与 LangGraph config 的关系：由入口从 configurable 解出后构造，
 *   领域层不知道 config 的存在（依赖方向：adapter → domain，单向）。
 */
export interface TenantContext {
    /** 租户 ID。 */
    tenantId: TenantId;

    /** 当前用户 ID（租户内）。 */
    userId: UserId;

    /** 本次请求 ID（观测用：串联一条请求在日志/trace 中的所有记录）。 */
    requestId: string;
}

// ---------------------------------------------------------------
// 意图与 Agent 范式
// ---------------------------------------------------------------

/**
 * Agent 运行范式：
 * - workflow：主线节点式工作流（默认，稳定可控）
 * - react：Thought → Action → Observation 循环（开放工具探索）
 * - plan_solve：Planner → Executor → Synthesizer（多步规划执行）
 * - hybrid：按任务复杂度在 workflow 与高级范式间切换
 */
export type Intent = 'product' | 'order' | 'after_sales' | 'policy' | 'unknown';

/**
 * Agent 运行范式：
 * - workflow：主线节点式工作流（默认，稳定可控）
 * - react：Thought → Action → Observation 循环（开放工具探索）
 * - plan_solve：Planner → Executor → Synthesizer（多步规划执行）
 * - hybrid：按任务复杂度在 workflow 与高级范式间切换
 */
export type AgentMode = 'workflow' | 'react' | 'plan_solve' | 'hybrid';

// ---------------------------------------------------------------
// 商品
// ---------------------------------------------------------------

/** 商品搜索查询（extractProductQuery 节点的结构化输出，字段由 LLM 按 schema 产出）。 */
export interface ProductQuery {
    /** 自由文本搜索词（用户原话或改写后的关键词）。 */
    query: string;

    /** 商品类目过滤，如"耳机"。 */
    category?: string;

    /** 价格区间下限（元），用户明确表达"XX 以内/以上"时才有值。 */
    minPrice?: number;

    /** 价格区间上限（元）。 */
    maxPrice?: number;
}

/** 商品（searchProducts 工具的返回单元）。 */
export interface Product {
    /** 商品 ID，租户内唯一。 */
    id: string;

    /** 归属租户（多租户第一参数原则在数据层的体现）。 */
    tenantId: TenantId;

    /** 商品名。 */
    name: string;

    /** 商品类目。 */
    category: string;

    /** 单价（元）。 */
    price: number;

    /** 商品标签（检索辅助字段）。 */
    tags: string[];

    /** 库存数量。 */
    stock: number;
}

// ---------------------------------------------------------------
// 订单与物流
// ---------------------------------------------------------------

/** 订单行项目：一个 SKU 的购买明细。 */
export interface OrderItem {
    /** SKU 编码（退货按 SKU 粒度对账）。 */
    sku: string;

    /** 关联商品 ID。 */
    productId: string;

    /** 购买数量。 */
    qty: number;
}

/** 订单状态机：paid → shipped → delivered → closed（closed 为终态）。 */
export type OrderStatus = 'paid' | 'shipped' | 'delivered' | 'closed';

/** 订单（getOrder 工具的返回单元，退货资格判定的核心数据源）。 */
export interface Order {
    /** 订单 ID，租户内唯一。 */
    id: string;

    /** 归属租户。 */
    tenantId: TenantId;

    /** 下单用户（所有权校验依据：A 用户不可查/退 B 用户的订单）。 */
    userId: UserId;

    /** 当前状态。 */
    status: OrderStatus;

    /** 行项目列表。 */
    items: OrderItem[];

    /** 签收时间（ISO 字符串），退货窗口从此起算；null 表示未签收。 */
    deliveredAt: string | null;

    /** 下单时间（ISO 字符串）。 */
    createdAt: string;
}

/** 物流信息（getLogistics 工具的返回单元）。 */
export interface LogisticsInfo {
    /** 关联订单 ID。 */
    orderId: string;

    /** 订单当前状态（物流与订单状态快照保持一致）。 */
    status: OrderStatus;

    /** 承运商名称，未发货时缺省。 */
    carrier?: string;

    /** 运单号，未发货时缺省。 */
    trackingNo?: string;

    /** 最近一次物流状态更新时间（ISO 字符串）。 */
    lastUpdate: string;
}

// ---------------------------------------------------------------
// 退货
// ---------------------------------------------------------------

/** 退货意图的结构化抽取结果（after_sales 分支从用户话语中抽取）。 */
export interface ReturnContext {
    /** 目标订单 ID。 */
    orderId: string;

    /** 要退的 SKU（一单多品时定位到具体行）。 */
    sku: string;

    /** 退货原因（自由文本，进审批单供人工判断）。 */
    reason: string;
}

/** 退货单状态机：pending → approved / rejected（approved 后走线下流程）。 */
export type ReturnStatus = 'pending' | 'approved' | 'rejected';

/** 退货单（createReturnRequest 工具的落库与返回单元）。 */
export interface ReturnRequest {
    /** 退货单 ID。 */
    id: string;

    /** 归属租户。 */
    tenantId: TenantId;

    /** 关联订单 ID。 */
    orderId: string;

    /** 退货 SKU。 */
    sku: string;

    /** 退货原因。 */
    reason: string;

    /** 当前状态。 */
    status: ReturnStatus;

    /** 会话级幂等键（tenant:userId:threadId），重复提交返回既有记录。 */
    idempotencyKey: string;

    /** 创建时间（ISO 字符串）。 */
    createdAt: string;
}

/**
 * 退货资格判定结果。
 *
 * 设计意图：reason 使用封闭枚举而非自由文本，
 * 让节点层能把每种失败原因映射为确定的澄清/降级策略（可测试、可断言）。
 */
export interface EligibilityResult {
    /** 是否具备退货资格。 */
    eligible: boolean;
    /**
     * 判定原因（封闭枚举，与降级策略一一对应）：
     * - ok：资格通过
     * - order_not_found：订单不存在 → 引导核对单号
     * - not_delivered：未签收 → 解释窗口未起算
     * - no_delivery_date：缺签收时间（数据缺失）→ 转人工核实
     * - out_of_window：超退货窗口 → 解释政策
     * - sku_not_in_order：SKU 不在该订单 → 澄清商品
     * - missing_info：必填信息缺失 → 触发 clarify 流程
     */
    reason:
        | 'ok'
        | 'order_not_found'
        | 'not_delivered'
        | 'no_delivery_date'
        | 'out_of_window'
        | 'sku_not_in_order'
        | 'missing_info';

    /** 判定涉及的订单 ID（order_not_found 时缺省）。 */
    orderId?: string;

    /** 判定涉及的 SKU。 */
    sku?: string;
}

// ---------------------------------------------------------------
// 人工审批（HITL）
// ---------------------------------------------------------------

/**
 * 审批人对一次 interrupt 的处理结果（/api/approve 的请求体，经 Command resume 注入图）。
 */
export interface ApprovalDecision {
    /** 是否批准。false = 拒绝，消费方走拒绝分支（告知用户并结束流程）。 */
    approved: boolean;

    /** 审批人标识（审计用：谁做的决定）。 */
    operator: string;

    /** 审批备注（审计用，可选）。 */
    note?: string;
}

/** 创建退货单审批 payload。interrupt 挂起时的待审批动作内容。 */
export interface CreateReturnApprovalPayload {
    /** 判别字段：固定值，消费方据此收窄类型。 */
    kind: 'create_return_request';

    /** 归属租户（审批单本身也多租户隔离）。 */
    tenantId: TenantId;

    /** 发起用户。 */
    userId: UserId;

    /** 要退货的订单 ID。 */
    orderId: string;

    /** 要退货的 SKU。 */
    sku: string;

    /** 退货原因（人工判断的主要依据）。 */
    reason: string;
}

/**
 * MCP 工具调用审批 payload（写操作工具需要人工放行时使用）。
 *
 * 背景：MCP 工具是外部不可信面，写操作（副作用）在白名单之外
 * 默认需人工审批后才真正执行。
 */
export interface McpToolApprovalPayload {
    /** 判别字段：固定值。 */
    kind: 'mcp_tool_call';

    /** 来源 MCP server 标识。 */
    serverId: string;

    /** 工具在 server 内的原始名称。 */
    toolName: string;

    /** 全局唯一名：`mcp:<serverId>:<toolName>`（注册表与审计日志使用）。 */
    qualifiedName: string;

    /** 工具调用参数（审批人核对的执行内容）。 */
    args: Record<string, unknown>;

    /** 归属租户。 */
    tenantId: TenantId;

    /** 发起用户。 */
    userId: UserId;
}

/**
 * 审批 Payload discriminated union。
 *
 * 设计意图：humanApproval 节点只做 interrupt(state.pendingAction)，
 * 不关心 payload 具体内容；消费方（createReturnRequest 等）按 kind 收窄类型。
 * 新增审批种类 = 新增一个 union 成员，图拓扑与审批协议零改动。
 */
export type ApprovalPayload = CreateReturnApprovalPayload | McpToolApprovalPayload;

// ---------------------------------------------------------------
// 长期记忆
// ---------------------------------------------------------------

/**
 * 记忆类别（TTL 与 allowKinds 白名单按此分类，与 MemoryPolicyConfig 对应）：
 * - preference：用户偏好（"喜欢顺丰"），180 天
 * - fact：用户事实（"地址在上海"），90 天——事实会过期，TTL 最短
 * - episodic：交互事件（"上周退过一单"），365 天
 * - procedural：流程习惯（"退货习惯上门取件"），180 天
 */
export type MemoryKind = 'preference' | 'fact' | 'episodic' | 'procedural';

/** 记忆库中的一条持久记录。 */
export interface MemoryRecord {
    /** 记录 ID。 */
    id: string;

    /** 归属租户（记忆隔离的第一级）。 */
    tenantId: TenantId;

    /** 归属用户（记忆隔离的第二级，绝不跨用户召回）。 */
    userId: UserId;

    /** 记忆类别。 */
    kind: MemoryKind;

    /** 记忆键（如 "耳机预算"），与 (tenantId, userId, kind) 构成唯一键。 */
    key: string;

    /** 记忆值（结构随 kind 变化，故为 unknown；读取方按 kind 收窄）。 */
    value: unknown;

    /** 抽取置信度（0~1），低于 minConfidenceToWrite 的不会入库。 */
    confidence: number;

    /** 来源会话（溯源：这条记忆从哪次对话来的）。 */
    sourceThreadId?: ThreadId;

    /** 来源请求（更细粒度的溯源）。 */
    sourceRequestId?: string;

    /** 创建时间（ISO 字符串）。 */
    createdAt: string;

    /** 最近更新时间（同 key 覆盖写时刷新）。 */
    updatedAt: string;

    /** 过期时间；null 表示永不过期（TTL 策略由 MemoryPolicyConfig 派生）。 */
    expiresAt: string | null;

    /** 附加标签（检索过滤辅助）。 */
    tags: string[];
}

/** 一次记忆检索的命中结果。 */
export interface MemoryHit {
    /** 命中的记忆记录。 */
    record: MemoryRecord;

    /** 相关性得分（不同 reason 下量纲不同，仅供同 reason 内排序）。 */
    score: number;

    /** 命中方式（观测用）：精确 key / 关键词 / 向量 / 最近写入。 */
    reason: 'exact_key' | 'keyword' | 'vector' | 'recent';
}

// ---------------------------------------------------------------
// ReAct / Plan-and-Solve
// ---------------------------------------------------------------

/**
 * 计划中的一个步骤（plan_solve 范式的最小执行单元）。
 */
export interface PlanStep {
    /** 步骤 ID（plan 内唯一，被 dependsOn 引用）。 */
    id: string;

    /** 步骤的自然语言描述（重建 prompt 给 Executor 时使用）。 */
    description: string;

    /** 步骤要执行的工具；纯推理步骤可为空。 */
    tool?: { name: string; args: Record<string, unknown> };

    /** 依赖的前置步骤 id（executor 据此做拓扑序执行）。 */
    dependsOn?: string[];

    /** 步骤状态机：pending → running → done / failed / skipped。 */
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
}

/** 一份执行计划（plan_solve 的 plan 节点产出，Executor 逐步消费）。 */
export interface Plan {
    /** 计划要达成的目标（用户意图的改写）。 */
    goal: string;

    /** 有序（含依赖关系）的步骤列表。 */
    steps: PlanStep[];

    /** 计划创建时间（ISO 字符串）。 */
    createdAt: string;

    /** 已重规划次数（超过 maxReplans 则带部分结果降级）。 */
    replanCount: number;
}

/**
 * 一次工具执行的观测结果（ReAct / plan_solve 共用）。
 *
 * 设计意图：summary 与 value 分离——summary 是给 LLM 看的
 * （已截断/脱敏，控制上下文体积），value 是给代码用的（完整数据），
 * 两者可见性不同，混用会导致 prompt 膨胀或敏感信息泄漏给模型。
 */
export interface Observation {
    /** 关联的计划步骤（plan_solve 场景下有值）。 */
    stepId?: string;

    /** 执行的工具名。 */
    toolName?: string;

    /** 本次调用的指纹（去重账本使用：同指纹命中缓存/合并）。 */
    fingerprint?: string;

    /** 是否执行成功。 */
    ok: boolean;

    /** 给 LLM 看的结果摘要（已截断/脱敏）。 */
    summary: string;

    /** 完整返回值（仅供代码消费，不进 prompt）。 */
    value?: unknown;

    /** 完成时间戳（毫秒，超时与预算核算用）。 */
    at: number;
}

/**
 * ReAct 循环的单轮记录（草稿板，供 prompt 重建与测试断言）。
 *
 * 字段均可选：thought 先于 action 产生，observation 在工具返回后补，
 * finalAnswer 仅在最后一轮存在——这正是 scratchpad 用可选字段
 * 而非多个联合类型的理由：按轮次追加写入是流式的。
 */
export interface AgentScratchpadEntry {
    /** 循环轮次（从 1 开始）。 */
    round: number;

    /** 本轮模型的思考（Thought）。 */
    thought?: string;

    /** 本轮选择的工具与参数（Action）。 */
    action?: { tool: string; args: Record<string, unknown> };

    /** 工具执行结果（Observation）。 */
    observation?: Observation;

    /** 最终答案（仅结束轮存在，存在即循环终止标志）。 */
    finalAnswer?: string;
}
