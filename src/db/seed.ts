/**
 * 演示数据种子。
 *
 * 设计意图：
 * - 预置 2 租户 × 每租户 2 用户：横向越权测试依赖"同租户其他用户"与
 *   "跨租户"两类对手（adversary）：
 *   · u2 对 u1 —— 同租户越权（应拒绝访问他人订单）；
 *   · u3/t2 对 u1/t1 —— 跨租户越权（应完全不可见）。
 *   ⚠️ 越权测试的核心是"应查不到"，种子必须保证对手视角下
 *   目标数据存在但不可达，测试断言才有意义。
 * - 订单时间相对 SEED_BASE_TIME 展开（deliveredAt 在窗口内/外各一单），
 *   让退货资格判定的 out_of_window / not_delivered 分支都可直接测：
 *   · o1 签收 3 天 → 窗口内 ✅ 可退；
 *   · o2 签收 20 天 → 超 7 天窗口 ❌ out_of_window；
 *   · o3 未签收（delivered_at 为 NULL）→ ❌ not_delivered；
 *   · o4 属于 t2 → 跨租户对照（u1 视角不可见）。
 *   ⚠️ 测试里用 fixedClock 冻结时间为 SEED_BASE_TIME，避免真实时间
 *   流动导致"窗口内/外"随日期漂移而失效（非确定性测试的典型来源）。
 * - 幂等：全量 INSERT OR IGNORE，可重复调用不产生重复数据。
 *   ⚠️ OR IGNORE 是"静默跳过冲突"：主键重复时旧行原样保留，
 *   不会报错也不会更新 —— 这正是种子的期望行为；但如果你的种子
 *   需要"每次刷新为最新值"，应改用 INSERT ... ON CONFLICT DO UPDATE
 *   （upsert），两者语义不同，不要混淆。
 * - ⚠️ 顺序敏感：必须先 tenants → users → orders（及各表），后写的行
 *   引用先写的行的 id（虽然 schema 是逻辑外键，这里没有物理约束兜底，
 *   写错顺序不会报错，只会留下"指向空对象"的脏数据 —— 比报错更难查）。
 */
import { sql } from 'drizzle-orm';
import type { DB } from './client.js';
import { loadConfig } from '@/config/env.js';
import { createDb, ensureSchema } from './client.js';

/**
 * 基准时刻：2026-10-10T00:00:00.000Z。
 * 演示数据围绕它展开；测试通过 fixedClock 把"当前时间"冻结在这一刻，
 * 从而让相对时间窗口（如"签收后 7 天"）的判定结果永远确定。
 * ⚠️ 修改此值会破坏所有依赖相对时间差的测试预期，属于隐性契约。
 */
export const SEED_BASE_TIME = '2026-10-10T00:00:00.000Z';

/**
 * 预检：种子是否已完整写入。
 * 用"业务上必然存在的一组主键"做标记，比查行总数可靠
 * （将来加种子数据时，改这里即可）。
 */
