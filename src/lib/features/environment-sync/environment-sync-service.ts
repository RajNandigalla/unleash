import type { IUnleashConfig } from '../../types/option.js';
import type {
    IAuditUser,
    IFeatureEnvironment,
    IFeatureEnvironmentStore,
    IFeatureStrategiesStore,
    IFeatureToggleStore,
} from '../../types/index.js';
import { BadDataError } from '../../error/index.js';
import {
    encryptSecret,
    decryptSecret,
} from '../edgetokens/edge-verification.js';
import type EnvironmentService from '../project-environments/environment-service.js';
import type EventService from '../events/event-service.js';
import type { ISegmentReadModel } from '../segment/segment-read-model-type.js';
import {
    canonicalConfig,
    diffConfigs,
    emptyConfig,
    fingerprintConfig,
    SYNC_PROTOCOL_VERSION,
    type EnvironmentSyncConfig,
    type EnvironmentSyncDifference,
    type EnvironmentSyncStrategy,
    type EnvironmentSyncVariant,
    type RawEnvironmentSyncStrategy,
} from './environment-sync-config.js';
import {
    diffEnvironmentSyncConfigs,
    type EnvironmentSyncDiff,
} from './environment-sync-diff.js';
import {
    EnvironmentSyncRemoteError,
    normalizeUrl,
    type EnvironmentSyncClient,
    type EnvironmentSyncFingerprint,
    type EnvironmentSyncRemoteTarget,
} from './environment-sync-client.js';
import type {
    EnvironmentSyncTargetInsert,
    EnvironmentSyncTargetWithToken,
    IEnvironmentSyncTargetStore,
} from './environment-sync-target-store-type.js';
import { FeatureConfigsSyncedEvent } from '../../types/index.js';

const STATUS_CACHE_TTL_MS = 30_000;

export type EnvironmentSyncTargetView = Omit<
    EnvironmentSyncTargetWithToken,
    'tokenEnc'
> & { hasToken: boolean };

export type EnvironmentSyncTargetStatus =
    | 'in_sync'
    | 'drift'
    | 'missing_remote'
    | 'no_local_config'
    | 'env_not_available'
    | 'archived'
    | 'error';

export type EnvironmentSyncFeatureStatus =
    | 'in_sync'
    | 'out_of_sync'
    | 'no_config'
    | 'error';

export interface EnvironmentSyncTargetStatusView {
    targetId: number;
    targetName: string;
    sourceEnvironment: string;
    targetEnvironment: string;
    status: EnvironmentSyncTargetStatus;
    differences: EnvironmentSyncDifference[];
    local?: EnvironmentSyncConfig;
    remote?: EnvironmentSyncConfig;
    diff?: EnvironmentSyncDiff;
    error?: string;
    lastSyncedAt?: Date | null;
}

export interface EnvironmentSyncFeatureCompare {
    featureName: string;
    targets: EnvironmentSyncTargetStatusView[];
}

export interface EnvironmentSyncProjectStatus {
    checkedAt: Date;
    summary: {
        total: number;
        inSync: number;
        outOfSync: number;
        missing: number;
        errors: number;
    };
    targets: {
        targetId: number;
        targetName: string;
        error?: string;
    }[];
    features: {
        featureName: string;
        status: EnvironmentSyncFeatureStatus;
        targets: {
            targetId: number;
            status: EnvironmentSyncTargetStatus;
            strategyCount?: number;
            variantCount?: number;
        }[];
    }[];
}

export interface EnvironmentSyncSyncResult {
    targetId: number;
    targetName: string;
    features: {
        featureName: string;
        status: 'synced' | 'skipped' | 'error';
        created?: boolean;
        error?: string;
    }[];
}

export interface EnvironmentSyncTargetInput {
    name: string;
    url: string;
    token?: string;
    project?: string | null;
    sourceEnvironment: string;
    targetEnvironment: string;
    enabled?: boolean;
}

interface LoadedConfig {
    name: string;
    exists: boolean;
    archived: boolean;
    config: EnvironmentSyncConfig;
    fingerprint: string;
    strategyCount: number;
    variantCount: number;
}

interface LoadedConfigs {
    environmentAvailable: boolean;
    features: LoadedConfig[];
}

interface EnvironmentSyncServiceConfig
    extends Pick<
        IUnleashConfig,
        | 'getLogger'
        | 'environmentSyncEncryptionKey'
        | 'allowPrivateUrlInIntegration'
        | 'allowListIntegration'
    > {}

