import type {
    EnvironmentSyncApplyResponse,
    EnvironmentSyncConnectionResult,
    EnvironmentSyncFingerprints,
    EnvironmentSyncRemoteCatalog,
    EnvironmentSyncRemoteConfig,
    EnvironmentSyncRemoteTarget,
    IEnvironmentSyncClient,
} from '../environment-sync-client.js';
import {
    SYNC_PROTOCOL_VERSION,
    type EnvironmentSyncIgnoredConfig,
} from '../environment-sync-config.js';

type FakeOverrides = Partial<{
    testConnection: (input: {
        url: string;
        token: string;
        project?: string | null;
    }) => Promise<EnvironmentSyncConnectionResult>;
    fingerprints: (
        target: EnvironmentSyncRemoteTarget,
        input: {
            projectId: string;
            environment: string;
            featureNames?: string[];
            ignoredConfig?: EnvironmentSyncIgnoredConfig;
        },
    ) => Promise<EnvironmentSyncFingerprints>;
    config: (
        target: EnvironmentSyncRemoteTarget,
        input: {
            projectId: string;
            environment: string;
            featureName: string;
            ignoredConfig?: EnvironmentSyncIgnoredConfig;
        },
    ) => Promise<EnvironmentSyncRemoteConfig>;
    catalog: (
        target: EnvironmentSyncRemoteTarget,
        input: { environment: string; featureNames?: string[] },
    ) => Promise<EnvironmentSyncRemoteCatalog>;
    applyConfigs: (
        target: EnvironmentSyncRemoteTarget,
        input: {
            projectId: string;
            environment: string;
            configs: {
                featureName: string;
                strategies: unknown[];
                variants: unknown[];
            }[];
            ignoredConfig?: EnvironmentSyncIgnoredConfig;
        },
    ) => Promise<EnvironmentSyncApplyResponse>;
}>;

export class FakeEnvironmentSyncClient implements IEnvironmentSyncClient {
    public readonly calls = {
        testConnection: [] as unknown[],
        fingerprints: [] as unknown[],
        config: [] as unknown[],
        catalog: [] as unknown[],
        applyConfigs: [] as unknown[],
    };

    private readonly overrides: FakeOverrides;

    constructor(overrides: FakeOverrides = {}) {
        this.overrides = overrides;
    }

    async testConnection(input: {
        url: string;
        token: string;
        project?: string | null;
    }): Promise<EnvironmentSyncConnectionResult> {
        this.calls.testConnection.push(input);
        if (this.overrides.testConnection) {
            return this.overrides.testConnection(input);
        }
        return { ok: true, environments: [] };
    }

    async fingerprints(
        target: EnvironmentSyncRemoteTarget,
        input: {
            projectId: string;
            environment: string;
            featureNames?: string[];
            ignoredConfig?: EnvironmentSyncIgnoredConfig;
        },
    ): Promise<EnvironmentSyncFingerprints> {
        this.calls.fingerprints.push({ target, input });
        if (this.overrides.fingerprints) {
            return this.overrides.fingerprints(target, input);
        }
        return {
            version: SYNC_PROTOCOL_VERSION,
            environmentAvailable: true,
            features: (input.featureNames ?? []).map((name) => ({
                name,
                exists: false,
                archived: false,
                fingerprint: null,
                strategyCount: 0,
                variantCount: 0,
            })),
        };
    }

    async config(
        target: EnvironmentSyncRemoteTarget,
        input: {
            projectId: string;
            environment: string;
            featureName: string;
            ignoredConfig?: EnvironmentSyncIgnoredConfig;
        },
    ): Promise<EnvironmentSyncRemoteConfig> {
        this.calls.config.push({ target, input });
        if (this.overrides.config) {
            return this.overrides.config(target, input);
        }
        return {
            version: SYNC_PROTOCOL_VERSION,
            environmentAvailable: true,
            exists: false,
            archived: false,
            strategies: [],
            variants: [],
        };
    }

    async catalog(
        target: EnvironmentSyncRemoteTarget,
        input: { environment: string; featureNames?: string[] },
    ): Promise<EnvironmentSyncRemoteCatalog> {
        this.calls.catalog.push({ target, input });
        if (this.overrides.catalog) {
            return this.overrides.catalog(target, input);
        }
        return {
            version: SYNC_PROTOCOL_VERSION,
            environment: input.environment,
            entries: [],
            flags: input.featureNames ?? [],
            truncated: false,
        };
    }

    async applyConfigs(
        target: EnvironmentSyncRemoteTarget,
        input: {
            projectId: string;
            environment: string;
            configs: {
                featureName: string;
                strategies: unknown[];
                variants: unknown[];
            }[];
            ignoredConfig?: EnvironmentSyncIgnoredConfig;
        },
    ): Promise<EnvironmentSyncApplyResponse> {
        this.calls.applyConfigs.push({ target, input });
        if (this.overrides.applyConfigs) {
            return this.overrides.applyConfigs(target, input);
        }
        return {
            results: input.configs.map((config) => ({
                featureName: config.featureName,
                status: 'synced' as const,
                created: false,
            })),
        };
    }
}
