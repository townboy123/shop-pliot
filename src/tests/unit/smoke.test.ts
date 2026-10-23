import { describe, expect, it } from 'vitest';

describe('M0 工程底盘', () => {
    it('vitest 可运行，TS strict 下的基础断言成立', () => {
        const ports: number[] = [3000, 5173];
        expect(ports).toHaveLength(2);
    });
});
