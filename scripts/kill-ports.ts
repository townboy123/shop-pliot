// /**
//  * 一键释放项目占用的端口（Windows：netstat -ano 定位 PID → taskkill 结束进程；
//  * macOS/Linux 回退 lsof + kill）。
//  *
//  * 用法：
//  *   npm run ports:kill            # 释放默认端口 3000(API) 5173(web dev)
//  *   npm run ports:kill -- 3000    # 释放自定义端口（可多个）
//  *   npm run ports:list            # 只查看占用，不杀进程
//  *
//  * 也可被其他脚本引用：await import('./kill-ports.js').then(m => m.killPorts([3000]))
//  *
//  * 设计说明：
//  * - LISTENING 才算"占用"：TIME_WAIT 行的 PID 恒为 0（无进程可杀），直接过滤；
//  * - 跳过当前进程自身（防止脚本误杀自己）；
//  * - execFileSync 退出码非 0 时会抛错，但 stdout 往往仍有内容（如 netstat 的
//  *   "尚未运行"提示），因此 run() 捕获后返回 stdout 而非中断。
//  */
// import { execFileSync } from 'node:child_process';

// /** 项目默认端口：3000 = 后端 API；5173 = web 前端 vite dev */
// export const DEFAULT_PORTS = [3000, 5173];

// export interface PortOccupant {
// 	port: number;
// 	pid: number;
// 	processName: string;
// }

// /** 同步执行并容忍非零退出码（stdout 里常有需要的内容） */
// function run(cmd: string, args: string[]): string {
// 	try {
// 		return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true });
// 	} catch (err) {
// 		const e = err as { stdout?: string };
// 		return e.stdout ?? '';
// 	}
// }

// /** tasklist CSV 首字段即映像名："chrome.exe","12345",... */
// function processNameOf(pid: number): string {
// 	const out = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).trim();
// 	const m = out.match(/"([^"]+)"/);
// 	return m?.[1] ?? 'unknown';
// }

// // ---------------- Windows 实现 ----------------

// /** netstat -ano 行：TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  12345 */
// function findOccupantsWin(ports: number[]): PortOccupant[] {
// 	const wanted = new Set(ports);
// 	const occupants: PortOccupant[] = [];
// 	for (const line of run('netstat', ['-ano', '-p', 'tcp']).split(/\r?\n/)) {
// 		const cols = line.trim().split(/\s+/);
// 		if (cols.length < 5 || cols[0] !== 'TCP') continue;
// 		const local = cols[1] ?? '';
// 		const state = cols[3] ?? '';
// 		const pid = Number(cols[4]);
// 		// 只认 LISTENING；TIME_WAIT 的 PID 恒为 0，无进程可杀
// 		if (state !== 'LISTENING' || !Number.isInteger(pid) || pid <= 0) continue;
// 		// IPv4 (0.0.0.0:3000) 与 IPv6 ([::]:3000) 都取最后一个冒号后的端口
// 		const port = Number(local.split(':').pop());
// 		if (!wanted.has(port)) continue;
// 		// 同一 PID 对同端口可能有多行（IPv4/IPv6 各一条），去重
// 		if (occupants.some((o) => o.port === port && o.pid === pid)) continue;
// 		occupants.push({ port, pid, processName: processNameOf(pid) });
// 	}
// 	return occupants;
// }

// function killOnWin(ports: number[], self: number): PortOccupant[] {
// 	const killed: PortOccupant[] = [];
// 	for (const occ of findOccupantsWin(ports)) {
// 		if (occ.pid === self) continue;
// 		try {
// 			// /T 连同子进程树一起结束（vite 的 node 子进程不会被遗留）
// 			execFileSync('taskkill', ['/F', '/T', '/PID', String(occ.pid)], { windowsHide: true, stdio: 'ignore' });
// 			killed.push(occ);
// 		} catch {
// 			// 杀不掉（权限不足/已退出）则跳过，由调用方提示
// 		}
// 	}
// 	return killed;
// }

// // ---------------- macOS / Linux 回退 ----------------

