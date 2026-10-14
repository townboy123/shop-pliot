import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    test: {
        environment: 'node',
        globals: false,
        include: ['src/tests/**/*.test.ts'],
        exclude: ['node_modules', 'dist'],

        // 每个测试文件独立模块图，避免 Graph/Checkpointer 单例串号
        isolate: true,

        // 端到端测试（含 FakeModel 驱动整图）可能较慢
        testTimeout: 20_000,
        hookTimeout: 20_000,

        // 顺序执行：规避 SQLite 文件锁竞争与假时钟全局污染
        pool: 'forks',

        fileParallelism: false,

        setupFiles: ['src/tests/helpers/setup.ts'],

        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            reportsDirectory: './coverage',
            include: ['src/**/*.ts'],
            exclude: [
                'src/**/*.d.ts',
                'src/index.ts',
                'src/tests/**',
                'src/db/seed.ts',
                'src/db/schema.ts',
                'src/observability/**',
                'src/adapters/retriever/lancedb.ts',
                'src/adapters/memory/lancedb-retriever.ts',
                'src/mcp/server.ts',
            ],
            // §3 目录要求 ≥ 70%
            thresholds: {
                lines: 70,
                functions: 70,
                branches: 70,
                statements: 70,
            },
        },
    },
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
});
