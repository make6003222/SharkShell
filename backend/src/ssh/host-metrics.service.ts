import { Client } from 'ssh2';

/**
 * Periodically samples resource usage of the host a terminal session is
 * connected to and reports it back over the same SSH connection.
 *
 * The sample runs on a separate exec channel, so it never writes into the
 * interactive shell the user is typing in. Linux is read from /proc, FreeBSD
 * and its relatives from sysctl, and both then use df: no agent on the remote
 * side, no extra credentials, and nothing to install.
 *
 * Those counters are monotonic totals, so processor load and network
 * throughput only become meaningful once two samples exist. The first tick
 * therefore reports memory, disk and load average only, and the two rates
 * appear from the second tick on.
 */

/**
 * One command that serves both families. Linux is read from /proc; anything
 * without it falls through to sysctl, which covers FreeBSD and its relatives.
 * df behaves the same on both, so it sits outside the branch.
 *
 * The sysctl names are queried WITH their labels rather than with -n: a name
 * missing on a given release (v_cache_count went away after FreeBSD 11) then
 * simply does not appear, instead of silently shifting every later value up
 * a line.
 */
const LINUX_BLOCK = [
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
].join('; ');

const BSD_BLOCK = [
    "echo '#bsd'",
    'sysctl hw.pagesize hw.physmem hw.ncpu kern.cp_time vm.loadavg kern.boottime'
    + ' vm.stats.vm.v_free_count vm.stats.vm.v_inactive_count'
    + ' vm.stats.vm.v_cache_count vm.stats.vm.v_laundry_count',
    "echo '#bsdswap'",
    'swapinfo -k',
    "echo '#bsdnet'",
    'netstat -bni',
].join('; ');

// Braces so the redirect covers every command, not just the last one: a host
// missing one of these tools should stay quiet rather than mix errors in.
const SAMPLE_COMMAND =
    '{ LC_ALL=C; '
    + "echo '#os'; uname -s; "
    + `if [ -r /proc/stat ]; then ${LINUX_BLOCK}; else ${BSD_BLOCK}; fi; `
    + "echo '#disk'; df -P -k; echo '#end'; } 2>/dev/null";

