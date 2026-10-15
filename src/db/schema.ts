/**
 * Drizzle 表定义（与规格文档 §6 一致）。
 *
 * 设计意图：
 * - 多租户隔离落在 schema 层：所有业务表都带 tenant_id，订单附加 user_id，
 *   Repository 层所有查询强制带这些过滤条件（双过滤是防横向越权的最后防线）。
 * - return_requests 的 (tenant_id, idempotency_key) 唯一索引 + memories 的
 *   (tenant_id, user_id, kind, key) 唯一索引是"数据库兜底幂等"：
 *   即使上层并发去重失效，重复插入也会被 SQLite 拒绝。
 * - tags / items / value 用 JSON TEXT 存储（SQLite 无原生 JSON 类型），
 *   读取侧自行 parse，保持 schema 简单。
 */

import { index, integer, real } from 'drizzle-orm/sqlite-core';
import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * 租户表 —— 多租户架构（Multi-Tenancy）的根实体
 *
 * 设计要点：
 * 1. 使用 `text` 类型的 id（推荐 UUIDv7 / ULID），而非自增整数：
 *    - 便于跨库迁移、分库分表时避免 ID 冲突；
 *    - UUIDv7 前缀含时间戳，兼具时间有序性，对 B-Tree 索引友好。
 * 2. 租户隔离是"应用层"职责：本表本身不含租户概念，但所有业务表
 *    都通过 `tenant_id` 冗余租户标识。⚠️ 难点：必须在所有查询的
 *    WHERE 条件中强制带上 tenant_id（建议在 Repository/DAO 层统一
 *    注入），防止水平越权（IDOR）导致数据跨租户泄露。
 */
export const tenants = sqliteTable('tenants', {
    /** 租户唯一标识，主键。建议使用 UUIDv7/ULID 等有序 ID */
    id: text('id').primaryKey(),

    /** 租户显示名，仅用于展示，不参与唯一约束（如需唯一请显式加 uniqueIndex） */
    name: text('name').notNull(),
});

/**
 * 用户表
 *
 * 难点与重点：
 * 1. `tenant_id + email` 理论上应构成业务唯一键（同一租户内邮箱唯一，
 *    不同租户允许重复邮箱）。⚠️ 当前未加唯一索引，注册/登录逻辑需
 *    自行保证；若要兜底，可加：
 *      uniqueIndex('uniq_users_tenant_email').on(t.tenantId, t.email)
 * 2. 复合索引 (tenantId) 目前只覆盖按租户过滤；若高频查询为
 *    "租户内按邮箱查用户"，应改为 (tenantId, email) 联合索引，
 *    使查询可以走覆盖索引避免回表。
 */
export const users = sqliteTable(
    'users',
    {
        /** 用户唯一标识（全局唯一，跨租户不冲突） */
        id: text('id').primaryKey(),

        /** 所属租户 ID，多租户隔离的核心字段，所有查询必须携带 */
        tenantId: text('tenant_id').notNull(),

        /** 用户显示名 */
        name: text('name').notNull(),

        /** 邮箱，租户内业务唯一（由应用层保证） */
        email: text('email').notNull(),
    },
    (t) => [index('idx_users_tenant').on(t.tenantId)],
);

/**
 * 商品表
 *
 * 难点与重点：
 * 1. `tags` 使用 JSON 字符串存储数组 —— 这是 SQLite 无数组类型的
 *    常见折中方案。⚠️ 代价：
 *    - 无法直接按 tag 做 SQL 级过滤/索引（如"含促销标签的商品"需
 *      全量拉取后内存过滤，或用 LIKE '%...%' 导致索引失效）；
 *    - 若 tag 检索是核心路径，应拆出 tags 关联表或用 FTS5。
 * 2. 联合索引 (tenantId, category) 遵循"最左前缀原则"：
 *    - ✅ WHERE tenant_id = ? AND category = ?
 *    - ✅ WHERE tenant_id = ?
 *    - ❌ WHERE category = ? （单独用 category 无法命中该索引）
 * 3. `price` 用 real（浮点数）⚠️ 存在精度问题：货币金额更推荐以
 *    "最小货币单位"（分）存 integer，浮点累加会产生 0.1+0.2 !== 0.3
 *    类误差，结算场景务必注意。
 * 4. `stock` 扣减需防超卖：并发下应使用条件更新
 *    `UPDATE ... SET stock = stock - ? WHERE stock >= ?` 并检查
 *   受影响行数，而不是"先读后写"。
 */