interface EnvironmentSyncStores {
    environmentSyncTargetStore: IEnvironmentSyncTargetStore;
    featureToggleStore: IFeatureToggleStore;
    featureStrategiesStore: IFeatureStrategiesStore;
    featureEnvironmentStore: IFeatureEnvironmentStore;
    segmentReadModel: ISegmentReadModel;
}

interface EnvironmentSyncServices {
    environmentService: EnvironmentService;
    eventService: EventService;
}

const toTargetView = (
    target: EnvironmentSyncTargetWithToken,
): EnvironmentSyncTargetView => {
    const { tokenEnc, ...rest } = target;
    return { ...rest, hasToken: Boolean(tokenEnc) };
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];

export class EnvironmentSyncService {
    private readonly store: IEnvironmentSyncTargetStore;

    private readonly featureToggleStore: IFeatureToggleStore;

    private readonly featureStrategiesStore: IFeatureStrategiesStore;

    private readonly featureEnvironmentStore: IFeatureEnvironmentStore;

    private readonly segmentReadModel: ISegmentReadModel;

    private readonly environmentService: EnvironmentService;

    private readonly eventService: EventService;

    private readonly client: EnvironmentSyncClient;

    private readonly config: EnvironmentSyncServiceConfig;

    private readonly statusCache = new Map<
        string,
        { expiresAt: number; value: EnvironmentSyncProjectStatus }
    >();

    private readonly inFlight = new Map<string, Promise<unknown>>();

    constructor(
        stores: EnvironmentSyncStores,
        config: EnvironmentSyncServiceConfig,
        services: EnvironmentSyncServices,
        client: EnvironmentSyncClient,
    ) {
        this.store = stores.environmentSyncTargetStore;
        this.featureToggleStore = stores.featureToggleStore;
        this.featureStrategiesStore = stores.featureStrategiesStore;
        this.featureEnvironmentStore = stores.featureEnvironmentStore;
        this.segmentReadModel = stores.segmentReadModel;
        this.environmentService = services.environmentService;
        this.eventService = services.eventService;
        this.client = client;
        this.config = config;
    }

    // ---------------------------------------------------------------------
    // Targets
    // ---------------------------------------------------------------------

    async getTargets(): Promise<{
        tokenStorageConfigured: boolean;
        targets: EnvironmentSyncTargetView[];
    }> {
        const targets = await this.store.getAll();
        return {
            tokenStorageConfigured: this.getEncryptionKey() !== null,
            targets: targets.map(toTargetView),
        };
    }

    async createTarget(
        input: EnvironmentSyncTargetInput,
        auditUser: IAuditUser,
    ): Promise<EnvironmentSyncTargetView> {
        const token = input.token?.trim();
        if (!token) {
            throw new BadDataError('An access token is required');
        }
        const key = this.requireEncryptionKey();
        await this.validateTargetInput(input);

        const existing = await this.store.getAll();
        if (
            existing.some(
                (target) =>
                    target.name.toLowerCase() ===
                    input.name.trim().toLowerCase(),
            )
        ) {
            throw new BadDataError(
                `An environment named "${input.name}" already exists`,
            );
        }

        const create: EnvironmentSyncTargetInsert = {
            name: input.name.trim(),
            url: normalizeUrl(input.url.trim()),
            tokenEnc: encryptSecret(key, token),
            project: input.project?.trim() || null,
            sourceEnvironment: input.sourceEnvironment,
            targetEnvironment: input.targetEnvironment.trim(),
            enabled: input.enabled ?? true,
            createdBy: auditUser.username ?? null,
        };
        const target = await this.store.insert(create);
        this.invalidateStatusCache();
        return toTargetView(target);
    }

    async updateTarget(
        id: number,
        input: EnvironmentSyncTargetInput,
        _auditUser: IAuditUser,
    ): Promise<EnvironmentSyncTargetView> {
        const existing = await this.store.get(id);
        await this.validateTargetInput(input);

        const name = input.name.trim();
        const all = await this.store.getAll();
        if (
            all.some(
                (target) =>
                    target.id !== id &&
                    target.name.toLowerCase() === name.toLowerCase(),
            )
        ) {
            throw new BadDataError(
                `An environment named "${input.name}" already exists`,
            );
        }

        const token = input.token?.trim();
        const key = token ? this.requireEncryptionKey() : null;

        const target = await this.store.update(id, {
            name,
            url: normalizeUrl(input.url.trim()),
            ...(token && key ? { tokenEnc: encryptSecret(key, token) } : {}),
            project: input.project?.trim() || null,
            sourceEnvironment: input.sourceEnvironment,
            targetEnvironment: input.targetEnvironment.trim(),
            enabled: input.enabled ?? existing.enabled,
        });
        this.invalidateStatusCache();
        return toTargetView(target);
    }

