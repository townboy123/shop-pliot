/**
 * Repository 端口。
 *
 * 设计意图（多租户安全契约的入口）：
 * - 每个方法的参数里"必须看得见 tenantId"——订单/物流还要 userId 双过滤，
 *   类型签名即安全审查点：任何想绕过租户过滤的调用都过不了编译；
 * - 返回 null 表示"范围内不存在"，调用方（节点/Service）决定如何向用户表达，
 *   Repository 不区分"不存在"与"无权访问"（后者对用户不可见，防探测）。
 */
import type { LogisticsInfo, Order, Product } from '../domain/types.js';
import type { ReturnRequest, TenantId, UserId } from '../domain/types.js';

/** 商品查询端口：商品目录的检索与单条读取（均强制租户作用域） */
export interface ProductRepository {
    /** 按条件检索当前租户的商品目录 */
    search(input: {
        /** 租户 id（强制作用域） */
        tenantId: TenantId;

        /** 关键词（名称/描述匹配）；缺省 = 不按关键词过滤 */
        query?: string;

        /** 类目过滤；缺省 = 全部类目 */
        category?: string;

        /** 价格下限（含）；缺省 = 不限 */
        minPrice?: number;

        /** 价格上限（含）；缺省 = 不限 */
        maxPrice?: number;

        /** 返回条数上限；缺省由实现方决定 */
        limit?: number;
    }): Promise<Product[]>;

    /**
     * 按 id 读取单个商品。
     * @returns 商品；租户内不存在该 id 时返回 null（不区分不存在与无权访问）
     */
    getById(tenantId: TenantId, id: string): Promise<Product | null>;
}

/** 订单查询端口：订单与物流的读取（全部强制 tenant + user 双过滤） */
export interface OrderRepository {
    /**
     * 按 id 读取当前用户的订单。
     * @returns 订单；不存在或不属于该用户时一律返回 null（防跨用户探测）
     */
    getById(input: {
        /** 租户 id（强制作用域） */
        tenantId: TenantId;

        /** 用户 id（双过滤：订单只能被其归属用户读取） */
        userId: UserId;

        /** 订单 id */
        orderId: string;
    }): Promise<Order | null>;

    /**
     * 物流查询同样必须双过滤（tenant + user）。
     * 设计意图：防止同租户其他用户凭 orderId 探测物流单号（规格修订 #7）。
     * @returns 物流信息；订单不存在 / 不属于该用户 / 暂无物流时一律返回 null
     */
    getLogistics(input: {
        /** 租户 id（强制作用域） */
        tenantId: TenantId;

        /** 用户 id（双过滤） */
        userId: UserId;

        /** 订单 id */
        orderId: string;
    }): Promise<LogisticsInfo | null>;
}

/** 退换货端口：退货单的幂等创建与查询 */
export interface ReturnRepository {
    /**
     * 幂等创建：依赖 (tenant_id, idempotency_key) 唯一索引。
     * 冲突时实现方应返回既有记录（幂等语义），而非抛错。
     */
    create(input: {
        /** 租户 id（强制作用域） */
        tenantId: TenantId;

        /** 关联的订单 id（实现方/上层负责校验订单归属与可退状态） */
        orderId: string;

        /** 退货的 SKU 编码 */
        sku: string;

        /** 退货原因（用户填写） */
        reason: string;

        /** 幂等键：同一 (tenantId, idempotencyKey) 重复创建返回同一条记录 */
        idempotencyKey: string;
    }): Promise<ReturnRequest>;

    /**
     * 按幂等键查询已有退货单（重试场景的快速路径）。
     * @returns 退货单；不存在时返回 null
     */
    findByIdempotencyKey(tenantId: TenantId, idempotencyKey: string): Promise<ReturnRequest | null>;
}

/** 退换货政策端口：当前租户的政策条目读取（只读） */
export interface PolicyRepository {
    /**
     * 列出当前租户的全部退换货政策条目。
     * @returns 政策列表；租户未配置政策时返回空数组（而非 null）
     */
    list(tenantId: TenantId): Promise<
        {
            /** 政策条目 id */
            id: string;

            /** 政策标题 */
            title: string;

            /** 政策正文 */
            content: string;
        }[]
    >;
}
