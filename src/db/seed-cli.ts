/**
 * db:seed 的 CLI 入口。
 *
 * 职责划分：
 * - 本文件只做"入口编排"：读配置 → 解析路径 → 建连接 → 播种 → 关闭；
 * - 播种逻辑（建表/预检/数据内容）全部在 seed.ts 的 seedDemoData 里，
 *   CLI 和测试共用同一份。
 *
 * ⚠️ 错误处理策略：不做 try/catch 吞异常。任何一步失败都让异常
 * 直接抛出 → 进程非零退出 → npm / CI 能感知失败。
 */
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemoData } from './seed.js';
import { loadConfig } from '@/config/env.js';
import { createDb, closeDb } from './client.js';

// ── 1. 解析数据库路径 ─────────────────────────────
// 相对路径锚定到项目根（本文件在 src/db/ 下，向上两级），
// 不依赖运行时的 CWD —— 否则在子目录跑命令会连到不同的库。
const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(process.env);
const dbPath = nodePath.isAbsolute(cfg.dbPath)
    ? cfg.dbPath
    : nodePath.join(__dirname, '../..', cfg.dbPath);

// ── 2. 连接（含建库） ─────────────────────────────
// createDb 内部：目录兜底创建、WAL、foreign_keys PRAGMA。
// 文件不存在时 SQLite 自动新建 —— 日志只是告诉你走的是哪条分支。
const dbExists = fs.existsSync(dbPath);
console.log(
    dbExists
        ? `ℹ️  [1/3] 数据库已存在，直接复用: ${dbPath}`
        : `🆕 [1/3] 数据库不存在，将新建: ${dbPath}`,
);

const db = createDb(dbPath);
console.log('✅ [2/3] 连接成功（WAL + foreign_keys 已启用）');

// ── 3. 播种 ──────────────────────────────────────
// seedDemoData 内部：ensureSchema → isSeeded 预检 → 事务播种。
// 已播种时内部打印"跳过"，重复跑天然无害。
await seedDemoData(db);
console.log('✅ [3/3] 播种流程完成');

// ── 4. 收尾 ──────────────────────────────────────
// closeDb：WeakMap 查到底层 sqlite 实例并 close，
// 自动触发 WAL checkpoint，-wal 合并回主文件，目录不留残留。
closeDb(db);
console.log('🏁 done');