/** Pseudo-filesystems that would otherwise show up as 100% full and scare people. */
const IGNORED_FS = /^(tmpfs|devtmpfs|udev|none|squashfs|efivarfs|overlay$|devfs|procfs|fdescfs|linprocfs|linsysfs|map\b)/;
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
     * A host that exposes neither /proc nor the sysctl names we need (macOS, a
     * locked-down appliance, a restricted shell) will never start working, so
     * stop bothering it and tell the UI once.
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
        const isLinux = Array.isArray(sections.stat) && sections.stat.length > 0;
        const isBsd = Array.isArray(sections.bsd) && sections.bsd.length > 0;
        if (!isLinux && !isBsd) return null;

        return isLinux ? this.parseLinux(sections) : this.parseBsd(sections);
    }

    private parseLinux(sections: Record<string, string[]>): HostMetrics | null {
        const statLine = (sections.stat || [])[0];
        if (!statLine || !statLine.startsWith('cpu')) return null;

        const mem = this.parseMem(sections.mem || []);
        if (!mem) return null;

        const load = (sections.load || [])[0]?.trim().split(/\s+/) || [];

        return this.assemble({
            cpuSample: this.parseCpu(statLine),
            netSample: this.parseNetProc(sections.net || []),
            mem: mem.mem,
            swap: mem.swap,
            load: [toNum(load[0]), toNum(load[1]), toNum(load[2])],
            cores: parseInt((sections.cpus || [])[0] ?? '', 10),
            uptimeSec: Math.round(toNum(((sections.up || [])[0] || '').trim().split(/\s+/)[0])),
            diskLines: sections.disk || [],
        });
    }

    /**
     * FreeBSD and relatives: everything comes from sysctl, which prints
     * "name: value" lines, so values are looked up by name and a sysctl that
     * does not exist on this release is simply absent rather than shifting
     * the others.
     */
    private parseBsd(sections: Record<string, string[]>): HostMetrics | null {
        const sysctl: Record<string, string> = {};
        for (const line of sections.bsd || []) {
            const idx = line.indexOf(':');
            if (idx > 0) sysctl[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }

        // kern.cp_time is "user nice system interrupt idle" in ticks. There is
        // no iowait bucket, so idle is the single last figure.
        let cpuSample: CpuSample | null = null;
        const cpTime = (sysctl['kern.cp_time'] || '').trim().split(/\s+/).map(Number);
        if (cpTime.length >= 5 && cpTime.every((n) => Number.isFinite(n))) {
            cpuSample = {
                total: cpTime.reduce((a, b) => a + b, 0),
                idle: cpTime[cpTime.length - 1],
            };
        }

        const mem = this.parseBsdMem(sysctl, sections.bsdswap || []);
        if (!mem) return null;

        // vm.loadavg reads "{ 0.12 0.15 0.10 }"
        const load = (sysctl['vm.loadavg'] || '').replace(/[{}]/g, '').trim().split(/\s+/);

        // kern.boottime reads "{ sec = 1712345678, usec = 1234 } Thu Apr ..."
        let uptimeSec = 0;
        const boot = (sysctl['kern.boottime'] || '').match(/sec\s*=\s*(\d+)/);
        if (boot) uptimeSec = Math.max(0, Math.round(Date.now() / 1000 - Number(boot[1])));

        return this.assemble({
            cpuSample,
            netSample: this.parseNetstat(sections.bsdnet || []),
            mem: mem.mem,
            swap: mem.swap,
            load: [toNum(load[0]), toNum(load[1]), toNum(load[2])],
            cores: parseInt(sysctl['hw.ncpu'] ?? '', 10),
            uptimeSec,
            diskLines: sections.disk || [],
        });
    }

    /** Turns normalised readings plus the previous sample into a payload. */
    private assemble(input: {
        cpuSample: CpuSample | null;
        netSample: NetSample | null;
        mem: { totalKb: number; usedKb: number; usagePct: number };
        swap: { totalKb: number; usedKb: number; usagePct: number } | null;
        load: number[];
        cores: number;
        uptimeSec: number;
        diskLines: string[];
    }): HostMetrics {
        const now = Date.now();
        const elapsedSec = this.prevAt ? (now - this.prevAt) / 1000 : 0;

        let usagePct: number | null = null;
        if (input.cpuSample && this.prevCpu) {
            const dTotal = input.cpuSample.total - this.prevCpu.total;
            const dIdle = input.cpuSample.idle - this.prevCpu.idle;
            // Counters reset when the host reboots; a negative delta means exactly that.
            if (dTotal > 0 && dIdle >= 0) {
                usagePct = round1(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)));
            }
        }

        let net: HostMetrics['net'] = null;
        if (input.netSample && this.prevNet && elapsedSec > 0) {
            const dRx = input.netSample.rx - this.prevNet.rx;
            const dTx = input.netSample.tx - this.prevNet.tx;
            if (dRx >= 0 && dTx >= 0) {
                net = {
                    rxBytesPerSec: Math.round(dRx / elapsedSec),
                    txBytesPerSec: Math.round(dTx / elapsedSec),
                };
            }
        }

        const disks = this.parseDisks(input.diskLines);

        this.prevCpu = input.cpuSample;
        this.prevNet = input.netSample;
        this.prevAt = now;

        return {
            ok: true,
            at: now,
            cpu: {
                usagePct,
                cores: Number.isFinite(input.cores) && input.cores > 0 ? input.cores : null,
                load1: input.load[0] || 0,
                load5: input.load[1] || 0,
                load15: input.load[2] || 0,
            },
            mem: input.mem,
            swap: input.swap,
            net,
            disk: disks.root,
            diskWorst: disks.worst,
            uptimeSec: input.uptimeSec,
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

    /** Linux: /proc/net/dev, one line per interface, counters after the colon. */
    private parseNetProc(lines: string[]): NetSample | null {
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

    /**
     * FreeBSD: `netstat -bni`. Per-interface totals live on the "<Link#n>" rows.
     * Column positions are not dependable there, because an interface with no
     * link address leaves the Address column empty and shifts everything, and
     * the trailing Coll column is not printed by every release. What is stable
     * is the run of numbers at the end of the row: Ipkts Ierrs Idrop Ibytes
     * Opkts Oerrs Obytes [Coll]. Counting from the start of that run gives the
     * right fields whichever of the two variations the host prints.
     */
    private parseNetstat(lines: string[]): NetSample | null {
        let rx = 0;
        let tx = 0;
        let seen = false;

        for (const line of lines) {
            const fields = line.trim().split(/\s+/);
            if (fields.length < 8) continue;
            const iface = fields[0].replace(/\*$/, '');
            if (!iface || /^lo\d*$/.test(iface)) continue;
            if (!fields.some((f) => f.startsWith('<Link#'))) continue;

            let start = fields.length;
            while (start > 0 && /^\d+$/.test(fields[start - 1])) start -= 1;
            const run = fields.slice(start).map(Number);
            if (run.length < 7) continue;

            rx += run[3]; // Ibytes
            tx += run[6]; // Obytes
            seen = true;
        }
        return seen ? { rx, tx } : null;
    }

    /**
     * FreeBSD has no MemAvailable. The closest equivalent is the sum of pages
     * the kernel can hand out without evicting anything an application is
     * actively using: free, inactive, laundry and, on releases that still have
     * it, cache. Swap comes from `swapinfo -k`.
     */
    private parseBsdMem(sysctl: Record<string, string>, swapLines: string[]) {
        const pageSize = Number(sysctl['hw.pagesize']);
        const physBytes = Number(sysctl['hw.physmem']);
        if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
        if (!Number.isFinite(physBytes) || physBytes <= 0) return null;

        let reclaimablePages = 0;
        for (const key of [
            'vm.stats.vm.v_free_count',
            'vm.stats.vm.v_inactive_count',
            'vm.stats.vm.v_cache_count',
            'vm.stats.vm.v_laundry_count',
        ]) {
            const n = Number(sysctl[key]);
            if (Number.isFinite(n) && n >= 0) reclaimablePages += n;
        }

        const totalKb = Math.round(physBytes / 1024);
        const availableKb = Math.round((reclaimablePages * pageSize) / 1024);
        const usedKb = Math.max(0, Math.min(totalKb, totalKb - availableKb));

        let swap: { totalKb: number; usedKb: number; usagePct: number } | null = null;
        let swapTotal = 0;
        let swapUsed = 0;
        for (const line of swapLines.slice(1)) {
            const f = line.trim().split(/\s+/);
            if (f.length < 4) continue;
            const t = Number(f[1]);
            const u = Number(f[2]);
            if (!Number.isFinite(t) || !Number.isFinite(u)) continue;
            // A "Total" summary row appears only when several devices exist;
            // taking it instead of the devices avoids counting twice.
            if (/^total$/i.test(f[0])) {
                swapTotal = t;
                swapUsed = u;
                break;
            }
            swapTotal += t;
            swapUsed += u;
        }
        if (swapTotal > 0) {
            swap = { totalKb: swapTotal, usedKb: swapUsed, usagePct: round1((swapUsed / swapTotal) * 100) };
        }

        return {
            mem: { totalKb, usedKb, usagePct: round1((usedKb / totalKb) * 100) },
            swap,
        };
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
