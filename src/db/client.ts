/**
 * 数据库客户端工厂。
 *
 * 设计意图：
 * - DB 以 ":memory:" 或文件路径创建，测试用内存库做到零残留；
 * - WAL 模式提升并发读性能（API 与 checkpointer 可能同时访问磁盘）；
 * - ensureSchema 提供幂等 DDL：演示项目与测试无需先跑 drizzle migrate 即可建表，
 *   drizzle-kit 迁移仍可用于规范演进（package.json 的 db:generate / db:migrate）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/** 业务数据库类型（drizzle 实例，带 schema 供查询构建器推导表类型） */
export type DB = BetterSQLite3Database<typeof schema>;

/** db 包装对象 → 底层 sqlite 实例的私有映射（不污染 db 对象本身） */
const sqliteRegistry = new WeakMap<DB, Database.Database>();

/**
 * 创建 SQLite 业务库连接（Drizzle ORM 封装）。
 *
 * 难点与重点：
 * 1. PRAGMA 的时序问题：
 *    - `journal_mode = WAL` 必须在任何业务读写之前设置。WAL（Write-Ahead
 *      Logging）模式下写入追加到 -wal 文件而非直接改主库文件，实现
 *      "读不阻塞写、写不阻塞读"。⚠️ 代价：进程崩溃后依赖 -wal/-shm
 *      文件恢复，拷贝数据库文件时必须连 WAL 一起拷（或先
 *      `PRAGMA wal_checkpoint(TRUNCATE)`），否则可能丢数据。
 *      ⚠️ `:memory:` 库上设置 WAL 无实际意义（内存库没有文件），
 *      但执行不报错，测试环境可安全调用。
 * 2. `foreign_keys = ON`：SQLite 的 FK 约束默认是关闭的（且是
 *    per-connection 设置，不是持久的），不开启则所有外键形同虚设。
 *    ⚠️ 每个新连接都要重新执行；连接池场景下必须在连接初始化钩子里做。
 *    ⚠️ 若当前 schema 是纯逻辑外键（无 REFERENCES 声明），此项实际
 *    不产生约束效果，是为未来加物理外键预留的保险。
 * 3. 事务并发提示：WAL 模式下同一时刻仍只允许一个写事务，高并发写
 *    会触发 SQLITE_BUSY。必要时配合 `busy_timeout` PRAGMA 使用：
 *      sqlite.pragma('busy_timeout = 5000')
 *
 * @param dbPath 数据库文件路径；传 ":memory:" 时使用纯内存库
 *             （常用于单元测试，每个 :memory: 是一个独立、临时的库，
 *             生命周期与连接绑定，关闭即销毁，因此每个测试实例
 *             都需要先执行 ensureSchema）
 * @returns 挂载了 schema 的 Drizzle DB 实例（支持 db.query.* 关系查询）
 */
export function createDb(dbPath: string): DB {
    if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    const sqlite = new Database(dbPath);

    // WAL：写不阻塞读，提升读写并发能力（对文件库有效，:memory: 无副作用）
    sqlite.pragma('journal_mode = WAL');

    // foreign_keys：SQLite 默认关闭 FK，必须显式开启（per-connection 级别）
    sqlite.pragma('foreign_keys = ON');

    // 登记，供 closeDb 查找
    const db = drizzle(sqlite, { schema });
    sqliteRegistry.set(db, sqlite);

    return db;
}

/**
 * 获取底层 better-sqlite3 连接（执行 drizzle 未覆盖的原生操作时用）。
 * ⚠️ 不要绕过它直接修改 PRAGMA/事务，会让 createDb 设置的约束失效。
 */
export function getSqlite(db: DB): Database.Database {
    const sqlite = sqliteRegistry.get(db);
    if (!sqlite) {
        throw new Error('未登记的连接：请使用 createDb() 创建（而不是手工调 drizzle()）');
    }
    return sqlite;
}

/** 关闭连接并触发 WAL checkpoint 合并回主文件 */
export function closeDb(db: DB): void {
    sqliteRegistry.get(db)?.close();
}

/**
 * 在已创建的 DB 上确保全部表与索引存在（幂等初始化）。
 *
 * 难点与重点：
 * 1. 幂等性：全部使用 `CREATE TABLE/INDEX IF NOT EXISTS`，可重复执行、
 *    可并发竞争执行而不报错 —— 这是测试环境和灰度启动的基础保障。
 * 2. ⚠️ 双份 DDL 的同步风险：本函数的 DDL 与 schema.ts 是"手工同步"
 *    的两份定义。schema 变更（加列/改索引）时这里必须同步修改，
 *    否则会出现"代码读的字段库里没有"的运行时错误。缓解方式：
 *    - 测试中加一个"结构对账"用例：插入/读回全字段，逐列断言；
 *    - 或生产环境改用 drizzle-kit migration 管理，运行时只跑迁移。
 * 3. ⚠️ IF NOT EXISTS 不会修正已存在但结构过时的表：它只保证"有"，
 *    不保证"对"。已有旧结构的库不会被自动升级 —— 演进需要
 *    显式的 ALTER TABLE 迁移逻辑，不能指望本函数。
 * 4. 索引必须在表之后创建（依赖表存在）；执行顺序即下述语句顺序。
 * 5. `:memory:` 库的每个连接都是独立空间，测试里每个新库都必须
 *    先跑一次本函数；文件库则只在建库/升级时执行。
 */