    async deleteTarget(id: number): Promise<void> {
        await this.store.delete(id);
        this.invalidateStatusCache();
    }

    async testTarget(
        input: {
            url: string;
            token: string;
            project?: string | null;
            targetEnvironment?: string;
        },
        id?: number,
    ): Promise<{
        ok: boolean;
        environments: string[];
        projectExists?: boolean;
        error?: string;
    }> {
        const result = await this.client.testConnection({
            url: normalizeUrl(input.url.trim()),
            token: input.token,
            project: input.project,
        });

        let finalResult = result;
        if (
            finalResult.ok &&
            input.targetEnvironment &&
            !finalResult.environments.includes(input.targetEnvironment)
        ) {
            finalResult = {
                ...finalResult,
                ok: false,
                error: `Environment "${input.targetEnvironment}" does not exist on the target instance`,
            };
        }

        if (id !== undefined) {
            await this.store.updateTestState(id, {
                status: finalResult.ok ? 'ok' : 'error',
                error: finalResult.error,
                at: new Date(),
            });
        }

        return finalResult;
    }

    async testTargetById(id: number): Promise<{
        ok: boolean;
        environments: string[];
        projectExists?: boolean;
        error?: string;
    }> {
        const target = await this.store.get(id);
        const token = this.decryptToken(target);
        return this.testTarget(
            {
                url: target.url,
                token,
                project: target.project,
                targetEnvironment: target.targetEnvironment,
            },
            id,
        );
    }

    // ---------------------------------------------------------------------
    // Project status
    // ---------------------------------------------------------------------

    async getProjectStatus(
        projectId: string,
        options: { refresh?: boolean } = {},
    ): Promise<EnvironmentSyncProjectStatus> {
        const cacheKey = `${projectId}`;
        const cached = this.statusCache.get(cacheKey);
        if (!options.refresh && cached && cached.expiresAt > Date.now()) {
            return cached.value;
        }

        const key = `${cacheKey}:refreshing`;
        const inFlight = this.inFlight.get(key);
        if (inFlight) {
            return inFlight as Promise<EnvironmentSyncProjectStatus>;
        }

        const promise = this.calculateProjectStatus(projectId).finally(() => {
            this.inFlight.delete(key);
        });
        this.inFlight.set(key, promise);
        const value = await promise;
        this.statusCache.set(cacheKey, {
            expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
            value,
        });
        return value;
    }