// function findOccupantsUnix(ports: number[]): PortOccupant[] {
// 	const occupants: PortOccupant[] = [];
// 	for (const port of ports) {
// 		// lsof -nP -iTCP:3000 -sTCP:LISTEN → COMMAND PID USER ... (每行一个进程)
// 		for (const line of run('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN']).split(/\r?\n/).slice(1)) {
// 			const cols = line.trim().split(/\s+/);
// 			const pid = Number(cols[1]);
// 			const name = cols[0];
// 			if (!Number.isInteger(pid) || pid <= 0 || !name) continue;
// 			if (occupants.some((o) => o.port === port && o.pid === pid)) continue;
// 			occupants.push({ port, pid, processName: name });
// 		}
// 	}
// 	return occupants;
// }

// function killOnUnix(ports: number[], self: number): PortOccupant[] {
// 	const killed: PortOccupant[] = [];
// 	for (const occ of findOccupantsUnix(ports)) {
// 		if (occ.pid === self) continue;
// 		try {
// 			execFileSync('kill', ['-9', String(occ.pid)], { stdio: 'ignore' });
// 			killed.push(occ);
// 		} catch {
// 			// 杀不掉则跳过
// 		}
// 	}
// 	return killed;
// }

// // ---------------- 对外 API（平台自动分派） ----------------

// const isWindows = process.platform === 'win32';

// /** 查询哪些端口被占用、占用进程是什么 */
// export function findOccupants(ports: number[]): PortOccupant[] {
// 	return isWindows ? findOccupantsWin(ports) : findOccupantsUnix(ports);
// }

// /** 结束占用指定端口的进程（跳过当前进程自身），返回被杀掉的条目 */
// export function killPorts(ports: number[]): PortOccupant[] {
// 	return isWindows ? killOnWin(ports, process.pid) : killOnUnix(ports, process.pid);
// }

// // ---------------- CLI 入口 ----------------

// const isMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/kill-ports.ts');
// if (isMain) {
// 	const argRaw = process.argv.slice(2);
// 	const listOnly = argRaw.includes('--list') || process.env['PORTS_MODE'] === 'list';
// 	const argPorts = argRaw
// 		.filter((a) => /^\d+$/.test(a))
// 		.map(Number)
// 		.filter((n) => n > 0 && n < 65536);
// 	const ports = argPorts.length > 0 ? argPorts : DEFAULT_PORTS;

// 	const occupants = findOccupants(ports);
// 	if (occupants.length === 0) {
// 		console.log(`端口 ${ports.join(' ')} 均空闲`);
// 	} else {
// 		console.log('当前占用：');
// 		for (const o of occupants) console.log(`  :${o.port}  PID ${o.pid}  ${o.processName}`);
// 		if (!listOnly) {
// 			const killed = killPorts(ports);
// 			if (killed.length === 0) {
// 				console.error('未能结束任何进程（可能需要管理员权限）');
// 				process.exitCode = 1;
// 			} else {
// 				for (const o of killed) console.log(`已结束 :${o.port} ← PID ${o.pid} (${o.processName})`);
// 			}
// 		}
// 	}
// }

/**
 * 一键释放项目占用的端口（Windows：netstat -ano 定位 PID → taskkill 结束进程；
 * macOS/Linux 回退 lsof + kill）。
 *
 * 相比旧版的修复：
 * 1. taskkill 失败不再静默吞掉——捕获 stderr 并打印真实原因；
 * 2. Windows 增加 PowerShell Stop-Process 兜底（taskkill 被挡时再试一次）；
 * 3. 杀完等待端口释放并重新扫描验证，必要时重试；
 * 4. 识别 WSL 代理占用（wslrelay/wslhost）并给出 `wsl --shutdown` 提示；
 * 5. 权限不足时提示用管理员终端。
 *
 * 用法：
 *   npm run ports:kill            # 释放默认端口 3000(API) 5173(web dev)
 *   npm run ports:kill -- 3000    # 释放自定义端口（可多个）
 *   npm run ports:kill -- --list  # 只查看占用，不杀进程
 *
 * 也可被其他脚本引用：
 *   const { killPortsDetailed } = await import('./kill-ports.js');
 *   const report = killPortsDetailed([3000, 5173]);
 */