export function ensureSchema(db: DB): void {
    /**
     * 租户表：多租户体系的根实体。
     * id 用 TEXT 主键（UUIDv7/ULID），有序 ID 对索引友好。
     */
    db.run(sql`CREATE TABLE IF NOT EXISTS tenants (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL
	)`);

    /**
     * 用户表。
     * ⚠️ 未建 (tenant_id, email) 唯一索引，租户内邮箱唯一由应用层保证；
     * 仅建 tenant_id 单列索引支撑"按租户取用户列表"。
     */
    db.run(sql`CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		name TEXT NOT NULL,
		email TEXT NOT NULL
	)`);
    db.run(sql`CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id)`);

    /**
     * 商品表。
     * - tags 为 JSON 字符串（string[]），SQL 层无法按单个 tag 过滤；
     * - price 用 REAL ⚠️ 浮点存钱有精度风险，结算场景建议改为分单位 INTEGER；
     * - 联合索引 (tenant_id, category) 遵循最左前缀：
     *   ✅ tenant_id 单独可命中，❌ 单独 category 不可命中。
     */
    db.run(sql`CREATE TABLE IF NOT EXISTS products (
		id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		name TEXT NOT NULL,
		category TEXT NOT NULL,
		price REAL NOT NULL,
		tags TEXT NOT NULL,
		stock INTEGER NOT NULL
	)`);
    db.run(sql`CREATE INDEX IF NOT EXISTS idx_products_tenant ON products (tenant_id, category)`);

    /**
     * 订单表。
     * - items 为 JSON 快照（OrderItem[]）：下单时固化商品信息，
     *   ⚠️ 无法直接对明细做 SQL 聚合统计；
     * - 时间字段为 ISO 8601 UTC 文本，必须统一时区否则排序错乱；
     * - delivered_at 可空：未送达为 NULL（延迟赋值字段）。
     */
    db.run(sql`CREATE TABLE IF NOT EXISTS orders (
		id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		status TEXT NOT NULL,
		items TEXT NOT NULL,
		delivered_at TEXT,
		created_at TEXT NOT NULL
	)`);
    // 支撑高频查询："某租户某用户的订单列表"
    db.run(sql`CREATE INDEX IF NOT EXISTS idx_orders_tenant_user ON orders (tenant_id, user_id)`);

    /**
     * 退货申请表 —— 幂等写入的核心载体。
     * 唯一索引 uniq_tenant_idem (tenant_id, idempotency_key) 是"最后防线"：
     * 重复提交触发 SQLITE_CONSTRAINT_UNIQUE，上层捕获后转为
     * "查询并返回已有记录"，对调用方表现为幂等成功。
     */
    db.run(sql`CREATE TABLE IF NOT EXISTS return_requests (
		id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		order_id TEXT NOT NULL,
		sku TEXT NOT NULL,
		reason TEXT NOT NULL,
		status TEXT NOT NULL,
		idempotency_key TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`);
    // 幂等兜底唯一索引：同租户同幂等键只允许一行
    db.run(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_idem ON return_requests (tenant_id, idempotency_key)`,
    );

    /**
     * 政策/条款表：租户级知识内容。
     * ⚠️ 无版本/生效时间字段，更新即覆盖，历史不可追溯。
     */
    db.run(sql`CREATE TABLE IF NOT EXISTS policies (
		id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		title TEXT NOT NULL,
		content TEXT NOT NULL
	)`);
    db.run(sql`CREATE INDEX IF NOT EXISTS idx_policies_tenant ON policies (tenant_id)`);

    /**
     * 记忆表（AI/Agent 用户记忆存储）。
     *
     * 两个索引各司其职，⚠️ 顺序敏感（UNIQUE 需先建，写入路径依赖它做
     * upsert 冲突检测）：
     * 1. uniq_mem_scope (tenant_id, user_id, kind, key) —— 语义唯一键：
     *    配合 `ON CONFLICT (tenant_id, user_id, kind, key) DO UPDATE`
     *    实现"不存在则插入，存在则更新"的 upsert，防止记忆碎片化。
     *    ⚠️ 冲突目标必须精确写这四列，列序/列名不一致则 upsert 不生效。
     * 2. idx_mem_lookup (tenant_id, user_id, kind, expires_at) —— 读路径：
     *    "取某用户某类未过期记忆"时，前三列精确定位，expires_at 在
     *    索引内完成 `IS NULL OR > now` 的范围过滤。
     * ⚠️ expires_at 只是软标记，过期数据不会自动消失，需要定时 TTL
     * 清理任务（SQLite 不支持 TTL），且注意 NULL（永不过期）的比较语义。
     */
    db.run(sql`CREATE TABLE IF NOT EXISTS memories (
		id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		confidence REAL NOT NULL,
		source_thread_id TEXT,
		source_request_id TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		expires_at TEXT,
		tags TEXT NOT NULL
	)`);
    // upsert 语义键：同租户同用户同类同 key 只有一行
    db.run(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_mem_scope ON memories (tenant_id, user_id, kind, key)`,
    );
    // 检索路径：按 (tenant, user, kind, expires_at) 过滤
    db.run(
        sql`CREATE INDEX IF NOT EXISTS idx_mem_lookup ON memories (tenant_id, user_id, kind, expires_at)`,
    );
}
