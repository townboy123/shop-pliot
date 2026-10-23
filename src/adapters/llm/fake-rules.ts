/**
 * runtime fake 模型的演示规则集（零依赖全流程演示的数据源）。
 *
 * 设计意图：
 * - LLM_PROVIDER=fake 时项目仍可端到端演示（.env：fake 用于本地开发与测试）——
 *   若只有 defaultResponse '{"intent":"unknown"}'，所有意图都落入 clarify，
 *   工作流的四条路径（商品/订单/售后/政策）一条都走不到；
 * - 规则沿 FakeRule 契约：按 system 提示词关键词匹配"当前在哪个节点"，
 *   再从最后一条 human 消息（本视图必含本轮用户输入）做正则抽取；
 * - 输出与真实 LLM 同构：分类/抽取节点返回 JSON（parseStructured 消费），
 *   生成节点返回自然语言——因此切换 LLM_PROVIDER=openai 时行为语义不变，
 *   只是"聪明程度"不同；
 * - 抽取能力刻意保守（正则可提取才填值，否则 null）→ 走澄清路径，
 *   与真实模型的"信息不足就澄清"行为一致，HITL/降级演示同样可用。
 */
import type { BaseMessage } from '@langchain/core/messages';
import type { FakeRule } from './fake.js';

/** 最后一条 human 消息文本（节点视图固定以本轮用户输入结尾） */
function lastHuman(messages: BaseMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.getType() === 'human') return String(m.content);
    }
    return '';
}

/** 订单号：字母前缀 + 数字（o1 / ORD123 / 纯数字），中文不属于 \w 因此可作边界 */
const ORDER_ID_RE = /\b[a-zA-Z]{0,4}\d{1,10}\b/;

/** 系统视图中的"参考信息"注入块（composeResponse 的 extra HumanMessage） */
function referenceInfo(messages: BaseMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.getType() === 'human' && String(m.content).startsWith('参考信息：')) {
            return String(m.content).replace(/^参考信息：\n?/, '');
        }
    }
    return '';
}

