/**
 * MCP 类型定义。
 *
 * 设计意图：
 * - McpToolDescriptor.annotations 是"远端自称的提示"，绝不可作为信任依据；
 *   本地元信息一律由 mcp/adapter.ts 的 deriveToolMetadata 从严推导（最小信任模型）；
 * - qualifiedName 全局唯一（`mcp:<serverId>:<toolName>`），
 *   避免不同 server 的同名工具在 allowlist / 账本 / 审计中冲突。
 *
 * 信任边界总览：
 *   MCP server = 外部不可信进程。本模块的所有类型都围绕一个原则设计：
 *   远端声明的任何能力（annotations、description）都只是"线索"，
 *   本地的白名单、超时、配额、审批才是"决定"。
 */
import type { TenantContext } from '../domain/types.js';

/**
 * MCP server 的传输层配置（discriminated union，以 kind 区分）。
 *
 * 三种传输的安全等级差异：
 * - stdio：本地子进程，命令行来自配置文件，风险 = 配置本身被篡改；
 * - http / sse：远程端点，额外暴露网络面，headers 常携带凭证，
 *   凭证只存在于配置/env，禁止写入日志与 checkpoint。
 */
export type McpTransportConfig =
    | { kind: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
    | { kind: 'http'; url: string; headers?: Record<string, string> }
    | { kind: 'sse'; url: string; headers?: Record<string, string> };

/** 一个 MCP server 的接入配置（AppConfig.mcp.servers 的元素）。 */
export interface McpServerConfig {
    /** server 标识（tenant 内唯一），参与 qualifiedName 与审计日志。 */
    id: string;

    /** 总开关：false 时不连接、其下工具一概不注册。 */
    enabled: boolean;

    /** 传输方式与连接参数。 */
    transport: McpTransportConfig;

    /**
     * 允许的工具名前缀（空 = 全部，仍受全局 defaultPolicy 约束）。
     * 白名单是"本地从严"模型的执行点之一：即使 server 自称有更多工具，
     * 未命中前缀的也不注册给模型。
     */
    toolAllowPrefixes?: string[];

    /** 单次工具调用超时（毫秒）。server 级覆盖全局 mcp.requestTimeoutMs 的能力，便于按 server 微调。 */
    toolCallTimeoutMs: number;

    /** 该 server 工具每会话最大调用次数（防失控外部 server 拖垮预算）。 */
    maxCallsPerSession: number;
}

/**
 * 从 MCP server 发现并注册后的工具描述（本地登记簿条目）。
 *
 * 生命周期：连接成功后从 server 的 tools/list 拉取，
 * 经 allowPrefixes 过滤 + deriveToolMetadata 推导后进入注册表；
 * 注册表条目只增不改——server 重连后若声明变化，走"重新发现"而非原地修改。
 */
export interface McpToolDescriptor {
    /** 来源 server 标识。 */
    serverId: string;

    /** 工具在 server 内的原始名称（server 内唯一，跨 server 可能重名）。 */
    toolName: string;

    /** 全局唯一名：`mcp:<serverId>:<toolName>`。 */
    qualifiedName: string;

    /** server 自述的用途说明（会进模型 prompt，注意：是远端提供的内容，需在发现时审查）。 */
    description: string;

    /** JSON Schema 形式的入参描述（转 LangChain Tool 时直接使用）。 */
    inputSchema: Record<string, unknown>;

    /**
     * MCP 规范中的工具注解——仅作提示，不作信任依据（§15.4）。
     * 恶意 server 可以谎报 readOnlyHint=true 来诱导本地免审放行，
     * 因此读/写判定必须由 deriveToolMetadata 结合本地规则从严推导。
     */
    annotations?: {
        /** 远端自称"只读"——不可信，仅作参考。 */
        readOnlyHint?: boolean;

        /** 远端自称"有破坏性"——仅作参考。 */
        destructiveHint?: boolean;

        /** 远端自称"幂等"——仅作参考，重试策略不据此放开。 */
        idempotentHint?: boolean;

        /** 远端自称"会访问开放世界"（如联网查询）——仅作参考。 */
        openWorldHint?: boolean;
    };
}

/** 一次 MCP 工具调用的完整入参（adapter 执行调用的统一入参）。 */
export interface McpCallInput {
    /** 目标 server。 */
    serverId: string;

    /** 目标工具（server 内原始名）。 */
    toolName: string;

    /** 调用参数（结构由目标工具的 inputSchema 约定）。 */
    args: Record<string, unknown>;

    /** 租户上下文：由 transport 层注入 header/env（租户传播契约）。 */
    tenant: TenantContext;
}

/**
 * 一次 MCP 工具调用的结果。
 *
 * 设计意图：isError 显式化——MCP 协议中"工具执行了但业务失败"
 * 与"调用通道失败"是两类错误，前者走 isError=true 返回给模型观察，
 * 后者走本地异常/重试路径，二者不可混同。
 */
export interface McpCallResult {
    /** 工具返回内容（结构由远端决定，本地不作假设，故为 unknown）。 */
    content: unknown;

    /** 业务层失败标志（工具已执行但报错，区别于传输/超时异常）。 */
    isError: boolean;
}

/** MCP server 的运行时健康快照（/api/status 或运维接口的观测输出）。 */
export interface McpServerStatus {
    /** server 标识。 */
    serverId: string;

    /** 当前是否处于已连接状态。 */
    connected: boolean;

    /** 本次连接发现的（通过白名单后的）工具数量。 */
    toolCount: number;

    /** 连接失败原因（connected=false 时有值，运维排查入口）。 */
    error?: string;
}
