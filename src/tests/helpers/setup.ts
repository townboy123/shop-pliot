/**
 * vitest 全局 setup：静音测试日志（pino 仍可用 debug 排查失败用例）。
 */
process.env['LOG_LEVEL_SILENT'] = '1';