function isSeeded(db: DB): boolean {
    const row = db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM tenants WHERE id IN ('t1', 't2')`,
    );
    return (row?.n ?? 0) >= 2;
}

/**
 * 写入演示数据（幂等，可重复调用）。
 *
 * 内部先调用 ensureSchema 保证表存在 —— 这样调用方只需一个入口，
 * 不必关心"先建表还是先播种"的顺序问题。
 * ⚠️ 幂等但不可重置：重复调用不会清空已有数据；若测试需要
 * "干净初始状态"，最简单的做法是每个用例新建 :memory: 库，
 * 而不是想办法"回滚"种子。
 *
 * @param db 已创建的业务库连接（内部会自动 ensureSchema）
 */
export async function seedDemoData(db: DB): Promise<void> {
    // 表结构层幂等：先保证表存在，后续 SELECT 预检才不会因表缺失报错
    ensureSchema(db);

    // 已完整播种 → 直接跳过（快速路径，避免无谓的写事务）
    if (isSeeded(db)) {
        console.log('ℹ️  种子数据已存在，跳过播种');
        return;
    }

    /**
     * 租户：t1（主测试租户）、t2（跨租户对手租户）。
     * INSERT OR IGNORE：再次调用时主键冲突静默跳过，保证幂等。
     */
    db.run(sql`INSERT OR IGNORE INTO tenants (id, name) VALUES
		('t1', '演示租户A'),
		('t2', '演示租户B')`);

    /** 用户：t1 有 u1/u2，t2 有 u3/u4。u1 是主视角用户，其余为越权测试对手 */
    db.run(sql`INSERT OR IGNORE INTO users (id, tenant_id, name, email) VALUES
		('u1', 't1', '用户一', 'u1@t1.example.com'),
		('u2', 't1', '用户二', 'u2@t1.example.com'),
		('u3', 't2', '用户三', 'u3@t2.example.com'),
		('u4', 't2', '用户四', 'u4@t2.example.com')`);

    /**
     * 商品：t1 有耳机/手机/键盘（覆盖多类目，供筛选类查询测试），
     * t2 有自己的商品集合 —— ⚠️ 两租户商品完全隔离，
     * t2 的商品对 t1 用户必须不可见（跨租户数据隔离测试点）。
     * tags 为 JSON 字符串数组，注意这里手工内联的 JSON 格式必须合法
     * （带双引号），写错不会在插入时报错，只会在读取 JSON.parse 时炸。
     */
    db.run(sql`INSERT OR IGNORE INTO products (id, tenant_id, name, category, price, tags, stock) VALUES
		('p1', 't1', 'AirPods Pro 2', '耳机', 1899, '["蓝牙","降噪","苹果"]', 50),
		('p2', 't1', '小米 Buds 4 Pro', '耳机', 899, '["蓝牙","降噪","安卓"]', 120),
		('p3', 't1', '漫步者 NeoBuds Pro', '耳机', 499, '["蓝牙","降噪","性价比"]', 200),
		('p4', 't1', 'iPhone 17', '手机', 5999, '["苹果","旗舰"]', 30),
		('p5', 't1', 'Keychron K3', '键盘', 399, '["机械","矮轴"]', 80),
		('p6', 't2', 'Buds 夹耳式耳机', '耳机', 299, '["蓝牙","开放式"]', 100),
		('p7', 't2', '氦刻 BW-1', '耳机', 459, '["蓝牙","头戴"]', 60)`);

    /**
     * 订单 —— 退货资格判定分支的"测试矩阵"：
     * - o1（u1，delivered，签收 3 天）→ 退货窗口内 ✅ 正常路径；
     * - o2（u1，delivered，签收 20 天）→ 超窗 ❌ out_of_window 分支；
     * - o3（u2，shipped，delivered_at=NULL）→ ❌ not_delivered 分支
     *   （同时覆盖"同租户其他用户"的越权访问目标）；
     * - o4（u3/t2，delivered）→ 跨租户对照，u1 视角应不可见。
     * items 为 JSON 明细快照，sku 直接复用商品 id（演示数据简化处理，
     * 生产中 sku 与商品 id 通常是不同编码体系）。
     */
    db.run(sql`INSERT OR IGNORE INTO orders (id, tenant_id, user_id, status, items, delivered_at, created_at) VALUES
		('o1', 't1', 'u1', 'delivered',
			'[{"sku":"p1","productId":"p1","qty":1},{"sku":"p5","productId":"p5","qty":2}]',
			'2026-10-07T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
		('o2', 't1', 'u1', 'delivered',
			'[{"sku":"p4","productId":"p4","qty":1}]',
			'2026-09-20T00:00:00.000Z', '2026-09-15T00:00:00.000Z'),
		('o3', 't1', 'u2', 'shipped',
			'[{"sku":"p2","productId":"p2","qty":1}]',
			NULL, '2026-10-05T00:00:00.000Z'),
		('o4', 't2', 'u3', 'delivered',
			'[{"sku":"p6","productId":"p6","qty":1}]',
			'2026-10-08T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`);

    /**
     * 政策：t1 四条（7天无理由 / 质量问题 / 退款时效 / 物流查询），
     * t2 一条（15天窗口）—— ⚠️ 两租户政策内容刻意不同：
     * 同样的"签收后 X 天可退"问题，t1 答 7 天、t2 答 15 天，
     * 用于验证 AI 回答/业务判定是按租户隔离的（防止政策串租户）。
     */
    db.run(sql`INSERT OR IGNORE INTO policies (id, tenant_id, title, content) VALUES
		('pol1', 't1', '七天无理由退货',
			'自商品签收之日起 7 天内，商品完好且不影响二次销售的，支持无理由退货。定制类商品、贴身衣物除外。退货需保证配件齐全。'),
		('pol2', 't1', '质量问题退货',
			'商品存在质量问题的，不受 7 天限制，签收后 30 天内可申请退货，运费由平台承担。需提供质量问题照片或检测凭证。'),
		('pol3', 't1', '退款时效',
			'退货申请审核通过后，退款将在仓库验收商品后 3 个工作日内原路退回。'),
		('pol4', 't1', '物流查询',
			'订单发货后可在订单详情查看物流单号与轨迹。签收后请在 7 天内验收，超期视为默认验收合格。'),
		('pol5', 't2', 'B租户退货政策',
			'自签收之日起 15 天内支持无理由退货，需保持商品原包装。')`);

    // return_requests / memories 初始为空：由业务流程与测试写入。
    // 这是刻意设计：这两张表的"写入路径"本身就是要测的行为
    // （幂等写入、upsert），预置数据反而会干扰断言。
}