    private async calculateProjectStatus(
        projectId: string,
    ): Promise<EnvironmentSyncProjectStatus> {
        const allFeatures = await this.featureToggleStore.getAll({
            project: projectId,
            archived: false,
        });
        const featureNames = allFeatures.map((feature) => feature.name);
        const targets = (await this.store.getAll()).filter(
            (target) => target.enabled,
        );

        if (targets.length === 0 || featureNames.length === 0) {
            return {
                checkedAt: new Date(),
                summary: {
                    total: featureNames.length,
                    inSync: 0,
                    outOfSync: 0,
                    missing: 0,
                    errors: 0,
                },
                // Report the targets that were considered even though nothing
                // was checked, so callers can tell "nothing to compare" apart
                // from "everything is in sync".
                targets: targets.map((target) => ({
                    targetId: target.id,
                    targetName: target.name,
                })),
                features: [],
            };
        }

        const sourceEnvironments = unique(
            targets.map((target) => target.sourceEnvironment),
        );
        const localByEnvironment = new Map<string, LoadedConfigs>();
        await Promise.all(
            sourceEnvironments.map(async (environment) => {
                localByEnvironment.set(
                    environment,
                    await this.loadConfigs(
                        projectId,
                        environment,
                        featureNames,
                    ),
                );
            }),
        );

        const remoteResults = await Promise.all(
            targets.map(async (target) => {
                try {
                    const response = await this.client.fingerprints(
                        this.toRemoteTarget(target),
                        {
                            projectId: target.project ?? projectId,
                            environment: target.targetEnvironment,
                            featureNames,
                        },
                    );
                    if (response.version !== SYNC_PROTOCOL_VERSION) {
                        return {
                            target,
                            response: undefined,
                            error: `The target uses environment sync version ${response.version}; this instance uses ${SYNC_PROTOCOL_VERSION}. Upgrade the target.`,
                        };
                    }
                    return { target, response, error: undefined };
                } catch (error) {
                    return {
                        target,
                        response: undefined,
                        error: remoteError(error),
                    };
                }
            }),
        );

        const targetViews = remoteResults.map(({ target, error }) => ({
            targetId: target.id,
            targetName: target.name,
            ...(error ? { error } : {}),
        }));

        const remoteByTarget = new Map(
            remoteResults.map(({ target, response }) => [
                target.id,
                response as
                    | {
                          version: number;
                          environmentAvailable: boolean;
                          features: EnvironmentSyncFingerprint[];
                      }
                    | undefined,
            ]),
        );
        const remoteErrorByTarget = new Map(
            remoteResults.map(({ target, error }) => [target.id, error]),
        );

        const features = featureNames.map((featureName) => {
            const targetStatuses = targets.map((target) => {
                const local = localByEnvironment.get(target.sourceEnvironment);
                const localFeature = local?.features.find(
                    (feature) => feature.name === featureName,
                );
                const remote = remoteByTarget.get(target.id);

                if (remoteErrorByTarget.get(target.id)) {
                    return {
                        targetId: target.id,
                        status: 'error' as const,
                    };
                }
                if (!localFeature?.exists) {
                    return {
                        targetId: target.id,
                        status: 'no_local_config' as const,
                    };
                }
                if (
                    !local?.environmentAvailable ||
                    !remote?.environmentAvailable
                ) {
                    return {
                        targetId: target.id,
                        status: 'env_not_available' as const,
                    };
                }
                const remoteFeature = remote.features.find(
                    (feature) => feature.name === featureName,
                );
                if (!remoteFeature?.exists) {
                    return {
                        targetId: target.id,
                        status: 'missing_remote' as const,
                    };
                }
                if (remoteFeature.archived) {
                    return {
                        targetId: target.id,
                        status: 'archived' as const,
                    };
                }
                return {
                    targetId: target.id,
                    status:
                        localFeature.fingerprint === remoteFeature.fingerprint
                            ? ('in_sync' as const)
                            : ('drift' as const),
                    strategyCount: remoteFeature.strategyCount,
                    variantCount: remoteFeature.variantCount,
                };
            });

            const hasError = targetStatuses.some(
                (status) => status.status === 'error',
            );
            const hasOutOfSync = targetStatuses.some((status) =>
                [
                    'drift',
                    'missing_remote',
                    'archived',
                    'env_not_available',
                ].includes(status.status),
            );
            const allNoConfig = targetStatuses.every(
                (status) => status.status === 'no_local_config',
            );
            const status: EnvironmentSyncFeatureStatus = hasError
                ? 'error'
                : hasOutOfSync
                  ? 'out_of_sync'
                  : allNoConfig
                    ? 'no_config'
                    : 'in_sync';

            return { featureName, status, targets: targetStatuses };
        });

        const summary = {
            total: features.length,
            inSync: features.filter((feature) => feature.status === 'in_sync')
                .length,
            outOfSync: features.filter(
                (feature) => feature.status === 'out_of_sync',
            ).length,
            missing: features.filter((feature) =>
                feature.targets.some(
                    (target) => target.status === 'missing_remote',
                ),
            ).length,
            errors: features.filter((feature) => feature.status === 'error')
                .length,
        };

        return {
            checkedAt: new Date(),
            summary,
            targets: targetViews,
            features,
        };
    }

