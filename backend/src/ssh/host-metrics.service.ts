import { Client } from 'ssh2';

/**
 * Periodically samples resource usage of the host a terminal session is
 * connected to and reports it back over the same SSH connection.
 *
 * The sample runs on a separate exec channel, so it never writes into the
 * interactive shell the user is typing in. Everything is read straight out of
 * /proc plus one df call: no agent on the remote side, no extra credentials,
 * and nothing to install.
 *
 * Counters in /proc are monotonic totals, so CPU load and network throughput
 * only become meaningful once two samples exist. The first tick therefore
 * reports memory, disk and load only, and rates appear from the second tick on.
 */

const SAMPLE_COMMAND = [
    'LC_ALL=C',
    "echo '#stat'",
    'head -n 1 /proc/stat',
    "echo '#cpus'",
    "grep -c '^processor' /proc/cpuinfo",
    "echo '#mem'",
    "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
    "echo '#net'",
    'cat /proc/net/dev',
    "echo '#load'",
    'cat /proc/loadavg',
    "echo '#up'",
    'cat /proc/uptime',
    "echo '#disk'",
    'df -P -k',
    "echo '#end'",
].join('; ') + ' 2>/dev/null';

/** Pseudo-filesystems that would otherwise show up as 100% full and scare people. */
const IGNORED_FS = /^(tmpfs|devtmpfs|udev|none|squashfs|efivarfs|overlay$)/;
const IGNORED_MOUNT = /^\/(proc|sys|dev|run|snap|var\/lib\/docker)(\/|$)/;

interface CpuSample { total: number; idle: number; }
interface NetSample { rx: number; tx: number; }

export interface HostMetrics {
    ok: boolean;
    reason?: string;
    at: number;
    cpu?: { usagePct: number | null; cores: number | null; load1: number; load5: number; load15: number };
    mem?: { totalKb: number; usedKb: number; usagePct: number };
    swap?: { totalKb: number; usedKb: number; usagePct: number } | null;
    net?: { rxBytesPerSec: number; txBytesPerSec: number } | null;
    disk?: { mount: string; totalKb: number; usedKb: number; usagePct: number } | null;
    diskWorst?: { mount: string; usagePct: number } | null;
    uptimeSec?: number;
}

export class HostMetricsCollector {
    private timer: NodeJS.Timeout | null = null;
    private busy = false;
    private stopped = false;
    private failures = 0;

    private prevCpu: CpuSample | null = null;
    private prevNet: NetSample | null = null;
    private prevAt = 0;

    constructor(
        private readonly ssh: Client,
        private readonly emit: (metrics: HostMetrics) => void,
        private readonly intervalMs = 5000,
    ) { }

    start() {
        if (this.timer || this.stopped) return;
        // Fire once straight away so the bar fills in instead of sitting empty
        // for the first interval, then settle into the regular cadence.
        this.sample();
        this.timer = setInterval(() => this.sample(), this.intervalMs);
    }

    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private sample() {
        if (this.busy || this.stopped) return;
        this.busy = true;

        this.ssh.exec(SAMPLE_COMMAND, (err, stream) => {
            if (err || !stream) {
                this.busy = false;
                this.giveUpAfterRepeatedFailures('exec failed');
                return;
            }

            let out = '';
            stream.on('data', (chunk: Buffer) => {
                // A well-behaved host answers in a few kilobytes. Anything far
                // beyond that is not our sample, so stop accumulating.
                if (out.length < 256 * 1024) out += chunk.toString('utf-8');
            });
            stream.stderr.on('data', () => { /* ignored: missing files are expected on non-Linux */ });
            stream.on('close', () => {
                this.busy = false;
                if (this.stopped) return;
                try {
                    const metrics = this.parse(out);
                    if (metrics) {
                        this.failures = 0;
                        this.emit(metrics);
                    } else {
                        this.giveUpAfterRepeatedFailures('unsupported');
                    }
                } catch {
                    this.giveUpAfterRepeatedFailures('parse failed');
                }
            });
        });
    }

    /**
     * A host without /proc (BSD, macOS, a locked-down appliance) will never
     * start working, so stop bothering it and tell the UI once.
     */
    private giveUpAfterRepeatedFailures(reason: string) {
        if (this.stopped) return;
        this.failures += 1;
        if (this.failures < 3) return;
        this.stop();
        this.emit({ ok: false, reason, at: Date.now() });
    }

