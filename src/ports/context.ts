/**
 * 上下文管理端口。
 *
 * 设计意图（"视图不落盘"原则——本项目最关键的上下文契约）：
 * - ContextManager.build 只产出"本次 LLM 调用的消息视图"，绝不修改 state.messages。
 *   全量历史由 checkpointer 持久化，是 interrupt/resume 与审计的事实源；
 *   裁剪若落盘会破坏 resume 完整性与多轮 slot filling（slot 已固化在 State，不靠消息）。
 * - 长期记忆同样只读注入视图（SystemMessage），不追加到 state.messages，
 *   避免"记忆污染历史"。
 */

import type { MemoryHit } from '../domain/types.js';
import type { BaseMessage } from '@langchain/core/messages';

/**
 * 构建上下文视图的输入参数。
 *
 * 由各节点（Node）在调用 LLM 前组装，交给
 * {@link ContextManager.build} 生成最终的消息视图。
 */
export interface BuildContextInput {
    /** 全量历史（只读，实现方不得修改此数组）。 */
    history: BaseMessage[];

    /**
     * 节点自己的 system prompt。
     *
     * 无论后续如何裁剪/压缩历史，本消息**永远置于视图首位**，
     * 且不参与 `historyTokenBudget` 的裁剪。
     */
    systemPrompt: string;

    /**
     * 节点附加上下文消息（如工具结果摘要）。
     *
     * 置于 system prompt 之后、历史消息之前；
     * 同样不参与历史裁剪。
     */
    extra?: BaseMessage[];

    /**
     * 本次调用允许的历史 token 预算。
     *
     * 由 BudgetController 派生（总上下文窗口减去
     * system/extra/输出预留等），历史超出该预算时
     * 由实现方决定裁剪或摘要压缩策略。
     */
    historyTokenBudget: number;

    /**
     * 长期记忆命中结果，只读注入。
     *
     * 实现方应将其转为消息（通常以 system 或人类可读格式）
     * 插入视图，且注入总量受 {@link memoryTokenBudget} 约束。
     */
    longTermMemories?: MemoryHit[];

    /**
     * 长期记忆注入的 token 预算。
     *
     * 超出预算的记忆条目应被丢弃（记入
     * {@link ContextView.memory.dropped}），而非截断，
     * 以保持单条记忆语义完整。
     */
    memoryTokenBudget?: number;
}

/**
 * 上下文构建结果视图。
 *
 * 除可直接送 LLM 的消息列表外，还携带观测指标，
 * 供上层做日志、指标上报与调试。
 */
export interface ContextView {
    /**
     * 可直接送 LLM 的消息视图。
     *
     * 顺序约定：systemPrompt → extra → （memory 注入）→ 历史消息。
     */
    messages: BaseMessage[];

    /**
     * 因裁剪（超出 {@link BuildContextInput.historyTokenBudget}）
     * 被直接丢弃的消息数，仅作观测。
     */
    droppedCount: number;

    /** 最终视图的 token 估算值（含 system/extra/memory/历史），仅作观测。 */
    estimatedTokens: number;

    /**
     * 发生摘要压缩时的信息。
     *
     * 为 `undefined` 表示本次未触发压缩；
     * 压缩发生时，`summaryMessage` 已包含在 `messages` 中，
     * 被摘要的消息不再出现（且计入 `summarizedCount`，
     * 不计入 `droppedCount`）。
     */
    compaction?: {
        /** 被摘要合并的消息条数。 */
        summarizedCount: number;

        /** 生成的摘要消息（已插入视图头部附近）。 */
        summaryMessage: BaseMessage;
    };

    /**
     * 长期记忆注入观测。
     *
     * - `injected`：实际注入视图的记忆条数。
     * - `dropped`：因超出预算或失败被丢弃的条数。
     * - `tokens`：注入记忆占用的估算 token 数。
     */
    memory: {
        injected: number;
        dropped: number;
        tokens: number;
    };
}

/**
 * 上下文管理端口：负责将历史、system prompt、附加上下文与
 * 长期记忆组装成一个受 token 预算约束、可直接送 LLM 的消息视图。
 *
 * @remarks
 * 策略细节（裁剪 vs 摘要压缩、记忆注入位置与格式）由实现方决定，
 * 调用方只消费 {@link ContextView} 与其中的观测字段。
 */
export interface ContextManager {
    /**
     * 根据输入构建本次调用的上下文视图。
     *
     * @param input - 构建所需的全部素材与预算，见 {@link BuildContextInput}。
     * @returns 最终消息视图及观测指标，见 {@link ContextView}。
     *
     * @remarks
     * 实现方不得修改 `input.history` 等只读数组；
     * 返回的 `messages` 应为新建数组（或至少不与输入共享可变引用）。
     */
    build(input: BuildContextInput): Promise<ContextView>;
}

/**
 * Token 计数端口。
 *
 * 启发式估算即可（如 `chars / 4`），与具体 tokenizer 解耦——
 * 换用真实 tokenizer（如 tiktoken）时只需替换实现，
 * 上层策略逻辑（预算控制、裁剪、压缩）无需改动。
 *
 * @remarks
 * 估算值允许有偏差，但应保持**同方向**偏差（始终偏高或始终偏低），
 * 否则预算控制可能出现震荡。经验上偏高更安全（宁可少装不超限）。
 */
export interface TokenCounterPort {
    /**
     * 估算一组消息的总 token 数。
     *
     * 应包含消息的 role 标记、内容、工具调用等全部可序列化部分。
     *
     * @param messages - 待估算的消息列表。
     * @returns 估算的 token 总数（非负整数）。
     */
    countMessages(messages: BaseMessage[]): number;

    /**
     * 估算一段纯文本的 token 数。
     *
     * 通常用于估算 system prompt、记忆条目等
     * 尚未包装为 {@link BaseMessage} 的内容。
     *
     * @param text - 待估算的文本。
     * @returns 估算的 token 数（非负整数）。
     */
    estimateText(text: string): number;
}