    async compareFeature(
        projectId: string,
        featureName: string,
    ): Promise<EnvironmentSyncFeatureCompare> {
        const targets = (await this.store.getAll()).filter(
            (target) => target.enabled,
        );

        const sourceEnvironments = unique(
            targets.map((target) => target.sourceEnvironment),
        );
        const localByEnvironment = new Map<string, LoadedConfigs>();
        await Promise.all(
            sourceEnvironments.map(async (environment) => {
                localByEnvironment.set(
                    environment,
                    await this.loadConfigs(projectId, environment, [
                        featureName,
                    ]),
                );
            }),
        );

        const results = await Promise.all(
            targets.map(
                async (target): Promise<EnvironmentSyncTargetStatusView> => {
                    const local = localByEnvironment.get(
                        target.sourceEnvironment,
                    );
                    const localFeature = local?.features.find(
                        (feature) => feature.name === featureName,
                    );
                    const base = {
                        targetId: target.id,
                        targetName: target.name,
                        sourceEnvironment: target.sourceEnvironment,
                        targetEnvironment: target.targetEnvironment,
                        lastSyncedAt: target.lastSyncedAt,
                    };

                    try {
                        const remote = await this.client.config(
                            this.toRemoteTarget(target),
                            {
                                projectId: target.project ?? projectId,
                                environment: target.targetEnvironment,
                                featureName,
                            },
                        );

                        if (remote.version !== SYNC_PROTOCOL_VERSION) {
                            return {
                                ...base,
                                status: 'error',
                                differences: [],
                                error: `The target uses environment sync version ${remote.version}; this instance uses ${SYNC_PROTOCOL_VERSION}. Upgrade the target.`,
                            };
                        }
                        if (
                            !local?.environmentAvailable ||
                            !remote.environmentAvailable
                        ) {
                            return {
                                ...base,
                                status: 'env_not_available',
                                differences: [],
                                error: 'The environment is not enabled for this project',
                            };
                        }
                        if (!localFeature?.exists) {
                            const localConfig = emptyConfig();
                            const remoteConfig = canonicalRemoteConfig(remote);
                            return {
                                ...base,
                                status: 'no_local_config',
                                differences: [],
                                local: localConfig,
                                remote: remoteConfig,
                                diff: diffEnvironmentSyncConfigs(
                                    localConfig,
                                    remoteConfig,
                                ),
                            };
                        }
                        if (localFeature.archived) {
                            const remoteConfig = canonicalRemoteConfig(remote);
                            return {
                                ...base,
                                status: 'archived',
                                differences: [],
                                local: localFeature.config,
                                remote: remoteConfig,
                                diff: diffEnvironmentSyncConfigs(
                                    localFeature.config,
                                    remoteConfig,
                                ),
                            };
                        }
                        if (remote.archived) {
                            const remoteConfig = canonicalRemoteConfig(remote);
                            return {
                                ...base,
                                status: 'archived',
                                differences: [],
                                local: localFeature.config,
                                remote: remoteConfig,
                                diff: diffEnvironmentSyncConfigs(
                                    localFeature.config,
                                    remoteConfig,
                                ),
                            };
                        }
                        if (!remote.exists) {
                            const remoteConfig = emptyConfig();
                            return {
                                ...base,
                                status: 'missing_remote',
                                differences: [],
                                local: localFeature.config,
                                remote: remoteConfig,
                                diff: diffEnvironmentSyncConfigs(
                                    localFeature.config,
                                    remoteConfig,
                                ),
                            };
                        }

                        const remoteConfig = canonicalRemoteConfig(remote);
                        const remoteFingerprint =
                            fingerprintConfig(remoteConfig);
                        const inSync =
                            remoteFingerprint === localFeature.fingerprint;
                        return {
                            ...base,
                            status: inSync ? 'in_sync' : 'drift',
                            differences: inSync
                                ? []
                                : diffConfigs(
                                      localFeature.config,
                                      remoteConfig,
                                  ),
                            local: localFeature.config,
                            remote: remoteConfig,
                            diff: diffEnvironmentSyncConfigs(
                                localFeature.config,
                                remoteConfig,
                            ),
                        };
                    } catch (error) {
                        return {
                            ...base,
                            status: 'error',
                            differences: [],
                            error: remoteError(error),
                        };
                    }
                },
            ),
        );

        return { featureName, targets: results };
    }

    // ---------------------------------------------------------------------
    // Sync
    // ---------------------------------------------------------------------