/**
 * 一键释放项目占用的端口（Windows：netstat -ano 定位 PID → taskkill 结束进程；
 * macOS/Linux 回退 lsof + kill）。
 *
 * 相比旧版的修复：
 * 1. 【核心】netstat 不再用 '-p tcp' 过滤——该过滤在部分 Windows 环境下会漏掉
 *    IPv6 监听行（如 [::1]:5173，vite 常见绑定方式），导致"均空闲"误报；
 *    '-ano' 本身已列出全部 TCP+UDP，下方 cols[0] !== 'TCP' 判断会滤掉 UDP；
 * 2. taskkill 失败不再静默吞掉——捕获 stderr 并打印真实原因；
 * 3. Windows 增加 PowerShell Stop-Process 兜底（taskkill 被挡时再试一次）；
 * 4. 杀完等待端口释放并重新扫描验证（终验），必要时重试；
 * 5. 识别 WSL 代理占用（wslrelay/wslhost）并给出 `wsl --shutdown` 提示；
 * 6. 查不到占用时自动检查 winNAT/Hyper-V 保留端口段（netstat 无进程但 bind 失败的元凶）；
 * 7. --diag 可查看占用进程的完整启动命令行（排查"幽灵进程"自动重启）。
 *
 * 用法：
 *   npm run ports:kill                 # 释放默认端口 3000(API) 5173(web dev)
 *   npm run ports:kill -- 3000 5173    # 释放自定义端口（可多个）
 *   npm run ports:kill -- --list       # 只查看占用，不杀进程
 *   npm run ports:kill -- --diag       # 杀完仍占用时，打印进程完整命令行
 *
 * 也可被其他脚本引用：
 *   const { killPortsDetailed } = await import('./kill-ports.js');
 *   const report = killPortsDetailed([3000, 5173]);
 */
import { execFileSync } from 'node:child_process';

/** 项目默认端口：3000 = 后端 API；5173 = web 前端 vite dev */
export const DEFAULT_PORTS = [3000, 5173];

export interface PortOccupant {
    port: number;
    pid: number;
    processName: string;
}

export interface KillFailure extends PortOccupant {
    /** taskkill / kill 的原始错误信息 */
    reason: string;
}

export interface KillReport {
    killed: PortOccupant[];
    failed: KillFailure[];
    /** 全部重试后仍处于 LISTENING 的端口（终验结果） */
    stillOccupied: PortOccupant[];
}

/** 同步执行并容忍非零退出码，同时保留 stdout 与 stderr */
function run(cmd: string, args: string[]): { stdout: string; stderr: string; ok: boolean } {
    try {
        const stdout = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true });
        return { stdout, stderr: '', ok: true };
    } catch (err) {
        const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
        const toStr = (v?: string | Buffer) => (v ? v.toString().trim() : '');
        return { stdout: toStr(e.stdout), stderr: toStr(e.stderr), ok: false };
    }
}

/** 同步 sleep（不引入定时器，保持脚本简单可预测） */
function wait(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** tasklist CSV 首字段即映像名："chrome.exe","12345",... */
function processNameOf(pid: number): string {
    const out = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).stdout.trim();
    const m = out.match(/"([^"]+)"/);
    return m?.[1] ?? 'unknown';
}

// ---------------- Windows 实现 ----------------

/**
 * netstat -ano 行示例：
 *   TCP    0.0.0.0:3000           0.0.0.0:0             LISTENING       12345
 *   TCP    [::1]:5173             [::]:0                LISTENING       25392   ← IPv6 也能抓到
 */
function findOccupantsWin(ports: number[]): PortOccupant[] {
    const wanted = new Set(ports);
    const occupants: PortOccupant[] = [];
    // 关键修复：不再使用 ['-ano', '-p', 'tcp']——'-p tcp' 在部分环境下不含 IPv6(tcpv6) 行，
    // 而 vite 常只监听 [::1]，会漏判。'-ano' 全量输出即可，下方 cols[0] !== 'TCP' 已滤掉 UDP。
    for (const line of run('netstat', ['-ano']).stdout.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5 || cols[0] !== 'TCP') continue;
        const local = cols[1] ?? '';
        const state = cols[3] ?? '';
        const pid = Number(cols[4]);
        // 只认 LISTENING；TIME_WAIT 的 PID 恒为 0，无进程可杀
        if (state !== 'LISTENING' || !Number.isInteger(pid) || pid <= 0) continue;
        // IPv4 (0.0.0.0:3000) 与 IPv6 ([::]:3000 / [::1]:5173) 都取最后一个冒号后的端口
        const port = Number(local.split(':').pop());
        if (!wanted.has(port)) continue;
        // 同一 PID 对同端口可能有多行（IPv4/IPv6 各一条），去重
        if (occupants.some((o) => o.port === port && o.pid === pid)) continue;
        occupants.push({ port, pid, processName: processNameOf(pid) });
    }
    return occupants;
}