export const products = sqliteTable(
    'products',
    {
        /** 商品唯一标识 */
        id: text('id').primaryKey(),

        /** 所属租户 ID */
        tenantId: text('tenant_id').notNull(),

        /** 商品名 */
        name: text('name').notNull(),

        /** 商品类目，与 tenantId 组成联合索引，支持"租户内按类目筛选" */
        category: text('category').notNull(),

        /** 价格。⚠️ 浮点存钱有精度风险，生产建议改存分为单位的 integer */
        price: real('price').notNull(),
        /**
         * 标签列表，JSON 序列化后的 string[]。
         * 写入时 JSON.stringify()，读取时 JSON.parse()。
         * ⚠️ 无法对单个 tag 建索引，标签检索走内存过滤。
         */
        tags: text('tags').notNull(),

        /** 库存数量。⚠️ 扣减需用原子条件更新防超卖 */
        stock: integer('stock').notNull(),
    },
    (t) => [index('idx_products_tenant').on(t.tenantId, t.category)],
);

/**
 * 订单表
 *
 * 难点与重点：
 * 1. `items` 快照式存储订单明细（JSON 字符串）—— 这是电商订单表的
 *    经典设计：下单时把商品名/价格/数量冗余进订单，避免商品后续
 *    改价/下架影响历史订单。⚠️ 代价是：
 *    - 无法直接对明细做 SQL 聚合统计（如"卖出最多的 SKU"），
 *      需要应用层解析或同步写一张 order_items 明细表；
 *    - JSON 内的数据无外键约束，一致性由写入逻辑保证。
 * 2. `status` 为自由文本 ⚠️ 建议应用层用枚举/常量约束合法值
 *    （如 pending/paid/delivered/cancelled），SQLite 层无法限制；
 *    若需要数据库兜底可用 CHECK 约束（drizzle 需写原始 SQL）。
 * 3. 时间字段用 ISO 8601 文本（text）存储 —— SQLite 惯例：
 *    - ✅ 人类可读、可字典序比较排序（UTC 时间下）；
 *    - ⚠️ 必须统一存 UTC，否则字符串排序会乱序；
 *    - ⚠️ `deliveredAt` 可空，未发货时为 null，属于"延迟赋值"字段。
 * 4. 索引 (tenantId, userId) 支撑"某用户在某租户的订单列表"高频查询。
 */
export const orders = sqliteTable(
    'orders',
    {
        /** 订单唯一标识 */
        id: text('id').primaryKey(),

        /** 所属租户 ID */
        tenantId: text('tenant_id').notNull(),

        /** 下单用户 ID，逻辑外键（SQLite/本项目未启用物理外键） */
        userId: text('user_id').notNull(),

        /** 订单状态，建议应用层枚举约束 */
        status: text('status').notNull(),

        /**
         * 订单明细快照，JSON 序列化后的 OrderItem[]。
         * 下单时固化商品信息（价格、数量等），与商品表解耦。
         */
        items: text('items').notNull(),

        /** 送达时间，未送达为 null（ISO 8601 UTC 字符串） */
        deliveredAt: text('delivered_at'),

        /** 创建时间，ISO 8601 UTC 字符串，⚠️ 全表时间必须统一时区 */
        createdAt: text('created_at').notNull(),
    },
    (t) => [index('idx_orders_tenant_user').on(t.tenantId, t.userId)],
);

