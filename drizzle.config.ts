import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';
import { loadConfig } from './src/config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(process.env); // 复用同一入口：校验 + 默认值都只有一份

export default defineConfig({
    schema: './src/db/schema.ts',
    out: './drizzle',
    dialect: 'sqlite',
    dbCredentials: {
        // 锚定项目根：loadConfig 的相对路径 './data/...' 是相对 CWD 的，
        // 而 drizzle-kit 命令几乎总在项目根执行，语义一致；这里显式 join 一次，双保险
        url: path.isAbsolute(cfg.dbPath) ? cfg.dbPath : path.join(__dirname, cfg.dbPath),
    },
    verbose: true,
    strict: true,
});
