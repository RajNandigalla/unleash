import NotFoundError from '../../../error/notfound-error.js';
import type {
    EnvironmentSyncTargetInsert,
    EnvironmentSyncTargetStateUpdate,
    EnvironmentSyncTargetUpdate,
    EnvironmentSyncTargetWithToken,
    IEnvironmentSyncTargetStore,
} from '../environment-sync-target-store-type.js';

export class FakeEnvironmentSyncTargetStore
    implements IEnvironmentSyncTargetStore
{
    private targets: Map<number, EnvironmentSyncTargetWithToken> = new Map();

    private nextId = 1;

    async getAll(): Promise<EnvironmentSyncTargetWithToken[]> {
        return [...this.targets.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
        );
    }

    async get(id: number): Promise<EnvironmentSyncTargetWithToken> {
        const target = this.targets.get(id);
        if (!target) {
            throw new NotFoundError(`Environment sync target ${id} not found`);
        }
        return target;
    }

    async insert(
        target: EnvironmentSyncTargetInsert,
    ): Promise<EnvironmentSyncTargetWithToken> {
        const now = new Date();
        const inserted: EnvironmentSyncTargetWithToken = {
            id: this.nextId++,
            name: target.name,
            url: target.url,
            tokenEnc: target.tokenEnc,
            project: target.project ?? null,
            sourceEnvironment: target.sourceEnvironment,
            targetEnvironment: target.targetEnvironment,
            enabled: target.enabled ?? true,
            createdAt: now,
            createdBy: target.createdBy ?? null,
            lastTestedAt: null,
            lastTestStatus: null,
            lastTestError: null,
            lastSyncedAt: null,
            lastSyncStatus: null,
            lastSyncError: null,
        };
        this.targets.set(inserted.id, inserted);
        return inserted;
    }

    async update(
        id: number,
        target: EnvironmentSyncTargetUpdate,
    ): Promise<EnvironmentSyncTargetWithToken> {
        const existing = await this.get(id);
        const updated: EnvironmentSyncTargetWithToken = {
            ...existing,
            ...(target.name !== undefined && { name: target.name }),
            ...(target.url !== undefined && { url: target.url }),
            ...(target.tokenEnc !== undefined && {
                tokenEnc: target.tokenEnc,
            }),
            ...(target.project !== undefined && { project: target.project }),
            ...(target.sourceEnvironment !== undefined && {
                sourceEnvironment: target.sourceEnvironment,
            }),
            ...(target.targetEnvironment !== undefined && {
                targetEnvironment: target.targetEnvironment,
            }),
            ...(target.enabled !== undefined && { enabled: target.enabled }),
        };
        this.targets.set(id, updated);
        return updated;
    }

    async delete(id: number): Promise<void> {
        this.targets.delete(id);
    }

    async deleteAll(): Promise<void> {
        this.targets.clear();
    }

    async updateTestState(
        id: number,
        state: EnvironmentSyncTargetStateUpdate,
    ): Promise<void> {
        const target = await this.get(id);
        this.targets.set(id, {
            ...target,
            lastTestedAt: state.at,
            lastTestStatus:
                state.status as EnvironmentSyncTargetWithToken['lastTestStatus'],
            lastTestError: state.error ?? null,
        });
    }

    async updateSyncState(
        id: number,
        state: EnvironmentSyncTargetStateUpdate,
    ): Promise<void> {
        const target = await this.get(id);
        this.targets.set(id, {
            ...target,
            lastSyncedAt: state.at,
            lastSyncStatus:
                state.status as EnvironmentSyncTargetWithToken['lastSyncStatus'],
            lastSyncError: state.error ?? null,
        });
    }
}