    private parse(raw: string): HostMetrics | null {
        if (!raw.includes('#end')) return null;

        const sections = this.splitSections(raw);
        const statLine = (sections.stat || [])[0];
        if (!statLine || !statLine.startsWith('cpu')) return null;

        const now = Date.now();
        const elapsedSec = this.prevAt ? (now - this.prevAt) / 1000 : 0;

        const cpuSample = this.parseCpu(statLine);
        let usagePct: number | null = null;
        if (cpuSample && this.prevCpu) {
            const dTotal = cpuSample.total - this.prevCpu.total;
            const dIdle = cpuSample.idle - this.prevCpu.idle;
            // Counters reset when the host reboots; a negative delta means exactly that.
            if (dTotal > 0 && dIdle >= 0) {
                usagePct = round1(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)));
            }
        }

        const netSample = this.parseNet(sections.net || []);
        let net: HostMetrics['net'] = null;
        if (netSample && this.prevNet && elapsedSec > 0) {
            const dRx = netSample.rx - this.prevNet.rx;
            const dTx = netSample.tx - this.prevNet.tx;
            if (dRx >= 0 && dTx >= 0) {
                net = {
                    rxBytesPerSec: Math.round(dRx / elapsedSec),
                    txBytesPerSec: Math.round(dTx / elapsedSec),
                };
            }
        }

        const mem = this.parseMem(sections.mem || []);
        if (!mem) return null;

        const load = (sections.load || [])[0]?.trim().split(/\s+/) || [];
        const cores = parseInt((sections.cpus || [])[0] ?? '', 10);
        const disks = this.parseDisks(sections.disk || []);

        this.prevCpu = cpuSample;
        this.prevNet = netSample;
        this.prevAt = now;

        return {
            ok: true,
            at: now,
            cpu: {
                usagePct,
                cores: Number.isFinite(cores) && cores > 0 ? cores : null,
                load1: toNum(load[0]),
                load5: toNum(load[1]),
                load15: toNum(load[2]),
            },
            mem: mem.mem,
            swap: mem.swap,
            net,
            disk: disks.root,
            diskWorst: disks.worst,
            uptimeSec: Math.round(toNum(((sections.up || [])[0] || '').trim().split(/\s+/)[0])),
        };
    }

    private splitSections(raw: string): Record<string, string[]> {
        const sections: Record<string, string[]> = {};
        let current = '';
        for (const line of raw.split('\n')) {
            const trimmed = line.replace(/\r$/, '');
            if (trimmed.startsWith('#')) {
                current = trimmed.slice(1).trim();
                if (current !== 'end') sections[current] = [];
                continue;
            }
            if (current && current !== 'end' && sections[current]) sections[current].push(trimmed);
        }
        return sections;
    }

    private parseCpu(line: string): CpuSample | null {
        const parts = line.trim().split(/\s+/).slice(1).map(Number);
        if (parts.length < 5 || parts.some((n) => !Number.isFinite(n))) return null;
        const total = parts.reduce((a, b) => a + b, 0);
        const idle = parts[3] + parts[4]; // idle + iowait
        return { total, idle };
    }

    private parseNet(lines: string[]): NetSample | null {
        let rx = 0;
        let tx = 0;
        let seen = false;
        for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx < 0) continue;
            const iface = line.slice(0, idx).trim();
            if (!iface || iface === 'lo') continue;
            const nums = line.slice(idx + 1).trim().split(/\s+/).map(Number);
            if (nums.length < 9 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[8])) continue;
            rx += nums[0];
            tx += nums[8];
            seen = true;
        }
        return seen ? { rx, tx } : null;
    }

    private parseMem(lines: string[]) {
        const vals: Record<string, number> = {};
        for (const line of lines) {
            const m = line.match(/^(\w+):\s+(\d+)/);
            if (m) vals[m[1]] = Number(m[2]);
        }
        const total = vals.MemTotal;
        const available = vals.MemAvailable;
        if (!total || available === undefined) return null;

        const used = Math.max(0, total - available);
        const swapTotal = vals.SwapTotal || 0;
        const swapUsed = Math.max(0, swapTotal - (vals.SwapFree || 0));

        return {
            mem: { totalKb: total, usedKb: used, usagePct: round1((used / total) * 100) },
            swap: swapTotal > 0
                ? { totalKb: swapTotal, usedKb: swapUsed, usagePct: round1((swapUsed / swapTotal) * 100) }
                : null,
        };
    }

    private parseDisks(lines: string[]) {
        let root: HostMetrics['disk'] = null;
        let worst: { mount: string; usagePct: number } | null = null;

        for (const line of lines.slice(1)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 6) continue;
            const [fs, totalStr, usedStr] = parts;
            const capacity = parts[4];
            const mount = parts.slice(5).join(' ');
            const totalKb = Number(totalStr);
            const usedKb = Number(usedStr);
            const usagePct = Number(String(capacity).replace('%', ''));
            if (!Number.isFinite(totalKb) || totalKb <= 0 || !Number.isFinite(usagePct)) continue;
            if (IGNORED_FS.test(fs) || IGNORED_MOUNT.test(mount)) continue;

            if (mount === '/') root = { mount, totalKb, usedKb, usagePct };
            if (!worst || usagePct > worst.usagePct) worst = { mount, usagePct };
        }

        // The worst mount is only interesting when it is not the one already shown.
        if (worst && root && worst.mount === root.mount) worst = null;
        return { root, worst };
    }
}

function round1(n: number) {
    return Math.round(n * 10) / 10;
}

function toNum(v: any) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