/**
 * 退货申请表
 *
 * 难点与重点 —— 幂等性设计：
 * 1. 唯一索引 `uniq_tenant_idem` (tenantId, idempotencyKey) 是本表
 *    的核心：同一租户内，同一幂等键只允许存在一条记录。
 *    - 客户端重试/网络抖动/消息重复投递时，携带相同幂等键重复提交，
 *      数据库唯一约束作为"最后防线"拒绝重复写入；
 *    - ⚠️ 注意：唯一约束只防"重复插入"，并发下的处理方式是 ——
 *      捕获唯一索引冲突异常后，转为"查询并返回已有记录"，
 *      对调用方表现为幂等成功。SQLite 冲突错误码为
 *      SQLITE_CONSTRAINT_UNIQUE。
 * 2. `sku` 粒度的退货：一个订单可能包含多个 SKU，本表按
 *    (orderId, sku) 粒度记录。⚠️ 若业务要求"同订单同 SKU 只能退一次"，
 *    需额外加 uniqueIndex(tenantId, orderId, sku) 或由应用层校验。
 * 3. 幂等键生成建议：客户端用 UUID，或服务端用
 *    `hash(tenantId + orderId + sku + 请求体)` 保证语义幂等。
 */
export const returnRequests = sqliteTable(
    'return_requests',
    {
        /** 退货单唯一标识 */
        id: text('id').primaryKey(),

        /** 所属租户 ID，幂等键作用域的一部分 */
        tenantId: text('tenant_id').notNull(),

        /** 关联订单 ID，逻辑外键 */
        orderId: text('order_id').notNull(),

        /** 退货商品 SKU，订单内明细粒度 */
        sku: text('sku').notNull(),

        /** 退货原因 */
        reason: text('reason').notNull(),

        /** 退货状态（如 pending/approved/rejected），应用层枚举约束 */
        status: text('status').notNull(),

        /**
         * 幂等键：客户端对同一业务操作生成的稳定标识。
         * 与 tenantId 组成唯一索引，重复提交时触发唯一冲突，
         * 上层捕获后返回已有记录 —— 实现写入幂等。
         */
        idempotencyKey: text('idempotency_key').notNull(),

        /** 申请时间，ISO 8601 UTC 字符串 */
        createdAt: text('created_at').notNull(),
    },
    (t) => [
        // 幂等兜底：同租户同幂等键只允许一行；违反唯一索引时上层转为"返回既有记录"
        uniqueIndex('uniq_tenant_idem').on(t.tenantId, t.idempotencyKey),
    ],
);

/**
 * 政策/条款表（如退货政策、隐私条款等知识内容）
 *
 * 重点：
 * 1. 租户级隔离：每个租户有自己的政策内容，读取时必须带 tenantId 过滤。
 * 2. ⚠️ 无版本号/生效时间字段：政策更新若需保留历史版本或定时生效，
 *    需增加 version/effectiveAt 等字段，或做 Append-Only 设计。
 * 3. 若 content 存量大文本且需关键词搜索，可考虑 SQLite FTS5
 *    全文索引（本项目未包含）。
 */
export const policies = sqliteTable(
    'policies',
    {
        /** 政策唯一标识 */
        id: text('id').primaryKey(),

        /** 所属租户 ID */
        tenantId: text('tenant_id').notNull(),

        /** 政策标题 */
        title: text('title').notNull(),

        /** 政策正文（可能为长文本） */
        content: text('content').notNull(),
    },
    (t) => [index('idx_policies_tenant').on(t.tenantId)],
);

