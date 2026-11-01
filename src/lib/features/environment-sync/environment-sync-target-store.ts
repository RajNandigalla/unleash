import type { Knex } from 'knex';
import type { Db } from '../../db/db.js';
import type { IUnleashConfig } from '../../types/option.js';
import NotFoundError from '../../error/notfound-error.js';
import type {
    EnvironmentSyncTargetInsert,
    EnvironmentSyncTargetStateUpdate,
    EnvironmentSyncTargetUpdate,
    EnvironmentSyncTargetWithToken,
    IEnvironmentSyncTargetStore,
} from './environment-sync-target-store-type.js';

const TABLE = 'environment_sync_targets';

interface IEnvironmentSyncTargetRow {
    id: number;
    name: string;
    url: string;
    token_enc: Buffer;
    project: string | null;
    source_environment: string;
    target_environment: string;
    enabled: boolean;
    created_at: Date;
    created_by: string | null;
    last_tested_at: Date | null;
    last_test_status: string | null;
    last_test_error: string | null;
    last_synced_at: Date | null;
    last_sync_status: string | null;
    last_sync_error: string | null;
}

const rowToTarget = (
    row: IEnvironmentSyncTargetRow,
): EnvironmentSyncTargetWithToken => ({
    id: row.id,
    name: row.name,
    url: row.url,
    tokenEnc: row.token_enc,
    project: row.project,
    sourceEnvironment: row.source_environment,
    targetEnvironment: row.target_environment,
    enabled: row.enabled,
    createdAt: row.created_at,
    createdBy: row.created_by,
    lastTestedAt: row.last_tested_at,
    lastTestStatus:
        row.last_test_status as EnvironmentSyncTargetWithToken['lastTestStatus'],
    lastTestError: row.last_test_error,
    lastSyncedAt: row.last_synced_at,
    lastSyncStatus:
        row.last_sync_status as EnvironmentSyncTargetWithToken['lastSyncStatus'],
    lastSyncError: row.last_sync_error,
});

const compact = <T extends Record<string, unknown>>(input: T): T => {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
            output[key] = value;
        }
    }
    return output as T;
};

export class EnvironmentSyncTargetStore implements IEnvironmentSyncTargetStore {
    private db: Db;

    constructor(
        db: Db,
        _config: Pick<IUnleashConfig, 'getLogger' | 'eventBus'>,
    ) {
        this.db = db;
    }

    private table(): Knex.QueryBuilder {
        return this.db(TABLE);
    }

    async getAll(): Promise<EnvironmentSyncTargetWithToken[]> {
        const rows = await this.table().orderBy('name', 'asc');
        return rows.map(rowToTarget);
    }

    async get(id: number): Promise<EnvironmentSyncTargetWithToken> {
        const row = await this.table().where({ id }).first();
        if (!row) {
            throw new NotFoundError(`Environment sync target ${id} not found`);
        }
        return rowToTarget(row);
    }

    async insert(
        target: EnvironmentSyncTargetInsert,
    ): Promise<EnvironmentSyncTargetWithToken> {
        const [row] = await this.db(TABLE)
            .insert(
                compact({
                    name: target.name,
                    url: target.url,
                    token_enc: target.tokenEnc,
                    project: target.project ?? null,
                    source_environment: target.sourceEnvironment,
                    target_environment: target.targetEnvironment,
                    enabled: target.enabled ?? true,
                    created_by: target.createdBy ?? null,
                }),
            )
            .returning('*');
        return rowToTarget(row);
    }

    async update(
        id: number,
        target: EnvironmentSyncTargetUpdate,
    ): Promise<EnvironmentSyncTargetWithToken> {
        const patch = compact({
            name: target.name,
            url: target.url,
            token_enc: target.tokenEnc,
            project: target.project,
            source_environment: target.sourceEnvironment,
            target_environment: target.targetEnvironment,
            enabled: target.enabled,
        });

        if (Object.keys(patch).length > 0) {
            await this.table().where({ id }).update(patch);
        }

        return this.get(id);
    }

    async delete(id: number): Promise<void> {
        await this.table().where({ id }).delete();
    }

    async deleteAll(): Promise<void> {
        await this.table().delete();
    }

    async updateTestState(
        id: number,
        state: EnvironmentSyncTargetStateUpdate,
    ): Promise<void> {
        await this.table()
            .where({ id })
            .update({
                last_tested_at: state.at,
                last_test_status: state.status,
                last_test_error: state.error ?? null,
            });
    }

    async updateSyncState(
        id: number,
        state: EnvironmentSyncTargetStateUpdate,
    ): Promise<void> {
        await this.table()
            .where({ id })
            .update({
                last_synced_at: state.at,
                last_sync_status: state.status,
                last_sync_error: state.error ?? null,
            });
    }
}