/** 结束单个进程：taskkill /F /T 失败时用 PowerShell Stop-Process 兜底 */
function killPidWin(pid: number): { ok: boolean; reason: string } {
    const t = run('taskkill', ['/F', '/T', '/PID', String(pid)]);
    if (t.ok) return { ok: true, reason: '' };

    // 兜底：某些环境下 taskkill 被拒（权限/会话隔离），PowerShell 再试一次
    const ps = run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Stop-Process -Id ${pid} -Force -ErrorAction Stop`,
    ]);
    if (ps.ok) return { ok: true, reason: '' };

    return { ok: false, reason: t.stderr || ps.stderr || 'taskkill 与 PowerShell 均失败' };
}

function killOnWin(
    ports: number[],
    self: number,
): { killed: PortOccupant[]; failed: KillFailure[] } {
    const killed: PortOccupant[] = [];
    const failed: KillFailure[] = [];
    for (const occ of findOccupantsWin(ports)) {
        if (occ.pid === self) continue;
        const r = killPidWin(occ.pid);
        if (r.ok) killed.push(occ);
        else failed.push({ ...occ, reason: r.reason });
    }
    return { killed, failed };
}

/** 查询 winNAT/Hyper-V 动态保留的 TCP 端口段，返回落在保留段内的目标端口 */
function findExcludedPortsWin(ports: number[]): number[] {
    // 输出数据行形如：  5152        -          5251
    const out = run('netsh', [
        'interface',
        'ipv4',
        'show',
        'excludedportrange',
        'protocol=tcp',
    ]).stdout;
    const blocked: number[] = [];
    for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s*-\s*(\d+)$/);
        if (!m) continue;
        const lo = Number(m[1]);
        const hi = Number(m[2]);
        for (const p of ports) {
            if (p >= lo && p <= hi && !blocked.includes(p)) blocked.push(p);
        }
    }
    return blocked;
}

/** 打印进程完整启动命令行（诊断"幽灵进程"：谁在反复拉起 vite） */
function printProcessCommandLineWin(pid: number): void {
    const ps = run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine`,
    ]);
    const cmd = ps.stdout.trim();
    if (cmd) console.log(`      启动命令：${cmd}`);
}

// ---------------- macOS / Linux 回退 ----------------

function findOccupantsUnix(ports: number[]): PortOccupant[] {
    const occupants: PortOccupant[] = [];
    for (const port of ports) {
        // lsof -nP -iTCP:3000 -sTCP:LISTEN → COMMAND PID USER ... (每行一个进程)
        const { stdout } = run('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN']);
        for (const line of stdout.split(/\r?\n/).slice(1)) {
            const cols = line.trim().split(/\s+/);
            const pid = Number(cols[1]);
            const name = cols[0] ?? '';
            if (!Number.isInteger(pid) || pid <= 0 || !name) continue;
            if (occupants.some((o) => o.port === port && o.pid === pid)) continue;
            occupants.push({ port, pid, processName: name });
        }
    }
    return occupants;
}

function killOnUnix(
    ports: number[],
    self: number,
): { killed: PortOccupant[]; failed: KillFailure[] } {
    const killed: PortOccupant[] = [];
    const failed: KillFailure[] = [];
    for (const occ of findOccupantsUnix(ports)) {
        if (occ.pid === self) continue;
        const r = run('kill', ['-9', String(occ.pid)]);
        if (r.ok) killed.push(occ);
        else failed.push({ ...occ, reason: r.stderr || 'kill 失败' });
    }
    return { killed, failed };
}

// ---------------- 对外 API（平台自动分派） ----------------

const isWindows = process.platform === 'win32';

/** 查询哪些端口被占用、占用进程是什么 */
export function findOccupants(ports: number[]): PortOccupant[] {
    return isWindows ? findOccupantsWin(ports) : findOccupantsUnix(ports);
}

/**
 * 结束占用指定端口的进程（跳过当前进程自身）。
 * 内置重试 + 终验：杀完后重新扫描，仍 LISTENING 的端口会出现在 stillOccupied 里。
 */