/**
 * 记忆表（Memories）—— 面向 AI/Agent 场景的用户记忆存储
 *
 * 难点与重点：
 * 1. 语义唯一键 `uniq_mem_scope` (tenantId, userId, kind, key)：
 *    实现 "upsert" 语义 —— 同一租户同一用户下，同一类别（kind）
 *    的同一个 key 只能有一行。写入时配合
 *    `ON CONFLICT ... DO UPDATE`（drizzle 的 onConflictDoUpdate）
 *    完成"不存在则插入，存在则更新"，天然防止记忆碎片化。
 *    ⚠️ 冲突目标必须精确写成这四列，否则 upsert 不生效。
 * 2. 检索索引 `idx_mem_lookup` (tenantId, userId, kind, expiresAt)：
 *    覆盖典型读路径 —— "取某用户某类未过期的记忆"：
 *      WHERE tenant_id = ? AND user_id = ? AND kind = ?
 *        AND (expires_at IS NULL OR expires_at > ?)
 *    前三列走索引精确定位，expiresAt 在索引内完成范围过滤。
 *    ⚠️ 注意 `expires_at IS NULL` 与范围条件的混合：
 *    SQLite 索引中 NULL 参与比较的语义需留意（IS NULL 也可走索引）。
 * 3. 过期清理：expiresAt 只是"软标记"，过期数据不会自动消失，
 *    需要定时任务（TTL 清理 job）或读取时惰性过滤。
 *    ⚠️ 若不做物理清理，表会无限增长；若做清理，
 *    注意 SQLite 删除大量行后需 VACUUM 或 incremental_vacuum 回收空间。
 * 4. 来源追踪（sourceThreadId / sourceRequestId）：可回溯记忆是
 *    哪次会话/请求写入的，便于调试与"遗忘"（按来源批量删除）。
 *    可空设计：允许无来源的初始化数据。
 * 5. `confidence` 置信度：多条记忆竞争时按置信度排序取最优，
 *    或低于阈值的记忆被忽略。⚠️ 建议应用层约定取值范围（如 0~1）。
 * 6. `value` 存任意 JSON：灵活但 ⚠️ 无 schema 约束，读取方需
 *    做类型守卫（type guard），写入方需保证可序列化。
 */
export const memories = sqliteTable(
    'memories',
    {
        /** 记忆唯一标识 */
        id: text('id').primaryKey(),

        /** 所属租户 ID，唯一键与检索索引的首列 */
        tenantId: text('tenant_id').notNull(),

        /** 归属用户 ID，记忆是用户级数据 */
        userId: text('user_id').notNull(),

        /**
         * 记忆类别（如 preference / fact / instruction）。
         * 与 tenantId/userId/key 共同构成语义唯一键。
         */
        kind: text('kind').notNull(),

        /** 记忆键，同一 (tenant, user, kind) 下唯一 */
        key: text('key').notNull(),

        /**
         * 记忆值，JSON 序列化后的任意结构。
         * ⚠️ 读取时必须做 JSON.parse + 类型校验，防止脏数据。
         */
        value: text('value').notNull(),

        /** 置信度，浮点数。建议约定 0~1 范围，用于记忆竞争与过滤 */
        confidence: real('confidence').notNull(),

        /** 写入来源的会话/线程 ID，可空，用于溯源与批量遗忘 */
        sourceThreadId: text('source_thread_id'),

        /** 写入来源的请求 ID，可空，用于链路追踪 */
        sourceRequestId: text('source_request_id'),

        /** 创建时间，ISO 8601 UTC 字符串 */
        createdAt: text('created_at').notNull(),

        /** 更新时间，upsert 更新时必须同步刷新 */
        updatedAt: text('updated_at').notNull(),

        /** 过期时间，null 表示永不过期；⚠️ 过期数据需定时/惰性清理 */
        expiresAt: text('expires_at'),

        /** 记忆标签，JSON 序列化后的 string[]，用于应用层过滤 */
        tags: text('tags').notNull(),
    },
    (t) => [
        // upsert 语义键：同租户同用户同类同 key 只有一行
        uniqueIndex('uniq_mem_scope').on(t.tenantId, t.userId, t.kind, t.key),

        // 检索路径：按 (tenant, user, kind, expiresAt) 过滤
        index('idx_mem_lookup').on(t.tenantId, t.userId, t.kind, t.expiresAt),
    ],
);

/** tenants 表的查询行类型（由 drizzle 推导） */
export type TenantRow = typeof tenants.$inferSelect;

/** users 表的查询行类型（由 drizzle 推导） */
export type UserRow = typeof users.$inferSelect;

/** products 表的查询行类型（由 drizzle 推导） */
export type ProductRow = typeof products.$inferSelect;

/** orders 表的查询行类型（由 drizzle 推导） */
export type OrderRow = typeof orders.$inferSelect;

/** return_requests 表的查询行类型（由 drizzle 推导） */
export type ReturnRequestRow = typeof returnRequests.$inferSelect;

/** policies 表的查询行类型（由 drizzle 推导） */
export type PolicyRow = typeof policies.$inferSelect;

/** memories 表的查询行类型（由 drizzle 推导） */
export type MemoryRow = typeof memories.$inferSelect;
