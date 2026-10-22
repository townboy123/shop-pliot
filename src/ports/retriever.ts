/**
 * RAG 检索端口。
 *
 * 设计意图：政策问答节点只依赖 RetrieverPort；
 * 默认实现是 SQLite 关键词检索，LanceDB 向量检索为可选替换实现，
 * citationCheck 护栏的"引用必须来自检索 docs"语义与实现无关。
 */
import type { TenantId } from '../domain/types.js';

/** 检索命中的政策文档片段 */
export interface PolicyDoc {
    /** 文档 id（citationCheck 护栏以此核对引用来源） */
    id: string;

    /** 文档标题（注入 prompt 作引用展示用） */
    title: string;

    /** 文档正文片段 */
    content: string;

    /** 相关性得分（0-1），检索排序与记忆注入截断共用 */
    score: number;
}

/** 检索入参：租户作用域 + 查询串 + top-k */
export interface RetrieveInput {
    /** 租户 id（强制作用域：检索只在租户内的政策库中进行） */
    tenantId: TenantId;

    /** 检索文本 */
    query: string;

    /** 返回条数上限（top-k）；缺省由实现方决定 */
    k?: number;
}

/**
 * 政策文档检索端口（RAG 的 R）。
 *
 * 实现可替换（关键词 / 向量），调用方（政策问答节点）无感知：
 * citationCheck 护栏只关心"引用必须来自本接口返回的 docs"，
 * 与检索方式无关。
 */
export interface RetrieverPort {
    /**
     * 按查询检索政策文档，按相关度降序返回。
     *
     * @returns 命中文档列表（含得分）；无命中时返回空数组（而非 null）
     */
    search(input: RetrieveInput): Promise<PolicyDoc[]>;
}
