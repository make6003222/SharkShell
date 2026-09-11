/**
 * Slim readout of what the connected host is actually doing: processor load,
 * memory, swap, disk, network throughput and uptime.
 *
 * Values arrive over the session socket as `ssh:stats`, sampled on the host
 * itself. The first tick carries no rates, because processor load and network
 * throughput are differences between two readings, so those two fields stay
 * blank for one interval and then fill in.
 */

const KB = 1024;

function formatBytes(kb) {
    if (!Number.isFinite(kb)) return '—';
    let value = kb;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    while (value >= KB && i < units.length - 1) {
        value /= KB;
        i += 1;
    }
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatRate(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec)) return '—';
    let value = bytesPerSec;
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i += 1;
    }
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatUptime(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '—';
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

/** Green below 70, amber to 90, red above. Anything unknown stays neutral. */
function levelColor(pct) {
    if (!Number.isFinite(pct)) return 'var(--text-tertiary)';
    if (pct >= 90) return 'var(--danger)';
    if (pct >= 70) return 'var(--warning)';
    return 'var(--success)';
}

function Metric({ label, value, pct, title }) {
    const showBar = Number.isFinite(pct);
    return (
        <div className="hsb-metric" title={title}>
            <span className="hsb-label">{label}</span>
            <span className="hsb-value" style={{ color: showBar ? levelColor(pct) : undefined }}>{value}</span>
            {showBar && (
                <span className="hsb-bar" aria-hidden="true">
                    <span
                        className="hsb-bar-fill"
                        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: levelColor(pct) }}
                    />
                </span>
            )}
        </div>
    );
}

export default function HostStatusBar({ stats, status }) {
    if (status !== 'connected') return null;

    if (!stats) {
        return (
            <div className="host-status-bar">
                <span className="hsb-idle">Reading host metrics…</span>
            </div>
        );
    }

    if (!stats.ok) {
        return (
            <div className="host-status-bar">
                <span className="hsb-idle">
                    Metrics unavailable on this host — it does not expose /proc.
                </span>
            </div>
        );
    }

    const { cpu, mem, swap, net, disk, diskWorst, uptimeSec } = stats;
    const cpuPct = cpu?.usagePct;
    const loadTitle = cpu
        ? `Load average over 1, 5 and 15 minutes: ${cpu.load1} / ${cpu.load5} / ${cpu.load15}`
            + (cpu.cores ? ` across ${cpu.cores} cores` : '')
        : undefined;

    return (
        <div className="host-status-bar">
            <Metric
                label="CPU"
                value={Number.isFinite(cpuPct) ? `${cpuPct}%` : '…'}
                pct={cpuPct}
                title={loadTitle}
            />

            {cpu && (
                <div className="hsb-metric" title={loadTitle}>
                    <span className="hsb-label">Load</span>
                    <span className="hsb-value">{cpu.load1.toFixed(2)}</span>
                    {cpu.cores ? <span className="hsb-muted">/ {cpu.cores}</span> : null}
                </div>
            )}

            {mem && (
                <Metric
                    label="RAM"
                    value={`${mem.usagePct}%`}
                    pct={mem.usagePct}
                    title={`${formatBytes(mem.usedKb)} used of ${formatBytes(mem.totalKb)}`}
                />
            )}

            {swap && swap.usagePct > 0 && (
                <Metric
                    label="Swap"
                    value={`${swap.usagePct}%`}
                    pct={swap.usagePct}
                    title={`${formatBytes(swap.usedKb)} used of ${formatBytes(swap.totalKb)}`}
                />
            )}

            {disk && (
                <Metric
                    label="Disk"
                    value={`${disk.usagePct}%`}
                    pct={disk.usagePct}
                    title={`${disk.mount}: ${formatBytes(disk.usedKb)} used of ${formatBytes(disk.totalKb)}`}
                />
            )}

            {diskWorst && diskWorst.usagePct >= 80 && (
                <div className="hsb-metric" title={`Fullest mount point: ${diskWorst.mount}`}>
                    <span className="hsb-label">{diskWorst.mount}</span>
                    <span className="hsb-value" style={{ color: levelColor(diskWorst.usagePct) }}>
                        {diskWorst.usagePct}%
                    </span>
                </div>
            )}

            <div className="hsb-metric" title="Network throughput across all interfaces except loopback">
                <span className="hsb-label">Net</span>
                <span className="hsb-value hsb-net">
                    ↓ {net ? formatRate(net.rxBytesPerSec) : '…'}
                </span>
                <span className="hsb-value hsb-net">
                    ↑ {net ? formatRate(net.txBytesPerSec) : '…'}
                </span>
            </div>

            <div className="hsb-metric hsb-right" title="Time since the host last booted">
                <span className="hsb-label">Up</span>
                <span className="hsb-value">{formatUptime(uptimeSec)}</span>
            </div>
        </div>
    );
}