    async sync(
        projectId: string,
        featureNames: string[],
        targetIds: number[] | undefined,
        onlyOutOfSync: boolean,
        auditUser: IAuditUser,
    ): Promise<{ results: EnvironmentSyncSyncResult[] }> {
        const allTargets = (await this.store.getAll()).filter(
            (target) => target.enabled,
        );
        const targets = targetIds?.length
            ? allTargets.filter((target) => targetIds.includes(target.id))
            : allTargets;

        if (targets.length === 0) {
            return { results: [] };
        }

        const status = onlyOutOfSync
            ? await this.getProjectStatus(projectId, { refresh: true })
            : undefined;
        const statusByFeature = new Map(
            (status?.features ?? []).map((feature) => [
                feature.featureName,
                feature,
            ]),
        );

        const sourceEnvironments = unique(
            targets.map((target) => target.sourceEnvironment),
        );
        const localByEnvironment = new Map<string, LoadedConfigs>();
        await Promise.all(
            sourceEnvironments.map(async (environment) => {
                localByEnvironment.set(
                    environment,
                    await this.loadConfigs(
                        projectId,
                        environment,
                        featureNames,
                    ),
                );
            }),
        );

        const results: EnvironmentSyncSyncResult[] = [];

        for (const target of targets) {
            const local = localByEnvironment.get(target.sourceEnvironment);
            const configs: {
                featureName: string;
                strategies: EnvironmentSyncStrategy[];
                variants: EnvironmentSyncVariant[];
            }[] = [];
            const skipped: EnvironmentSyncSyncResult['features'] = [];

            for (const featureName of featureNames) {
                const localFeature = local?.features.find(
                    (feature) => feature.name === featureName,
                );
                if (!local?.environmentAvailable || !localFeature?.exists) {
                    skipped.push({
                        featureName,
                        status: 'skipped',
                        error: 'No configuration found in the source environment',
                    });
                    continue;
                }
                if (localFeature.archived) {
                    skipped.push({
                        featureName,
                        status: 'skipped',
                        error: 'The feature flag is archived',
                    });
                    continue;
                }
                if (onlyOutOfSync) {
                    const featureStatus = statusByFeature.get(featureName);
                    const targetStatus = featureStatus?.targets.find(
                        (entry) => entry.targetId === target.id,
                    );
                    if (
                        !targetStatus ||
                        targetStatus.status === 'in_sync' ||
                        targetStatus.status === 'no_local_config' ||
                        targetStatus.status === 'env_not_available' ||
                        targetStatus.status === 'archived'
                    ) {
                        skipped.push({
                            featureName,
                            status: 'skipped',
                            error: 'Already in sync',
                        });
                        continue;
                    }
                }
                configs.push({
                    featureName,
                    strategies: localFeature.config.strategies,
                    variants: localFeature.config.variants,
                });
            }

            if (configs.length === 0) {
                results.push({
                    targetId: target.id,
                    targetName: target.name,
                    features: skipped,
                });
                continue;
            }

            // Target ids are global, so two projects can sync a flag with the
            // same name to the same target. The remote project is part of what
            // is actually written, so it must be part of the lock key.
            const remoteProjectId = target.project ?? projectId;
            const inFlightKey = `${target.id}:${remoteProjectId}:${configs
                .map((config) => config.featureName)
                .sort()
                .join(',')}`;
            const existing = this.inFlight.get(inFlightKey);
            if (existing) {
                await existing;
                results.push({
                    targetId: target.id,
                    targetName: target.name,
                    features: configs.map((config) => ({
                        featureName: config.featureName,
                        status: 'skipped' as const,
                        error: 'A sync for these flags is already running',
                    })),
                });
                continue;
            }

            const promise = this.client
                .applyConfigs(this.toRemoteTarget(target), {
                    projectId: remoteProjectId,
                    environment: target.targetEnvironment,
                    configs,
                })
                .finally(() => {
                    this.inFlight.delete(inFlightKey);
                });
            this.inFlight.set(inFlightKey, promise);

            try {
                const response = await promise;
                const applied = response.results.map((result) => ({
                    featureName: result.featureName,
                    status:
                        result.status === 'synced'
                            ? ('synced' as const)
                            : result.status === 'skipped'
                              ? ('skipped' as const)
                              : ('error' as const),
                    created: result.created,
                    error: result.error,
                }));
                const synced = applied.filter(
                    (result) => result.status === 'synced',
                );

                await this.store.updateSyncState(target.id, {
                    status: applied.some((result) => result.status === 'error')
                        ? 'error'
                        : 'ok',
                    error: applied.find((result) => result.error)?.error,
                    at: new Date(),
                });

                if (synced.length > 0) {
                    await this.eventService.storeEvent(
                        new FeatureConfigsSyncedEvent({
                            project: projectId,
                            environment: target.sourceEnvironment,
                            targetName: target.name,
                            targetEnvironment: target.targetEnvironment,
                            featureNames: synced.map(
                                (result) => result.featureName,
                            ),
                            createdCount: synced.filter(
                                (result) => result.created,
                            ).length,
                            auditUser,
                        }),
                    );
                }

                results.push({
                    targetId: target.id,
                    targetName: target.name,
                    features: [...applied, ...skipped],
                });
            } catch (error) {
                const message = remoteError(error);
                await this.store.updateSyncState(target.id, {
                    status: 'error',
                    error: message,
                    at: new Date(),
                });
                results.push({
                    targetId: target.id,
                    targetName: target.name,
                    features: [
                        ...configs.map((config) => ({
                            featureName: config.featureName,
                            status: 'error' as const,
                            error: message,
                        })),
                        ...skipped,
                    ],
                });
            }
        }

        this.invalidateStatusCache(projectId);
        return { results };
    }

    // ---------------------------------------------------------------------
    // Peer endpoints (used when this instance is a sync target)
    // ---------------------------------------------------------------------

