/**
 * FakeChatModel：全项目 LLM 测试替身。
 *
 * 难点与设计意图：
 * 1. 继承 BaseChatModel 而非自造接口——图的节点 .invoke(model) 走的是
 *    LangChain 完整调用链（callbacks / cache / streaming 检测），替身必须
 *    在真实链路上工作，测试结论才可信；
 * 2. 响应解析优先级：queue（严格顺序）> rules（按序规则匹配）> responder
 *    > defaultResponse。rules 按"system 提示词关键词"匹配而非消息顺序，
 *    重构提示词措辞不会让测试雪崩；queue 只留给严格顺序断言的窄场景；
 * 3. usage 模拟写入 AIMessage.usage_metadata（input/output/total_tokens），
 *    token 软预算因此可测；缺省按 response 字符数 / 4 估算（与启发式 TokenCounter 一致）。
 *
 * @example
 * const model = new FakeChatModel({
 *   rules: [
 *     { name: 'intent', test: (m) => String(m[0].content).includes('意图'), respond: () => '{"intent":"qa"}' },
 *   ],
 *   usage: (r) => ({ promptTokens: 10, completionTokens: r.length / 4 }),
 * });
 */
import { AIMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';

/**
 * 一条响应规则：test 命中即用 respond 生成回复（按数组顺序，首个命中生效）。
 *
 * @property name    规则名，仅用于调试 / 断言可读性。
 * @property test    匹配历史消息的函数，例如判断 system 提示词是否含某关键词。
 * @property respond 命中后返回原始字符串（通常是 JSON 或自然语言）。
 */
export interface FakeRule {
    /** 名称 */
    name?: string;

    /** 匹配历史消息，例如 system 提示词包含某关键词 */
    test: (messages: BaseMessage[]) => boolean;

    /** 返回原始字符串（通常是 JSON 或自然语言） */
    respond: (messages: BaseMessage[]) => string;
}

/**
 * 模拟的 token 用量。
 *
 * @property promptTokens     输入 token 数（映射到 input_tokens）。
 * @property completionTokens 输出 token 数（映射到 output_tokens）。
 */
export interface FakeUsage {
    /** 提示词 token */
    promptTokens: number;

    /** 完成消耗 token */
    completionTokens: number;
}

/**
 * FakeChatModel 构造选项。
 *
 * @property queue           优先消费的响应队列（适合严格顺序断言的窄场景），FIFO。
 * @property rules           按顺序匹配的规则（推荐：重构提示词不会让测试雪崩）。
 * @property responder       兜底函数，在 queue 与 rules 均未命中时调用。
 * @property defaultResponse 全部未命中时的默认响应，缺省为 `'{"intent":"unknown"}'`。
 * @property usage           模拟 token 用量；显式配置优先，缺省按字符数 / 4 估算。
 */
export interface FakeChatModelOptions {
    /** 优先消费的响应队列（适合严格顺序断言的窄场景） */
    queue?: string[];

    /** 按顺序匹配的规则（推荐：重构提示词不会让测试雪崩） */
    rules?: FakeRule[];

    /** 兜底函数 */
    responder?: (messages: BaseMessage[]) => string;

    /** 全部未命中时的默认响应 */
    defaultResponse?: string;

    /** 模拟 token 用量（写入 AIMessage.usageMetadata），使 token 预算可测；
     *  缺省按字符数 / 4 估算 */
    usage?: FakeUsage | ((response: string) => FakeUsage);
}

/** 强约束协议：所有 FakeRule.respond 必须返回合法 JSON 或纯文本 */
export type FakeRespond = string;

/**
 * 一次调用的记录，用于断言。
 *
 * @property messages 本次调用收到的消息视图。
 * @property response 本次返回的响应文本。
 * @property usage    本次解析出的 token 用量（可能为估算值）。
 */
export interface FakeCallRecord {
    /** 本次调用收到的消息视图。 */
    messages: BaseMessage[];

    /** 本次返回的响应文本。 */
    response: string;

    /** 本次解析出的 token 用量（可能为估算值）。 */
    usage?: FakeUsage;
}

/**
 * 全项目 LLM 测试替身，继承 LangChain `BaseChatModel` 以走真实调用链。
 */
export class FakeChatModel extends BaseChatModel {
    /** 记录所有调用，用于断言（含每次响应的 usageMetadata） */
    readonly calls: FakeCallRecord[] = [];

    /** 待消费的响应队列（FIFO），是"严格顺序断言"场景的响应来源。 */
    private readonly queue: string[];

    /** 按顺序匹配的规则表，是"语义匹配"场景的响应来源（推荐用法）。 */
    private readonly rules: FakeRule[];

    /** 兜底响应函数，在 queue 与 rules 都未命中时调用，能拿到完整 messages 动态生成回复。 */
    private readonly responder?: (messages: BaseMessage[]) => string;

    /** 所有优先级都未命中时的最终兜底响应文本。 */
    private readonly defaultResponse: string;

    /** token 用量的配置源，类型是 FakeUsage | ((response: string) => FakeUsage) | undefined。 */
    private readonly usageOpt: FakeChatModelOptions['usage'];

    /**
     * @param opts 构造选项，缺省时使用默认响应。
     */
    constructor(opts: FakeChatModelOptions = {}) {
        super({});
        this.queue = [...(opts.queue ?? [])];
        this.rules = opts.rules ?? [];
        this.responder = opts.responder;
        this.defaultResponse = opts.defaultResponse ?? '{"intent":"unknown"}';
        this.usageOpt = opts.usage;
    }

    /**
     * LangChain 内部标识，固定返回 `'fake'`。
     *
     * @returns 模型类型标识字符串。
     */
    override _llmType(): string {
        return 'fake';
    }

    /**
     * 动态追加响应（测试中途追加场景），按 FIFO 顺序追加到队尾。
     *
     * @param responses 要追加的响应文本。
     */
    enqueue(...responses: string[]): void {
        this.queue.push(...responses);
    }

    /**
     * 核心：从 options 中挑选响应文本。
     *
     * 优先级：queue → rules（首个命中）→ responder → defaultResponse。
     *
     * @param messages 当前历史消息视图。
     * @returns 选中的响应字符串。
     */
    private pickResponse(messages: BaseMessage[]): string {
        const fromQueue = this.queue.shift();
        if (fromQueue !== undefined) return fromQueue;
        for (const rule of this.rules) {
            if (rule.test(messages)) return rule.respond(messages);
        }
        if (this.responder) return this.responder(messages);
        return this.defaultResponse;
    }

    /**
     * token 用量：显式配置优先，否则按字符数 / 4 估算。
     *
     * @param response 本次响应文本，用于估算 completionTokens。
     * @returns 解析后的 token 用量。
     */
    private resolveUsage(response: string): FakeUsage {
        if (typeof this.usageOpt === 'function') return this.usageOpt(response);
        if (this.usageOpt) return this.usageOpt;
        return { promptTokens: 0, completionTokens: Math.ceil(response.length / 4) };
    }

    /**
     * BaseChatModel 的抽象方法：同步生成一轮回复。
     *
     * 选中响应后构造 `AIMessage`，并把 usage 写入标准 `usage_metadata`，
     * 同时把本次调用记录进 `calls`。
     *
     * @param messages    输入消息视图（节点经 harness.context.build 产出）。
     * @param _options    LangChain 解析后的调用选项，此处不使用。
     * @param _runManager 回调管理器，此处不使用（仍走真实链路）。
     * @returns 符合 LangChain 约定的 `ChatResult`。
     */
    async _generate(
        messages: BaseMessage[],
        _options?: this['ParsedCallOptions'],
        _runManager?: CallbackManagerForLLMRun,
    ): Promise<ChatResult> {
        const response = this.pickResponse(messages);
        const usage = this.resolveUsage(response);
        const ai = new AIMessage({
            content: response,
            // 写入标准 usage_metadata：token 预算（reportUsage）与测试断言的统一数据源
            usage_metadata: {
                input_tokens: usage.promptTokens,
                output_tokens: usage.completionTokens,
                total_tokens: usage.promptTokens + usage.completionTokens,
            },
        });
        this.calls.push({ messages, response, usage });
        return { generations: [{ text: response, message: ai }] };
    }
}
