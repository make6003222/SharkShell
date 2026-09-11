import { useEffect, useMemo, useRef, useState } from 'react';
import { tagChipStyle } from './TagFilterBar';

/**
 * Tag editor in the shape Proxmox uses: the tags already on the host sit as
 * coloured pills you remove individually, and a plus opens a box that both
 * completes from the tags you already have and accepts something new.
 *
 * The alternative, one text field holding every tag separated by spaces, made
 * editing one tag mean retyping all of them, and offered no way to see which
 * tags already exist — which is how you end up with pavl and pavlodar living
 * side by side as two different sites.
 */
export default function TagEditor({ value, onChange, allTags }) {
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState('');
    const [highlight, setHighlight] = useState(0);
    const [navigated, setNavigated] = useState(false); // стрелками пользовались
    const inputRef = useRef(null);
    const closeTimer = useRef(null);

    const known = useMemo(() => {
        const map = new Map();
        for (const t of allTags || []) map.set(`${t.key}:${t.value}`, t);
        return map;
    }, [allTags]);

    const suggestions = useMemo(() => {
        const q = draft.trim().toLowerCase();
        const taken = new Set(value);
        return [...known.keys()]
            .filter(full => !taken.has(full) && (q === '' || full.includes(q)))
            .sort()
            .slice(0, 40);
    }, [draft, known, value]);

    useEffect(() => { setHighlight(0); setNavigated(false); }, [draft]);
    useEffect(() => () => clearTimeout(closeTimer.current), []);

    function add(raw) {
        const text = String(raw || '').trim().toLowerCase();
        if (!text) return;
        // A bare word is a value without a key; the server files it under "tag".
        if (!value.includes(text)) onChange([...value, text]);
        setDraft('');
        setHighlight(0);
        setNavigated(false);
        inputRef.current?.focus();
    }

    function remove(full) {
        onChange(value.filter(v => v !== full));
    }

    function onKeyDown(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            // Typing wins over the list unless the arrows were used: otherwise a
            // new tag whose prefix matches an existing one could never be
            // entered, because the suggestion would keep taking the Enter.
            if (navigated && suggestions[highlight]) add(suggestions[highlight]);
            else if (draft.trim()) add(draft);
            else setAdding(false);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setNavigated(true);
            setHighlight(h => Math.min(h + 1, suggestions.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setNavigated(true);
            setHighlight(h => Math.max(h - 1, 0));
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft('');
            setAdding(false);
        } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            remove(value[value.length - 1]);
        }
    }

    return (
        <div className="tag-editor">
            {value.map(full => {
                const tag = known.get(full);
                const [key, ...rest] = full.split(':');
                const label = rest.length > 0 ? rest.join(':') : full;
                return (
                    <span
                        key={full}
                        className={`tag-chip tag-chip-edit ${tag ? '' : 'tag-chip-new'}`}
                        style={tag ? tagChipStyle(tag) : undefined}
                        title={rest.length > 0 ? `${key}: ${label}` : label}
                    >
                        {label}
                        <button
                            type="button"
                            className="tag-chip-remove"
                            onClick={() => remove(full)}
                            aria-label={`Remove ${full}`}
                            title={`Remove ${full}`}
                        >
                            −
                        </button>
                    </span>
                );
            })}

            {adding ? (
                <span className="tag-editor-box">
                    <input
                        ref={inputRef}
                        autoFocus
                        className="tag-editor-input"
                        placeholder="site:almaty"
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={onKeyDown}
                        onBlur={() => { closeTimer.current = setTimeout(() => setAdding(false), 150); }}
                        onFocus={() => clearTimeout(closeTimer.current)}
                    />
                    {suggestions.length > 0 && (
                        <ul className="tag-suggest">
                            {suggestions.map((full, i) => {
                                const tag = known.get(full);
                                return (
                                    <li key={full}>
                                        <button
                                            type="button"
                                            className={`tag-suggest-item ${i === highlight ? 'tag-suggest-on' : ''}`}
                                            style={tag ? tagChipStyle(tag) : undefined}
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => add(full)}
                                            onMouseEnter={() => setHighlight(i)}
                                        >
                                            {full}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </span>
            ) : (
                <button
                    type="button"
                    className="tag-editor-add"
                    onClick={() => setAdding(true)}
                    title="Add a tag"
                >
                    +
                </button>
            )}
        </div>
    );
}
