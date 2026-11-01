export type EnvironmentSyncTestStatus = 'ok' | 'error';
export type EnvironmentSyncSyncStatus = 'ok' | 'error';

export interface EnvironmentSyncTarget {
    id: number;
    name: string;
    url: string;
    project: string | null;
    sourceEnvironment: string;
    targetEnvironment: string;
    enabled: boolean;
    createdAt: Date;
    createdBy: string | null;
    lastTestedAt: Date | null;
    lastTestStatus: EnvironmentSyncTestStatus | null;
    lastTestError: string | null;
    lastSyncedAt: Date | null;
    lastSyncStatus: EnvironmentSyncSyncStatus | null;
    lastSyncError: string | null;
}

export interface EnvironmentSyncTargetWithToken extends EnvironmentSyncTarget {
    tokenEnc: Buffer;
}

export interface EnvironmentSyncTargetInsert {
    name: string;
    url: string;
    tokenEnc: Buffer;
    project?: string | null;
    sourceEnvironment: string;
    targetEnvironment: string;
    enabled?: boolean;
    createdBy?: string | null;
}

export interface EnvironmentSyncTargetUpdate {
    name?: string;
    url?: string;
    tokenEnc?: Buffer;
    project?: string | null;
    sourceEnvironment?: string;
    targetEnvironment?: string;
    enabled?: boolean;
}

export interface EnvironmentSyncTargetStateUpdate {
    status: EnvironmentSyncTestStatus | EnvironmentSyncSyncStatus;
    error?: string | null;
    at: Date;
}

export interface IEnvironmentSyncTargetStore {
    getAll(): Promise<EnvironmentSyncTargetWithToken[]>;
    get(id: number): Promise<EnvironmentSyncTargetWithToken>;
    insert(
        target: EnvironmentSyncTargetInsert,
    ): Promise<EnvironmentSyncTargetWithToken>;
    update(
        id: number,
        target: EnvironmentSyncTargetUpdate,
    ): Promise<EnvironmentSyncTargetWithToken>;
    delete(id: number): Promise<void>;
    deleteAll(): Promise<void>;
    updateTestState(
        id: number,
        state: EnvironmentSyncTargetStateUpdate,
    ): Promise<void>;
    updateSyncState(
        id: number,
        state: EnvironmentSyncTargetStateUpdate,
    ): Promise<void>;
}