    async getConfigFingerprints(
        projectId: string,
        environment: string,
        featureNames?: string[],
    ): Promise<{
        version: number;
        environmentAvailable: boolean;
        features: EnvironmentSyncFingerprint[];
    }> {
        const loaded = await this.loadConfigs(
            projectId,
            environment,
            featureNames,
        );
        return {
            version: SYNC_PROTOCOL_VERSION,
            environmentAvailable: loaded.environmentAvailable,
            features: loaded.features.map((feature) => ({
                name: feature.name,
                exists: feature.exists,
                archived: feature.archived,
                fingerprint: feature.exists ? feature.fingerprint : null,
                strategyCount: feature.strategyCount,
                variantCount: feature.variantCount,
            })),
        };
    }

    async getConfigSnapshot(
        projectId: string,
        environment: string,
        featureName: string,
    ): Promise<{
        version: number;
        environmentAvailable: boolean;
        exists: boolean;
        archived: boolean;
        strategies: EnvironmentSyncStrategy[];
        variants: EnvironmentSyncVariant[];
    }> {
        const loaded = await this.loadConfigs(projectId, environment, [
            featureName,
        ]);
        const feature = loaded.features[0];
        return {
            version: SYNC_PROTOCOL_VERSION,
            environmentAvailable: loaded.environmentAvailable,
            exists: feature?.exists ?? false,
            archived: feature?.archived ?? false,
            strategies: feature?.config.strategies ?? [],
            variants: feature?.config.variants ?? [],
        };
    }

    /**
     * Returns the subset of `featureNames` that already exists on this
     * instance. Used by the peer endpoint to work out whether applying a
     * config would create a flag.
     */
    async getExistingFeatureNames(
        featureNames: string[],
    ): Promise<Set<string>> {
        if (featureNames.length === 0) {
            return new Set();
        }
        const rows = await this.featureToggleStore.getAllByNames(featureNames);
        return new Set(rows.map((row) => row.name));
    }

