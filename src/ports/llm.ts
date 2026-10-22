/**
 * LLM 端口。
 *
 * 设计意图：
 * - 节点只依赖 LlmPort 而非具体 ChatOpenAI/FakeChatModel，
 *   保证"换供应商 = 换适配器，业务零改动"；
 * - meta() 暴露 provider/model 供 Harness 预算与 /api/health 遥测使用。
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export interface LlmPort {
    /** 返回底层 LangChain ChatModel，节点直接 .invoke() 调用 */
    chatModel(): BaseChatModel;

    /** 元信息，用于 Harness 预算与遥测 */
    meta(): { provider: string; model: string };
}
