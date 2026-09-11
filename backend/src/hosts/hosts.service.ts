import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CryptoService } from '../crypto/crypto.service';

@Injectable()
export class HostsService {
    constructor(
        private db: DatabaseService,
        private cryptoService: CryptoService,
    ) { }

    async findAllByUser(userId: string) {
        const result = await this.db.query(
            `SELECT h.id, h.name, h.hostname, h.port, h.username, h.auth_type, h.ssh_key_id,
              h.created_at, h.group_id, sk.name as key_name, g.name as group_name, g.color as group_color,
              CASE WHEN h.password_encrypted IS NOT NULL THEN true ELSE false END as has_password,
              COALESCE((
                SELECT json_agg(json_build_object('id', t.id, 'key', t.key, 'value', t.value, 'color', t.color)
                                ORDER BY t.key, t.value)
                  FROM host_tags ht JOIN tags t ON t.id = ht.tag_id
                 WHERE ht.host_id = h.id
              ), '[]'::json) AS tags
       FROM hosts h
       LEFT JOIN ssh_keys sk ON h.ssh_key_id = sk.id
       LEFT JOIN groups g ON h.group_id = g.id
       WHERE h.user_id = $1
       ORDER BY h.created_at DESC`,
            [userId],
        );
        return result.rows;
    }

    async create(userId: string, data: any) {
        const { name, hostname, port, username, authType, sshKeyId, password, groupId } = data;

        let passwordEncrypted = null, passwordIv = null, passwordAuthTag = null;
        if (password) {
            const enc = this.cryptoService.encrypt(password);
            passwordEncrypted = enc.encrypted;
            passwordIv = enc.iv;
            passwordAuthTag = enc.authTag;
        }

        const result = await this.db.query(
            `INSERT INTO hosts (user_id, name, hostname, port, username, auth_type, ssh_key_id, password_encrypted, password_iv, password_auth_tag, group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [userId, name, hostname, port || 22, username, authType || 'key', sshKeyId || null, passwordEncrypted, passwordIv, passwordAuthTag, groupId || null],
        );
        return result.rows[0];
    }

    /**
     * Creates a copy of an existing host, taking everything from the source
     * except the fields the caller overrides.
     *
     * The stored password is carried over as the ciphertext it already is: the
     * same encryption key decrypts it, so there is no reason to decrypt it here
     * and no reason for the browser to have seen it in order to make the copy.
     * A caller that wants a different password sends one, and it is encrypted
     * fresh like any other write.
     */
    async duplicate(userId: string, sourceId: string, data: any) {
        const source = await this.db.query(
            'SELECT * FROM hosts WHERE id = $1 AND user_id = $2',
            [sourceId, userId],
        );
        if (source.rows.length === 0) return null;

        const src = source.rows[0];
        const { name, hostname, port, username, password, groupId, authType, sshKeyId } = data;

        // A caller that sends groupId means it, including an empty value for
        // "no group". Only a caller that omits the field inherits the source's.
        const groupOverridden = Object.prototype.hasOwnProperty.call(data, 'groupId');
        const group = groupOverridden ? (groupId || null) : src.group_id;

        let passwordEncrypted = src.password_encrypted;
        let passwordIv = src.password_iv;
        let passwordAuthTag = src.password_auth_tag;
        if (password) {
            const enc = this.cryptoService.encrypt(password);
            passwordEncrypted = enc.encrypted;
            passwordIv = enc.iv;
            passwordAuthTag = enc.authTag;
        }

        const result = await this.db.query(
            `INSERT INTO hosts (user_id, name, hostname, port, username, auth_type, ssh_key_id, password_encrypted, password_iv, password_auth_tag, group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [
                userId,
                name,
                hostname,
                port || src.port || 22,
                username || src.username,
                authType || src.auth_type,
                sshKeyId !== undefined ? (sshKeyId || null) : (src.ssh_key_id || null),
                passwordEncrypted,
                passwordIv,
                passwordAuthTag,
                group,
            ],
        );
        return result.rows[0];
    }

    async update(userId: string, id: string, data: any) {
        const { name, hostname, port, username, authType, sshKeyId, password, groupId } = data;

        let passwordEncrypted = null, passwordIv = null, passwordAuthTag = null;
        if (password) {
            const enc = this.cryptoService.encrypt(password);
            passwordEncrypted = enc.encrypted;
            passwordIv = enc.iv;
            passwordAuthTag = enc.authTag;
        }

        let updateQuery: string;
        let updateParams: any[];

        if (authType === 'password' && password) {
            updateQuery = `UPDATE hosts SET
        name = COALESCE($1, name),
        hostname = COALESCE($2, hostname),
        port = COALESCE($3, port),
        username = COALESCE($4, username),
        auth_type = COALESCE($5, auth_type),
        ssh_key_id = $6,
        password_encrypted = $7,
        password_iv = $8,
        password_auth_tag = $9,
        group_id = $10
      WHERE id = $11 AND user_id = $12
      RETURNING *`;
            updateParams = [name, hostname, port, username, authType, sshKeyId || null, passwordEncrypted, passwordIv, passwordAuthTag, groupId !== undefined ? (groupId || null) : null, id, userId];
        } else {
            updateQuery = `UPDATE hosts SET
        name = COALESCE($1, name),
        hostname = COALESCE($2, hostname),
        port = COALESCE($3, port),
        username = COALESCE($4, username),
        auth_type = COALESCE($5, auth_type),
        ssh_key_id = $6,
        group_id = $7
      WHERE id = $8 AND user_id = $9
      RETURNING *`;
            updateParams = [name, hostname, port, username, authType, sshKeyId || null, groupId !== undefined ? (groupId || null) : null, id, userId];
        }

        const result = await this.db.query(updateQuery, updateParams);
        return result.rows[0] || null;
    }

    async delete(userId: string, id: string) {
        const result = await this.db.query(
            'DELETE FROM hosts WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, userId],
        );
        return result.rows[0] || null;
    }
}
