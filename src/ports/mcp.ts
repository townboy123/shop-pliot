/**
 * MCP 端口与契约类型。
 *
 * 契约归位：这些类型原住 mcp/types.ts，导致 ports/mcp 与 config/env
 * 反向依赖 mcp 功能模块。契约是跨层协议，定义在 ports（依赖最内层），
 * mcp/types.ts 改为 re-export 兼容，依赖方向变为 mcp → ports。
 *
 * 设计意图：
 * - 图内（wrapTool / adapter）只依赖 McpPort，不接触 @modelcontextprotocol/sdk：
 *   测试用 FakeMcpRegistry（InMemoryTransport）即可全链路测试；
 * - callTool 的 McpCallInput 显式携带 tenant：租户上下文穿越 MCP 边界是
 *   显式契约（transport 层负责注入 header/env），不允许隐式传递；
 * - McpToolDescriptor.annotations 是"远端自称的提示"，绝不可作为信任依据，
 *   本地元信息一律由 mcp/adapter.ts 的 deriveToolMetadata 从严推导
 *   （最小信任模型）；qualifiedName 全局唯一（`mcp:<serverId>:<toolName>`），
 *   避免不同 server 的同名工具在 allowlist / 账本 / 审计中冲突。
 */
import type { TenantContext } from '../domain/types.js';

/**
 * MCP Server 的传输层配置（判别联合，按 kind 区分）。
 *
 * 三种传输方式：
 * - `stdio`：以子进程方式拉起本地 MCP Server（通过 command + args）；
 * - `http`：流式 HTTP 远程连接；
 * - `sse`：Server-Sent Events 远程连接（旧版协议，兼容保留）。
 */
export type McpTransportConfig =
    | { kind: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
    | { kind: 'http'; url: string; headers?: Record<string, string> }
    | { kind: 'sse'; url: string; headers?: Record<string, string> };

/** 单台 MCP Server 的静态配置项（来自 config/env 层） */
export interface McpServerConfig {
    /** Server 唯一标识，参与 qualifiedName 组成（`mcp:<serverId>:<toolName>`） */
    id: string;

    /** 是否启用；connect() 只连接 enabled 的 server */
    enabled: boolean;

    /** 传输层配置（stdio / http / sse 三选一） */
    transport: McpTransportConfig;
    /**
     * 允许的工具名前缀白名单。
     * 空或缺省 = 不做前缀过滤（全部放行），但仍受全局 defaultPolicy 约束。
     */
    toolAllowPrefixes?: string[];

    /** 单次工具调用的超时时间（毫秒），超时由 Port 层中断并返回错误 */
    toolCallTimeoutMs: number;

    /** 该 server 的工具在单个会话内的最大调用次数（配额熔断） */
    maxCallsPerSession: number;
}

/** MCP 工具描述符：listTools() 的产出物，也是 wrapTool 转 LangChain Tool 的数据源 */
export interface McpToolDescriptor {
    /** 工具所属 Server 的 id */
    serverId: string;

    /** Server 侧原始工具名（可能与其他 server 重名） */
    toolName: string;

    /** 全局唯一名：`mcp:<serverId>:<toolName>`，allowlist / 账本 / 审计均以此为准 */
    qualifiedName: string;

    /** 远端自述的工具用途说明（直接透传给 LLM 作选择依据） */
    description: string;

    /** JSON Schema 形式的入参描述（转 LangChain Tool 时直接使用） */
    inputSchema: Record<string, unknown>;

    /**
     * MCP 规范中的工具注解——仅是远端自称的提示，不作信任依据（§15.4）。
     * 本地元信息（是否只读/有副作用等）一律由 deriveToolMetadata 从严推导。
     */
    annotations?: {
        /** 远端自称：纯读取、无副作用 */
        readOnlyHint?: boolean;

        /** 远端自称：具有破坏性（删除/覆盖等不可逆操作） */
        destructiveHint?: boolean;

        /** 远端自称：幂等（重复调用结果一致） */
        idempotentHint?: boolean;

        /** 远端自称：与开放世界交互（结果可能受外部状态影响） */
        openWorldHint?: boolean;
    };
}

/** 工具调用入参：serverId + toolName 定位目标，args 为业务参数 */
export interface McpCallInput {
    /** 目标 Server id */
    serverId: string;

    /** 目标工具的原始名（非 qualifiedName，Port 层负责定位） */
    toolName: string;

    /** 符合该工具 inputSchema 的业务参数 */
    args: Record<string, unknown>;

    /**
     * 租户上下文：显式穿越 MCP 边界的契约（§15.5 租户传播契约），
     * 由 transport 层负责注入 header/env，禁止隐式传递。
     */
    tenant: TenantContext;
}

/** 工具调用结果：无论成败均以值返回，isError 区分业务失败与异常路径 */
export interface McpCallResult {
    /** 工具输出内容（文本 / 结构化数据，由具体工具决定） */
    content: unknown;

    /** 远端是否报告执行失败；true 时 content 通常为错误信息 */
    isError: boolean;
}

/** 单台 Server 的连接状态：connect() 逐台产出，失败不抛错 */
export interface McpServerStatus {
    /** 对应 McpServerConfig.id */
    serverId: string;

    /** 是否连接成功 */
    connected: boolean;

    /** 该 Server 注册的（经过滤后的）工具数量 */
    toolCount: number;

    /** 连接失败原因（仅 connected === false 时存在） */
    error?: string;
}

/**
 * MCP 端口（六边形架构中的 Port）：图内依赖的唯一 MCP 抽象。
 *
 * 实现方（adapter）负责连接管理、工具发现与调用；
 * 测试用 FakeMcpRegistry（InMemoryTransport）替换本接口即可全链路测试，
 * 图内代码不接触 @modelcontextprotocol/sdk。
 */
export interface McpPort {
    /**
     * 建立全部 enabled server 的连接，返回逐台状态。
     * 单台失败不抛错，失败信息记入对应 McpServerStatus.error。
     */
    connect(): Promise<McpServerStatus[]>;

    /**
     * 拉取全部已连接 Server 的工具清单。
     * 内部完成 qualifiedName 规范化与 allowPrefixes 前缀过滤。
     */
    listTools(): Promise<McpToolDescriptor[]>;

    /**
     * 调用指定工具。
     *
     * @param input - 目标工具定位（serverId + toolName）、业务参数及租户上下文
     * @returns 执行结果（业务失败以 isError=true 返回，不抛错）
     * @throws 仅在基础设置非法时抛错（如目标 Server 未连接、transport 层故障）
     */
    callTool(input: McpCallInput): Promise<McpCallResult>;

    /** 关闭全部连接并释放底层资源；复用 Port 前须重新 connect */
    close(): Promise<void>;
}
