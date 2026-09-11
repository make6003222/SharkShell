import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Tags are the cross-cutting axis over hosts.
 *
 * A host belongs to exactly one group, which answers "where does this live".
 * Tags answer "how do I find this", and a host carries as many as it needs.
 * They are key/value rather than free labels, because a fleet is usually
 * classified along several independent dimensions at once — site, role,
 * exposure, the zone a server answers for — and flat labels collapse those
 * into one undifferentiated list as soon as there are more than a handful.
 *
 * Tags are addressed as "key:value" strings everywhere the API is called, so a
 * caller never has to resolve an id before assigning one. Unknown tags are
 * created on assignment.
 */
@Injectable()
export class TagsService {
    constructor(private db: DatabaseService) { }

    async findAllByUser(userId: string) {
        const result = await this.db.query(
            `SELECT t.id, t.key, t.value, t.color, count(ht.host_id)::int AS host_count
         FROM tags t
         LEFT JOIN host_tags ht ON ht.tag_id = t.id
        WHERE t.user_id = $1
     GROUP BY t.id
     ORDER BY t.key, t.value`,
            [userId],
        );
        return result.rows;
    }

    /** "site:almaty" -> { key: 'site', value: 'almaty' }; a bare label becomes key "tag". */
    private parse(raw: string) {
        const text = String(raw || '').trim();
        if (!text) return null;
        const idx = text.indexOf(':');
        const key = idx > 0 ? text.slice(0, idx).trim().toLowerCase() : 'tag';
        const value = (idx > 0 ? text.slice(idx + 1) : text).trim().toLowerCase();
        if (!value) return null;
        return { key: key.slice(0, 64), value: value.slice(0, 128) };
    }

    /**
     * Colour is derived rather than chosen. The key sets the hue family, so
     * every site: tag reads as related, and the value shifts hue and lightness
     * enough that sibling values stay apart: a fleet with three sites whose
     * chips are the same colour defeats the point of having chips.
     *
     * Mirrored in deploy/autotag-hosts.py, which writes tags straight to the
     * database. Change one, change the other.
     */
    private colorFor(key: string, value: string) {
        const hash = (s: string) => {
            let h = 0;
            for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
            return Math.abs(h);
        };
        const v = hash(value);
        const hue = (hash(key) + (v % 9) * 4) % 360;
        const light = 50 + (v % 5) * 7;
        return hslToHex(hue, 62, light);
    }

    /** Resolves tag strings to ids, creating any that do not exist yet. */
    async resolveOrCreate(userId: string, rawTags: string[]): Promise<string[]> {
        const wanted = (rawTags || [])
            .map((t) => this.parse(t))
            .filter((t): t is { key: string; value: string } => t !== null);
        if (wanted.length === 0) return [];

        const ids: string[] = [];
        for (const { key, value } of wanted) {
            const existing = await this.db.query(
                'SELECT id FROM tags WHERE user_id = $1 AND key = $2 AND value = $3',
                [userId, key, value],
            );
            if (existing.rows.length > 0) {
                ids.push(existing.rows[0].id);
                continue;
            }
            const created = await this.db.query(
                'INSERT INTO tags (user_id, key, value, color) VALUES ($1, $2, $3, $4) RETURNING id',
                [userId, key, value, this.colorFor(key, value)],
            );
            ids.push(created.rows[0].id);
        }
        return ids;
    }

    /** Replaces the whole tag set of one host. Returns null if the host is not the caller's. */
    async setHostTags(userId: string, hostId: string, rawTags: string[]) {
        const owns = await this.db.query(
            'SELECT id FROM hosts WHERE id = $1 AND user_id = $2',
            [hostId, userId],
        );
        if (owns.rows.length === 0) return null;

        const tagIds = await this.resolveOrCreate(userId, rawTags);
        await this.db.query('DELETE FROM host_tags WHERE host_id = $1', [hostId]);
        for (const tagId of tagIds) {
            await this.db.query(
                'INSERT INTO host_tags (host_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [hostId, tagId],
            );
        }
        return this.tagsOfHost(userId, hostId);
    }

    /**
     * Adds and removes tags across many hosts at once. This is what makes a
     * fleet workable: classifying twenty servers one dialog at a time is how
     * tagging schemes die.
     */
    async bulkUpdate(userId: string, hostIds: string[], add: string[], remove: string[]) {
        const owned = await this.db.query(
            'SELECT id FROM hosts WHERE user_id = $1 AND id = ANY($2::uuid[])',
            [userId, hostIds || []],
        );
        const ids = owned.rows.map((r: any) => r.id);
        if (ids.length === 0) return { updated: 0 };

        const addIds = await this.resolveOrCreate(userId, add || []);
        const removeIds = await this.resolveOrCreate(userId, remove || []);

        for (const hostId of ids) {
            for (const tagId of addIds) {
                await this.db.query(
                    'INSERT INTO host_tags (host_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [hostId, tagId],
                );
            }
            if (removeIds.length > 0) {
                await this.db.query(
                    'DELETE FROM host_tags WHERE host_id = $1 AND tag_id = ANY($2::uuid[])',
                    [hostId, removeIds],
                );
            }
        }
        return { updated: ids.length };
    }

    async tagsOfHost(userId: string, hostId: string) {
        const result = await this.db.query(
            `SELECT t.id, t.key, t.value, t.color
         FROM host_tags ht
         JOIN tags t ON t.id = ht.tag_id
        WHERE ht.host_id = $1 AND t.user_id = $2
     ORDER BY t.key, t.value`,
            [hostId, userId],
        );
        return result.rows;
    }

    async delete(userId: string, id: string) {
        const result = await this.db.query(
            'DELETE FROM tags WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, userId],
        );
        return result.rows.length > 0;
    }

    /** Drops tags that no host carries any more, so the filter bar does not silt up. */
    async pruneUnused(userId: string) {
        const result = await this.db.query(
            `DELETE FROM tags t
              WHERE t.user_id = $1
                AND NOT EXISTS (SELECT 1 FROM host_tags ht WHERE ht.tag_id = t.id)
          RETURNING t.id`,
            [userId],
        );
        return { removed: result.rows.length };
    }
}

function hslToHex(h: number, s: number, l: number) {
    const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const c = l / 100 - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}
