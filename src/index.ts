/**
 * 唯一允许组装依赖的地方
 */

import { loadConfig } from './config/env.js';
import { createLogger } from './logger/logger.js';

async function main(): Promise<void> {
    console.log('Hello Agent!');

    const cfg = loadConfig({});

    const logLevel = cfg.logLevel;
    const logger = createLogger(logLevel);

    // 启动日志：进程级事件直接用根 logger
    logger.info({ port: cfg.server.port, mode: cfg.agent.mode }, 'shoppilot starting');
}

main();
