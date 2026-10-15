import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/db/client.js';
import { loadConfig } from '../src/config/env.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(process.env);
const dbPath = path.isAbsolute(cfg.dbPath) ? cfg.dbPath : path.join(__dirname, '..', cfg.dbPath);

/** 复用带 PRAGMA 的连接工厂 */
const db = createDb(dbPath);
migrate(db, { migrationsFolder: './drizzle' });
console.log('迁移完成');
