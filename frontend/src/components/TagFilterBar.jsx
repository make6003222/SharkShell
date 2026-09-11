/**
 * Filter bar for host tags, laid out one row per key.
 *
 * Selection semantics follow how people actually phrase a fleet query: values
 * of the same key widen the result (Almaty or Astana), values of different
 * keys narrow it (in Almaty AND authoritative). Any other combination would
 * make "all authoritative servers in both sites" impossible to express, which
 * is the whole reason tags exist here.
 */

export function groupTagsByKey(tags) {
    const byKey = new Map();
    for (const t of tags) {
        if (!byKey.has(t.key)) byKey.set(t.key, []);
        byKey.get(t.key).push(t);
    }
    for (const list of byKey.values()) list.sort((a, b) => a.value.localeCompare(b.value));
    return [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** A host passes when every selected key has at least one of its values on it. */
export function hostMatchesTags(host, selected) {
    if (selected.size === 0) return true;
    const wanted = new Map();
    for (const full of selected) {
        const key = full.slice(0, full.indexOf(':'));
        if (!wanted.has(key)) wanted.set(key, new Set());
        wanted.get(key).add(full);
    }
    const own = new Set((host.tags || []).map(t => `${t.key}:${t.value}`));
    for (const values of wanted.values()) {
        let hit = false;
        for (const v of values) if (own.has(v)) { hit = true; break; }
        if (!hit) return false;
    }
    return true;
}

export default function TagFilterBar({ tags, selected, onToggle, onClear, matchCount }) {
    const grouped = groupTagsByKey(tags);
    if (grouped.length === 0) return null;

    return (
        <div className="tag-filter">
            {grouped.map(([key, list]) => (
                <div className="tag-filter-row" key={key}>
                    <span className="tag-filter-key">{key}</span>
                    <div className="tag-filter-values">
                        {list.map(t => {
                            const full = `${t.key}:${t.value}`;
                            const on = selected.has(full);
                            return (
                                <button
                                    key={t.id}
                                    type="button"
                                    className={`tag-chip ${on ? 'tag-chip-on' : ''}`}
                                    style={on ? { background: t.color, borderColor: t.color } : { borderColor: t.color, color: t.color }}
                                    onClick={() => onToggle(full)}
                                    title={`${full} — ${t.host_count} host${t.host_count === 1 ? '' : 's'}`}
                                >
                                    {t.value}
                                    <span className="tag-chip-count">{t.host_count}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}

            {selected.size > 0 && (
                <div className="tag-filter-summary">
                    <span>{matchCount} matching</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>Clear filter</button>
                </div>
            )}
        </div>
    );
}