    async resolveSegmentIds(
        projectId: string,
        strategies: EnvironmentSyncStrategy[],
    ): Promise<(EnvironmentSyncStrategy & { segmentIds: number[] })[]> {
        const segments = await this.segmentReadModel.getAll();

        // Segment names are not unique: a global segment and a project
        // segment (or two segments in different scopes) can share a name.
        // Resolving by name would silently pick an arbitrary one and change
        // who the strategy targets, so ambiguity is rejected instead.
        const candidatesByName = new Map<string, number[]>();
        for (const segment of segments) {
            if (segment.project && segment.project !== projectId) {
                continue;
            }
            const candidates = candidatesByName.get(segment.name) ?? [];
            candidates.push(segment.id);
            candidatesByName.set(segment.name, candidates);
        }

        const idsByName = new Map<string, number>();
        const ambiguous = new Set<string>();
        for (const [name, candidates] of candidatesByName) {
            if (candidates.length === 1) {
                idsByName.set(name, candidates[0]);
            } else if (candidates.length > 1) {
                ambiguous.add(name);
            }
        }

        const missing = new Set<string>();
        const resolved = strategies.map((strategy) => {
            const segmentIds = (strategy.segments ?? []).map((name) => {
                const id = idsByName.get(name);
                if (id === undefined && !ambiguous.has(name)) {
                    missing.add(name);
                }
                return id ?? 0;
            });
            return { ...strategy, segmentIds };
        });

        if (missing.size > 0) {
            throw new BadDataError(
                `These segments do not exist on the target instance: ${[
                    ...missing,
                ].join(', ')}`,
            );
        }

        if (ambiguous.size > 0) {
            const names = [...ambiguous].join(', ');
            throw new BadDataError(
                `These segment names match more than one segment on the target instance: ${names}. Rename the duplicates so each name is unique.`,
            );
        }

        return resolved;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    private async loadConfigs(
        projectId: string,
        environment: string,
        featureNames?: string[],
    ): Promise<LoadedConfigs> {
        const environmentAvailable = await this.isEnvironmentAvailable(
            projectId,
            environment,
        );

        const names =
            featureNames ??
            (
                await this.featureToggleStore.getAll({
                    project: projectId,
                    archived: false,
                })
            ).map((feature) => feature.name);

        if (names.length === 0) {
            return { environmentAvailable, features: [] };
        }

        const [
            featureRows,
            strategyRows,
            environmentRows,
            segments,
            strategySegments,
        ] = await Promise.all([
            this.featureToggleStore.getAllByNames(names),
            this.featureStrategiesStore.getAllByFeatures(names, environment),
            this.featureEnvironmentStore.getAllByFeatures(names, environment),
            this.segmentReadModel.getAll(),
            this.segmentReadModel.getAllFeatureStrategySegments(),
        ]);

        const segmentNamesById = new Map(
            segments.map((segment) => [segment.id, segment.name]),
        );
        const projectFeatures = featureRows.filter(
            (feature) => feature.project === projectId,
        );

        const features = names.map((name): LoadedConfig => {
            const feature = projectFeatures.find((row) => row.name === name);
            const exists = Boolean(feature);
            const archived = Boolean(feature?.archivedAt);

            if (!exists) {
                const config = emptyConfig();
                return {
                    name,
                    exists,
                    archived,
                    config,
                    fingerprint: fingerprintConfig(config),
                    strategyCount: 0,
                    variantCount: 0,
                };
            }

            const strategies = strategyRows
                .filter((strategy) => strategy.featureName === name)
                .sort(
                    (a, b) =>
                        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
                            (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
                        (a.createdAt?.getTime() ?? 0) -
                            (b.createdAt?.getTime() ?? 0) ||
                        a.id.localeCompare(b.id),
                );
            const environmentRow: IFeatureEnvironment | undefined =
                environmentRows.find((row) => row.featureName === name);

            const config = canonicalConfig({
                strategies:
                    strategies as unknown as RawEnvironmentSyncStrategy[],
                variants: environmentRow?.variants ?? [],
                strategySegments,
                segmentNamesById,
            });

            return {
                name,
                exists,
                archived,
                config,
                fingerprint: fingerprintConfig(config),
                strategyCount: config.strategies.length,
                variantCount: config.variants.length,
            };
        });

        return { environmentAvailable, features };
    }

    private async isEnvironmentAvailable(
        projectId: string,
        environment: string,
    ): Promise<boolean> {
        const environments =
            await this.environmentService.getProjectEnvironments(projectId);
        return environments.some(
            (entry) => entry.name === environment && entry.visible,
        );
    }

    private async validateTargetInput(
        input: EnvironmentSyncTargetInput,
    ): Promise<void> {
        if (!input.name.trim()) {
            throw new BadDataError('An environment name is required');
        }
        if (!input.targetEnvironment.trim()) {
            throw new BadDataError('A target environment is required');
        }
        if (!input.sourceEnvironment) {
            throw new BadDataError('A source environment is required');
        }

        const sourceExists = await this.environmentService.exists(
            input.sourceEnvironment,
        );
        if (!sourceExists) {
            throw new BadDataError(
                `The source environment "${input.sourceEnvironment}" does not exist`,
            );
        }

        try {
            const parsed = new URL(input.url.trim());
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error(`Invalid protocol: ${parsed.protocol}`);
            }
        } catch (error) {
            throw new BadDataError(
                `The instance URL is not valid: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private toRemoteTarget(
        target: EnvironmentSyncTargetWithToken,
    ): EnvironmentSyncRemoteTarget {
        return {
            name: target.name,
            url: target.url,
            project: target.project,
            targetEnvironment: target.targetEnvironment,
            token: this.decryptToken(target),
        };
    }

    private getEncryptionKey(): Buffer | null {
        const raw = this.config.environmentSyncEncryptionKey;
        if (!raw) {
            return null;
        }
        const key = Buffer.from(raw, 'base64');
        return key.length === 32 ? key : null;
    }

    private requireEncryptionKey(): Buffer {
        const key = this.getEncryptionKey();
        if (!key) {
            throw new BadDataError(
                'Saving target tokens requires UNLEASH_SYNC_ENCRYPTION_KEY to be set to a base64-encoded 32-byte key (openssl rand -base64 32).',
            );
        }
        return key;
    }

    private decryptToken(target: EnvironmentSyncTargetWithToken): string {
        const key = this.requireEncryptionKey();
        try {
            return decryptSecret(key, target.tokenEnc).toString('utf8');
        } catch {
            throw new BadDataError(
                `The saved token for "${target.name}" could not be decrypted. Re-enter the token.`,
            );
        }
    }

    private invalidateStatusCache(projectId?: string): void {
        if (projectId) {
            this.statusCache.delete(projectId);
        } else {
            this.statusCache.clear();
        }
    }
}

const canonicalRemoteConfig = (remote: {
    strategies: EnvironmentSyncStrategy[];
    variants: EnvironmentSyncVariant[];
}): EnvironmentSyncConfig => ({
    strategies: remote.strategies,
    variants: remote.variants,
});

const remoteError = (error: unknown): string => {
    if (error instanceof EnvironmentSyncRemoteError) {
        return error.message;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
};