export function killPortsDetailed(ports: number[], retries = 3): KillReport {
    const killed: PortOccupant[] = [];
    let failed: KillFailure[] = [];

    for (let attempt = 1; attempt <= retries; attempt++) {
        const r = isWindows ? killOnWin(ports, process.pid) : killOnUnix(ports, process.pid);
        killed.push(...r.killed);
        failed = r.failed;
        if (failed.length === 0) break;
        // 端口释放/进程退出有短暂延迟，稍候再重试
        if (attempt < retries) wait(400);
    }

    // 终验：重新扫描（排除本次已确认杀掉的、以及自身）
    const done = new Set(killed.map((k) => `${k.port}:${k.pid}`));
    const stillOccupied = findOccupants(ports).filter(
        (o) => !done.has(`${o.port}:${o.pid}`) && o.pid !== process.pid,
    );
    return { killed, failed, stillOccupied };
}

/** 兼容旧签名：只返回成功杀掉的条目 */
export function killPorts(ports: number[]): PortOccupant[] {
    return killPortsDetailed(ports).killed;
}

// ---------------- CLI 入口 ----------------

const isMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/kill-ports.ts');
if (isMain) {
    const argRaw = process.argv.slice(2);
    const listOnly = argRaw.includes('--list') || process.env['PORTS_MODE'] === 'list';
    const diag = argRaw.includes('--diag') || argRaw.includes('--diagnose');
    const argPorts = argRaw
        .filter((a) => /^\d+$/.test(a))
        .map(Number)
        .filter((n) => n > 0 && n < 65536);
    const ports = argPorts.length > 0 ? argPorts : DEFAULT_PORTS;

    const occupants = findOccupants(ports);
    if (occupants.length === 0) {
        console.log(`端口 ${ports.join(' ')} 均空闲（netstat 未发现 LISTENING 进程，含 IPv6）`);

        // netstat 查不到 ≠ 端口可 bind：检查 winNAT/Hyper-V 保留段
        if (isWindows) {
            const blocked = findExcludedPortsWin(ports);
            if (blocked.length > 0) {
                console.error(
                    `⚠️  以下端口落在 winNAT/Hyper-V 保留段内，进程无法绑定：${blocked.join(', ')}`,
                );
                console.error(
                    '   立即修复（管理员 PowerShell）：net stop winnat && net start winnat',
                );
                console.error('   治本：netsh int ipv4 set dynamic tcp start=49152 num=16384');
                process.exitCode = 1;
            }
        }
    } else {
        console.log('当前占用：');
        for (const o of occupants) console.log(`  :${o.port}  PID ${o.pid}  ${o.processName}`);

        // --diag：查看占用进程的完整启动命令行（排查幽灵进程）
        if (diag && isWindows) {
            for (const o of occupants) printProcessCommandLineWin(o.pid);
        }

        if (!listOnly) {
            const report = killPortsDetailed(ports);

            for (const o of report.killed) {
                console.log(`已结束 :${o.port} ← PID ${o.pid} (${o.processName})`);
            }
            for (const f of report.failed) {
                console.error(`失败 :${f.port}  PID ${f.pid} (${f.processName}) — ${f.reason}`);
            }

            // —— 按失败原因给出针对性提示 ——
            if (report.failed.some((f) => /拒绝访问|access is denied|denied/i.test(f.reason))) {
                console.error(
                    '提示：权限不足。请用「管理员身份」打开终端重试（目标进程可能是在管理员终端里启动的）。',
                );
            }
            if (report.failed.some((f) => /wsl|vmmem/i.test(f.processName))) {
                console.error(
                    '提示：占用者疑似 WSL 代理进程（前端可能跑在 WSL 里）。请在 Windows 侧执行 `wsl --shutdown` 后重试。',
                );
            }
            if (report.killed.length > 0 && report.stillOccupied.length > 0) {
                console.error(
                    '提示：进程已结束但端口仍显示 LISTENING，通常是 TIME_WAIT 残留，几秒后会自动释放。',
                );
            }

            if (report.stillOccupied.length > 0) {
                console.error('以下端口终验后仍被占用：');
                for (const o of report.stillOccupied) {
                    console.error(`  :${o.port}  PID ${o.pid}  ${o.processName}`);
                    if (diag && isWindows) printProcessCommandLineWin(o.pid);
                }
                console.error(
                    '提示：PID 变了说明有父进程在自动重启它，加 --diag 查看启动命令定位来源。',
                );
                process.exitCode = 1;
            }
        }
    }
}