export function fakeDemoRules(): FakeRule[] {
    return [
        {
            name: 'fake-classify',
            test: (ms) =>
                ms.some(
                    (m) => m.getType() === 'system' && String(m.content).includes('意图分类器'),
                ),
            respond: (ms) => {
                const text = lastHuman(ms);
                // 售后先于订单判断："退订单 o1" 同时命中两个词，语义归售后
                if (/(退货|退款|换货|售后|维修|质量问?题)/.test(text))
                    return '{"intent":"after_sales"}';
                if (/(订单|物流|快递|到哪|发货|签收|运单)/.test(text)) return '{"intent":"order"}';
                if (/(政策|无理由|七天|7\s*天|保修|运费|条款)/.test(text))
                    return '{"intent":"policy"}';
                if (/(推荐|搜索|找|想买|买|多少钱|多少钱|预算|以内|耳机|手机)/.test(text))
                    return '{"intent":"product"}';
                return '{"intent":"unknown"}';
            },
        },
        {
            name: 'fake-extract-product',
            test: (ms) =>
                ms.some(
                    (m) => m.getType() === 'system' && String(m.content).includes('商品搜索条件'),
                ),
            respond: (ms) => {
                const text = lastHuman(ms);
                const maxPrice = text.match(/(\d{2,6})\s*(?:元|块)/)?.[1];
                const query =
                    text
                        .replace(/[，。！？,!?]/g, ' ')
                        .replace(/\d{2,6}\s*(?:元|块)(?:以内|以下|左右|之内)?/g, ' ')
                        .replace(
                            /(?:帮我|我想|请|推荐|搜索|找找|找|买|看一下|看看|有没有|适合|预算|以内|一个|的|吗)/g,
                            ' ',
                        )
                        .replace(/\s+/g, ' ')
                        .trim() || '商品';
                return JSON.stringify({
                    query,
                    category: null,
                    minPrice: null,
                    maxPrice: maxPrice ? Number(maxPrice) : null,
                });
            },
        },
        {
            name: 'fake-order-extract',
            test: (ms) =>
                ms.some(
                    (m) => m.getType() === 'system' && String(m.content).includes('抽取订单号'),
                ),
            respond: (ms) => {
                const orderId = lastHuman(ms).match(ORDER_ID_RE)?.[0] ?? null;
                return JSON.stringify({ orderId });
            },
        },
        {
            name: 'fake-return-slots',
            test: (ms) =>
                ms.some((m) => m.getType() === 'system' && String(m.content).includes('槽位信息')),
            respond: (ms) => {
                const text = lastHuman(ms);
                const orderId = text.match(ORDER_ID_RE)?.[0] ?? null;
                const sku = text.match(/\bp\d{1,6}\b/i)?.[0] ?? null;
                const reason =
                    text.match(/(?:原因|因为|理由)[：:，,]?\s*(.{1,20})/)?.[1]?.trim() ??
                    (text.includes('质量')
                        ? '质量问题'
                        : text.includes('不想要')
                          ? '不想要了'
                          : '用户申请退货');
                return JSON.stringify({ orderId, sku, reason });
            },
        },
        {
            name: 'fake-policy-qa',
            test: (ms) =>
                ms.some((m) => m.getType() === 'system' && String(m.content).includes('政策客服')),
            respond: (ms) => {
                const text = lastHuman(ms);
                if (/(质量|损坏|故障)/.test(text)) {
                    return '根据政策 [2]，质量问题退货不受 7 天限制，签收后 30 天内可申请，运费由平台承担，需提供质量问题凭证。';
                }
                return '根据政策 [1]，自商品签收之日起 7 天内且商品完好，可无理由退货；定制类商品与贴身衣物除外 [1]。';
            },
        },
        {
            name: 'fake-clarify',
            test: (ms) =>
                ms.some((m) => m.getType() === 'system' && String(m.content).includes('澄清问题')),
            respond: (ms) => {
                // 与 SYSTEM_PROMPT.clarify 的两类行为对齐：闲聊/身份 → 自我介绍；业务不清 → 澄清
                const text = lastHuman(ms);
                if (/(你是谁|你好|您是谁|能干什么|叫什么)/.test(text)) {
                    return '（fake 模式）我是 ShopPilot 电商助手：可以帮你搜索推荐商品、查询订单物流、办理退换货、解答平台政策。试试"500 元以内的蓝牙耳机"。';
                }
                return '（fake 模式）信息还不够：请告诉我订单号或商品名称，例如"订单 o1 到哪了"、"退订单 o1 的 p1"。';
            },
        },
        {
            name: 'fake-compose',
            test: (ms) =>
                ms.some(
                    (m) => m.getType() === 'system' && String(m.content).includes('导购与售后助手'),
                ),
            respond: (ms) => {
                const ref = referenceInfo(ms);
                if (!ref) return '（fake 模式）已收到您的消息。';
                const lines = ref
                    .split('\n')
                    .filter(
                        (l) =>
                            l.startsWith('工具结果') ||
                            l.startsWith('商品搜索结果') ||
                            l.startsWith('- '),
                    );
                return `（fake 模式）根据查询结果：\n${lines.slice(0, 8).join('\n')}`;
            },
        },
        {
            // ReAct：首轮行动查订单，收到观察（"已有进展"注入）后收尾——保证循环可终止
            name: 'fake-react',
            test: (ms) =>
                ms.some(
                    (m) => m.getType() === 'system' && String(m.content).includes('思考→行动→观察'),
                ),
            respond: (ms) => {
                const progressed = ms.some(
                    (m) => m.getType() === 'human' && String(m.content).includes('已有进展'),
                );
                if (!progressed)
                    return '{"thought":"先查订单","action":{"tool":"getOrder","args":{"orderId":"o1"}}}';
                return '{"thought":"信息足够","finalAnswer":"（fake 模式）ReAct 循环完成：已获取订单 o1 的查询结果。"}';
            },
        },
        {
            name: 'fake-planner',
            test: (ms) =>
                ms.some(
                    (m) => m.getType() === 'system' && String(m.content).includes('任务规划器'),
                ),
            respond: () =>
                JSON.stringify({
                    goal: '完成用户请求',
                    steps: [
                        {
                            id: 's1',
                            description: '查询订单 o1 状态',
                            tool: { name: 'getOrder', args: { orderId: 'o1' } },
                            dependsOn: [],
                        },
                        {
                            id: 's2',
                            description: '查询订单 o1 物流',
                            tool: { name: 'getLogistics', args: { orderId: 'o1' } },
                            dependsOn: ['s1'],
                        },
                    ],
                }),
        },
        {
            name: 'fake-synthesizer',
            test: (ms) =>
                ms.some(
                    (m) => m.getType() === 'system' && String(m.content).includes('结果汇总器'),
                ),
            respond: (ms) => {
                const ref = [...ms].reverse().find((m) => m.getType() === 'human');
                const digest = ref ? String(ref.content).slice(0, 120) : '';
                return JSON.stringify({ finalAnswer: `（fake 模式）计划执行完成。${digest}` });
            },
        },
    ];
}
