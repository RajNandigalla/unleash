import type { IUnleashConfig } from '../../types/option.js';
import type {
    IAuditUser,
    IFeatureEnvironment,
    IFeatureEnvironmentStore,
    IFeatureStrategiesStore,
    IFeatureTagStore,
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
    emptyIgnoredConfig,
    fingerprintConfig,
    ignoredConfigForFeature,
    groupIgnoredEntries,
    isFeatureIgnored,
    matchesIgnoreRule,
    mergeIgnoredJsonValue,
    parseCompleteIgnoredConfig,
    parseIgnoredConfig,
    preserveJsonString,
    payloadIgnoreFor,
    type IgnoredEntryGroup,
    stableStringify,
    SYNC_PROTOCOL_VERSION,
    type EnvironmentSyncConfig,
    type EnvironmentSyncDifference,
    type EnvironmentSyncIgnoredConfig,
    type EnvironmentSyncStrategy,
    type EnvironmentSyncVariant,
    type RawEnvironmentSyncStrategy,
} from './environment-sync-config.js';
import {
    collectEnvironmentSyncCatalog,
    type EnvironmentSyncCatalog,
    type EnvironmentSyncCatalogEntry,
    type EnvironmentSyncCatalogFlag,
    type EnvironmentSyncCatalogKind,
} from './environment-sync-catalog.js';
import {
    diffEnvironmentSyncConfigs,
    type EnvironmentSyncDiff,
} from './environment-sync-diff.js';
import {
    EnvironmentSyncRemoteError,
    normalizeUrl,
    type EnvironmentSyncClient,
    type EnvironmentSyncFingerprint,
    type EnvironmentSyncRemoteCatalog,
    type EnvironmentSyncRemoteTarget,
} from './environment-sync-client.js';
import type {
    EnvironmentSyncTargetInsert,
    EnvironmentSyncTargetWithToken,
    IEnvironmentSyncTargetStore,
} from './environment-sync-target-store-type.js';
import {
    EnvironmentSyncFeatureExclusionChangedEvent,
    EnvironmentSyncTargetChangedEvent,
    EnvironmentSyncTargetConfigUpdatedEvent,
    FeatureConfigsSyncedEvent,
} from '../../types/index.js';

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
    | 'excluded'
    | 'error';

export type EnvironmentSyncFeatureStatus =
    | 'in_sync'
    | 'out_of_sync'
    | 'no_config'
    | 'excluded'
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

export interface EnvironmentSyncCatalogEntryView {
    entry: string;
    kind: EnvironmentSyncCatalogKind;
    local?: EnvironmentSyncCatalogEntry;
    remote?: EnvironmentSyncCatalogEntry;
    differs: boolean;
}

export interface EnvironmentSyncCatalogView {
    sourceEnvironment: string;
    targetEnvironment?: string;
    comparedWithTarget: boolean;
    entries: EnvironmentSyncCatalogEntryView[];
    flags: EnvironmentSyncCatalogFlag[];
    remoteError?: string;
    truncated: boolean;
}

export interface EnvironmentSyncProjectStatus {
    checkedAt: Date;
    summary: {
        total: number;
        inSync: number;
        outOfSync: number;
        missing: number;
        excluded: number;
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
    ignoredConfig?: EnvironmentSyncIgnoredConfig;
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
    featureTagStore: IFeatureTagStore;
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

const isJsonContainerString = (value: string): boolean => {
    try {
        const parsed = JSON.parse(value);
        return parsed !== null && typeof parsed === 'object';
    } catch {
        return false;
    }
};

const hasJsonConfigValues = (config: {
    strategies: EnvironmentSyncStrategy[];
    variants: EnvironmentSyncVariant[];
}): boolean =>
    config.strategies.some((strategy) =>
        Object.values(strategy.parameters ?? {}).some(isJsonContainerString),
    ) ||
    [
        ...config.variants,
        ...config.strategies.flatMap((s) => s.variants ?? []),
    ].some((variant) => variant.payload?.type === 'json');

export class EnvironmentSyncService {
    private readonly store: IEnvironmentSyncTargetStore;

    private readonly featureToggleStore: IFeatureToggleStore;

    private readonly featureStrategiesStore: IFeatureStrategiesStore;

    private readonly featureEnvironmentStore: IFeatureEnvironmentStore;

    private readonly featureTagStore: IFeatureTagStore;

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
        this.featureTagStore = stores.featureTagStore;
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
        const token = input?.token?.trim();
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
            ignoredConfig: parseIgnoredConfig(input.ignoredConfig),
            enabled: input.enabled ?? true,
            createdBy: auditUser.username ?? null,
        };
        const target = await this.store.insert(create);
        this.invalidateStatusCache();
        await this.recordTargetChanged('created', target, auditUser);
        return toTargetView(target);
    }

    async updateTarget(
        id: number,
        input: EnvironmentSyncTargetInput,
        auditUser: IAuditUser,
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
        const ignoredConfig =
            input.ignoredConfig !== undefined
                ? parseCompleteIgnoredConfig(input.ignoredConfig)
                : undefined;

        const target = await this.store.update(id, {
            name,
            url: normalizeUrl(input.url.trim()),
            ...(token && key ? { tokenEnc: encryptSecret(key, token) } : {}),
            project: input.project?.trim() || null,
            sourceEnvironment: input.sourceEnvironment,
            targetEnvironment: input.targetEnvironment.trim(),
            ...(ignoredConfig !== undefined && { ignoredConfig }),
            enabled: input.enabled ?? existing.enabled,
        });
        this.invalidateStatusCache();
        await this.recordTargetChanged('updated', target, auditUser);
        if (ignoredConfig) {
            await this.recordIgnoredConfigUpdated(
                target,
                ignoredConfig,
                auditUser,
            );
        }
        return toTargetView(target);
    }

    /**
     * Updates only the environment-specific values and exclusion rules, so
     * they can be managed (and imported) without touching the connection or
     * the token.
     */
    async updateTargetIgnoredConfig(
        id: number,
        input: unknown,
        auditUser: IAuditUser,
    ): Promise<EnvironmentSyncTargetView> {
        await this.store.get(id);
        const ignoredConfig = parseCompleteIgnoredConfig(input);
        const target = await this.store.update(id, { ignoredConfig });
        this.invalidateStatusCache();
        await this.recordIgnoredConfigUpdated(target, ignoredConfig, auditUser);
        return toTargetView(target);
    }

    private async recordTargetChanged(
        action: 'created' | 'updated' | 'deleted',
        target: EnvironmentSyncTargetWithToken,
        auditUser: IAuditUser,
    ): Promise<void> {
        await this.eventService.storeEvent(
            new EnvironmentSyncTargetChangedEvent({
                action,
                targetId: target.id,
                targetName: target.name,
                auditUser,
            }),
        );
    }

    private async recordIgnoredConfigUpdated(
        target: EnvironmentSyncTargetWithToken,
        ignoredConfig: EnvironmentSyncIgnoredConfig,
        auditUser: IAuditUser,
    ): Promise<void> {
        await this.eventService.storeEvent(
            new EnvironmentSyncTargetConfigUpdatedEvent({
                targetId: target.id,
                targetName: target.name,
                parameters: ignoredConfig.parameters.length,
                variantPayloads: ignoredConfig.variantPayloads.length,
                ignoredFeatures: ignoredConfig.ignoredFeatures.length,
                featureFields: ignoredConfig.featureFields?.length ?? 0,
                auditUser,
            }),
        );
    }

    /**
     * Includes or excludes one flag from sync without touching the other
     * values or rules. A flag that a glob or tag rule already matches cannot
     * be included this way; the reason explains which rule to change.
     */
    async setFeatureExclusion(
        id: number,
        input: { featureName?: string; excluded?: boolean },
        auditUser: IAuditUser,
    ): Promise<{ excluded: boolean; changed: boolean; reason?: string }> {
        const featureName = input.featureName?.trim();
        if (!featureName) {
            throw new BadDataError('featureName is required');
        }
        if (typeof input.excluded !== 'boolean') {
            throw new BadDataError('excluded must be a boolean');
        }

        const target = await this.store.get(id);
        const tagsByFeature = await this.getTagsByFeature([featureName]);
        const tags = tagsByFeature.get(featureName) ?? [];
        const rules = target.ignoredConfig.ignoredFeatures;
        const matchingRules = rules.filter((rule) =>
            matchesIgnoreRule(featureName, tags, rule),
        );
        const exactRule = rules.includes(featureName);

        const save = async (ignoredFeatures: string[]) => {
            await this.store.update(id, {
                ignoredConfig: { ...target.ignoredConfig, ignoredFeatures },
            });
            this.invalidateStatusCache();
            await this.eventService.storeEvent(
                new EnvironmentSyncFeatureExclusionChangedEvent({
                    targetId: target.id,
                    targetName: target.name,
                    featureName,
                    excluded: ignoredFeatures.some((rule) =>
                        matchesIgnoreRule(featureName, tags, rule),
                    ),
                    auditUser,
                }),
            );
        };

        if (input.excluded) {
            if (matchingRules.length > 0) {
                return {
                    excluded: true,
                    changed: false,
                    reason: `This flag is already excluded by the rule "${matchingRules[0]}".`,
                };
            }
            await save([...rules, featureName]);
            return { excluded: true, changed: true };
        }

        if (!exactRule) {
            if (matchingRules.length > 0) {
                return {
                    excluded: true,
                    changed: false,
                    reason: `This flag is excluded by the rule "${matchingRules[0]}". Change that rule on the environment configuration page.`,
                };
            }
            return { excluded: false, changed: false };
        }

        const remaining = rules.filter((rule) => rule !== featureName);
        await save(remaining);
        const stillMatching = remaining.filter((rule) =>
            matchesIgnoreRule(featureName, tags, rule),
        );
        if (stillMatching.length > 0) {
            return {
                excluded: true,
                changed: true,
                reason: `Still excluded by the rule "${stillMatching[0]}".`,
            };
        }
        return { excluded: false, changed: true };
    }

    /**
     * Names, projects and tags of every flag. The admin UI needs this to show
     * which flags a target's exclusion rules match without scanning all
     * configurations.
     */
    async getFlags(): Promise<EnvironmentSyncCatalogFlag[]> {
        const rows = await this.featureToggleStore.getAll({ archived: false });
        const tagsByFeature = await this.getTagsByFeature(
            rows.map((flag) => flag.name),
        );
        return rows.map((flag) => ({
            name: flag.name,
            project: flag.project ?? null,
            tags: tagsByFeature.get(flag.name) ?? [],
        }));
    }

    async deleteTarget(id: number, auditUser: IAuditUser): Promise<void> {
        const target = await this.store.get(id);
        await this.store.delete(id);
        this.invalidateStatusCache();
        await this.recordTargetChanged('deleted', target, auditUser);
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
        if (!input || typeof input.url !== 'string' || !input.url.trim()) {
            throw new BadDataError('The instance URL is required');
        }
        if (typeof input.token !== 'string' || !input.token.trim()) {
            throw new BadDataError('An access token is required');
        }

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

    /**
     * Lists every strategy parameter and variant payload path in the instance
     * with its source and target values, so the UI can offer a checklist
     * instead of asking operators to type paths from memory.
     */
    async getCatalog(input: {
        sourceEnvironment?: string;
        targetEnvironment?: string;
        targetId?: number;
        url?: string;
        token?: string;
    }): Promise<EnvironmentSyncCatalogView> {
        const target =
            input.targetId !== undefined
                ? await this.store.get(input.targetId)
                : undefined;

        const sourceEnvironment =
            input.sourceEnvironment ?? target?.sourceEnvironment;
        if (!sourceEnvironment) {
            throw new BadDataError('A source environment is required');
        }
        if (!(await this.environmentService.exists(sourceEnvironment))) {
            throw new BadDataError(
                `The source environment "${sourceEnvironment}" does not exist`,
            );
        }

        const remoteUrl = target?.url ?? input.url?.trim();
        let remoteToken: string | undefined;
        let tokenError: string | undefined;
        if (target) {
            try {
                remoteToken = this.decryptToken(target);
            } catch (error) {
                tokenError = remoteError(error);
            }
        } else {
            remoteToken = input.token?.trim();
        }
        const targetEnvironment =
            input.targetEnvironment ?? target?.targetEnvironment;

        const flagRows = await this.featureToggleStore.getAll({
            archived: false,
        });
        const tagsByFeature = await this.getTagsByFeature(
            flagRows.map((flag) => flag.name),
        );
        const flags: EnvironmentSyncCatalogFlag[] = flagRows.map((flag) => ({
            name: flag.name,
            project: flag.project ?? null,
            tags: tagsByFeature.get(flag.name) ?? [],
        }));

        const localConfigs = await this.loadAllConfigs(sourceEnvironment);
        const local = collectEnvironmentSyncCatalog(
            sourceEnvironment,
            localConfigs,
            flags,
        );

        let remote: EnvironmentSyncCatalog | undefined;
        let remoteCatalogError: string | undefined = tokenError;
        const comparedWithTarget = Boolean(
            remoteUrl && remoteToken && targetEnvironment,
        );

        if (remoteUrl && remoteToken && targetEnvironment) {
            try {
                const response = await this.client.catalog(
                    {
                        name: target?.name ?? 'target',
                        url: remoteUrl,
                        project: target?.project ?? null,
                        targetEnvironment,
                        token: remoteToken,
                    },
                    {
                        environment: targetEnvironment,
                        featureNames: flags.map((flag) => flag.name),
                    },
                );
                if (response.version !== SYNC_PROTOCOL_VERSION) {
                    remoteCatalogError = `The target uses environment sync version ${response.version}; this instance uses ${SYNC_PROTOCOL_VERSION}. Upgrade the target.`;
                } else {
                    remote = {
                        environment: response.environment,
                        entries: response.entries,
                        flags: response.flags.map((name) => ({
                            name,
                            project: null,
                            tags: [],
                        })),
                        truncated: response.truncated,
                    };
                }
            } catch (error) {
                remoteCatalogError = remoteError(error);
            }
        }

        const entries = new Map<string, EnvironmentSyncCatalogEntryView>();
        for (const entry of local.entries) {
            entries.set(entry.entry, {
                entry: entry.entry,
                kind: entry.kind,
                local: entry,
                differs: true,
            });
        }
        for (const entry of remote?.entries ?? []) {
            const existing = entries.get(entry.entry);
            if (existing) {
                existing.remote = entry;
            } else {
                entries.set(entry.entry, {
                    entry: entry.entry,
                    kind: entry.kind,
                    remote: entry,
                    differs: true,
                });
            }
        }

        const remoteFlagNames = new Set(
            (remote?.flags ?? []).map((flag) => flag.name),
        );
        const commonFlags = flags
            .map((flag) => flag.name)
            .filter((name) => remoteFlagNames.has(name));

        const merged = [...entries.values()].map((entry) => ({
            ...entry,
            differs: remote
                ? commonFlags.some(
                      (name) =>
                          (entry.local?.valuesByFlag?.[name] ?? null) !==
                          (entry.remote?.valuesByFlag?.[name] ?? null),
                  )
                : true,
        }));
        merged.sort(
            (a, b) =>
                Number(b.differs) - Number(a.differs) ||
                (b.local?.flagCount ?? b.remote?.flagCount ?? 0) -
                    (a.local?.flagCount ?? a.remote?.flagCount ?? 0) ||
                a.entry.localeCompare(b.entry),
        );

        return {
            sourceEnvironment,
            ...(targetEnvironment ? { targetEnvironment } : {}),
            comparedWithTarget,
            entries: merged,
            flags,
            ...(remoteCatalogError ? { remoteError: remoteCatalogError } : {}),
            truncated: local.truncated || Boolean(remote?.truncated),
        };
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

    private localConfigKey(
        environment: string,
        ignored: EnvironmentSyncIgnoredConfig,
    ): string {
        return `${environment}|${stableStringify(ignored)}`;
    }

    /**
     * Local fingerprints depend on the target's environment-specific values,
     * so two targets that share a source environment but ignore different
     * fields need their own copy.
     */
    private loadLocalConfigsByTarget(
        projectId: string,
        featureNames: string[],
        targets: EnvironmentSyncTargetWithToken[],
    ): Map<string, Promise<LoadedConfigs>> {
        const localByKey = new Map<string, Promise<LoadedConfigs>>();
        for (const target of targets) {
            const key = this.localConfigKey(
                target.sourceEnvironment,
                target.ignoredConfig,
            );
            if (!localByKey.has(key)) {
                localByKey.set(
                    key,
                    this.loadConfigs(
                        projectId,
                        target.sourceEnvironment,
                        featureNames,
                        target.ignoredConfig,
                    ),
                );
            }
        }
        return localByKey;
    }

    private async resolveLocalConfigs(
        localByKey: Map<string, Promise<LoadedConfigs>>,
    ): Promise<Map<string, LoadedConfigs>> {
        const resolved = new Map<string, LoadedConfigs>();
        for (const [key, promise] of localByKey) {
            resolved.set(key, await promise);
        }
        return resolved;
    }

    private async calculateProjectStatus(
        projectId: string,
    ): Promise<EnvironmentSyncProjectStatus> {
        const allFeatures = await this.featureToggleStore.getAll({
            project: projectId,
            archived: false,
        });
        const featureNames = allFeatures.map((feature) => feature.name);
        const tagsByFeature = await this.getTagsByFeature(featureNames);
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
                    excluded: 0,
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

        const localConfigs = await this.resolveLocalConfigs(
            this.loadLocalConfigsByTarget(projectId, featureNames, targets),
        );

        const targetFeatureNames = new Map(
            targets.map((target) => [
                target.id,
                featureNames.filter(
                    (featureName) =>
                        !isFeatureIgnored(
                            featureName,
                            target.ignoredConfig,
                            tagsByFeature.get(featureName) ?? [],
                        ),
                ),
            ]),
        );

        const remoteResults = await Promise.all(
            targets.map(async (target) => {
                const names = targetFeatureNames.get(target.id) ?? [];
                if (names.length === 0) {
                    return { target, response: undefined, error: undefined };
                }
                try {
                    const response = await this.client.fingerprints(
                        this.toRemoteTarget(target),
                        {
                            projectId: target.project ?? projectId,
                            environment: target.targetEnvironment,
                            featureNames: names,
                            ignoredConfig: target.ignoredConfig,
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
                if (
                    isFeatureIgnored(
                        featureName,
                        target.ignoredConfig,
                        tagsByFeature.get(featureName) ?? [],
                    )
                ) {
                    return {
                        targetId: target.id,
                        status: 'excluded' as const,
                    };
                }

                const local = localConfigs.get(
                    this.localConfigKey(
                        target.sourceEnvironment,
                        target.ignoredConfig,
                    ),
                );
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
            const allExcluded = targetStatuses.every(
                (status) => status.status === 'excluded',
            );
            const status: EnvironmentSyncFeatureStatus = hasError
                ? 'error'
                : hasOutOfSync
                  ? 'out_of_sync'
                  : allExcluded
                    ? 'excluded'
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
            excluded: features.filter(
                (feature) => feature.status === 'excluded',
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

        const localConfigs = await this.resolveLocalConfigs(
            this.loadLocalConfigsByTarget(projectId, [featureName], targets),
        );
        const tagsByFeature = await this.getTagsByFeature([featureName]);

        const results = await Promise.all(
            targets.map(
                async (target): Promise<EnvironmentSyncTargetStatusView> => {
                    const local = localConfigs.get(
                        this.localConfigKey(
                            target.sourceEnvironment,
                            target.ignoredConfig,
                        ),
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

                    if (
                        isFeatureIgnored(
                            featureName,
                            target.ignoredConfig,
                            tagsByFeature.get(featureName) ?? [],
                        )
                    ) {
                        return {
                            ...base,
                            status: 'excluded',
                            differences: [],
                        };
                    }

                    try {
                        const remote = await this.client.config(
                            this.toRemoteTarget(target),
                            {
                                projectId: target.project ?? projectId,
                                environment: target.targetEnvironment,
                                featureName,
                                ignoredConfig: target.ignoredConfig,
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

    /**
     * Restores the target environment's own values for every configured
     * environment-specific entry. The source's values for those entries are
     * never written to the target.
     */
    async preserveEnvironmentSpecificValues(
        projectId: string,
        environment: string,
        config: {
            featureName: string;
            strategies: EnvironmentSyncStrategy[];
            variants: EnvironmentSyncVariant[];
        },
        ignored: EnvironmentSyncIgnoredConfig = emptyIgnoredConfig(),
    ): Promise<{
        strategies: EnvironmentSyncStrategy[];
        variants: EnvironmentSyncVariant[];
    }> {
        const effectiveIgnored = ignoredConfigForFeature(
            ignored,
            config.featureName,
        );
        const parameterEntries = groupIgnoredEntries(
            effectiveIgnored.parameters,
        );
        const payloadEntries = groupIgnoredEntries(
            effectiveIgnored.variantPayloads,
        );

        if (
            parameterEntries.size === 0 &&
            payloadEntries.size === 0 &&
            !hasJsonConfigValues(config)
        ) {
            return config;
        }

        const [strategyRows, environmentRow] = await Promise.all([
            this.featureStrategiesStore.getStrategiesForFeatureEnv(
                projectId,
                config.featureName,
                environment,
            ),
            // A new flag (or a flag without this environment yet) has no
            // environment row. There is nothing to preserve in that case; the
            // write below is what reports an environment that cannot be used.
            this.featureEnvironmentStore
                .get({ featureName: config.featureName, environment })
                .catch(() => undefined),
        ]);

        // Canonicalise with the default (empty) ignore config so the values
        // we are about to preserve are actually visible.
        const existing = canonicalConfig({
            strategies: strategyRows as unknown as RawEnvironmentSyncStrategy[],
            variants: environmentRow?.variants ?? [],
            strategySegments: [],
            segmentNamesById: new Map(),
        });

        const matches = matchStrategies(config.strategies, existing.strategies);
        const lost: string[] = [];

        // A strategy that did not exist on the target yet has no direct
        // counterpart to copy from. When every ignored key lives on exactly one
        // existing strategy, that strategy is the environment's value.
        const hasIgnoredParameter = (strategy: EnvironmentSyncStrategy) =>
            [...parameterEntries.keys()].some(
                (key) => strategy.parameters[key] !== undefined,
            );
        const candidates = existing.strategies.filter(hasIgnoredParameter);
        const fallbackStrategy =
            candidates.length === 1 ? candidates[0] : undefined;

        const fallbackVariants = existing.strategies.flatMap(
            (strategy) => strategy.variants,
        );

        const strategies = config.strategies.map((strategy, index) => {
            const direct = matches.get(index);
            const match =
                direct && hasIgnoredParameter(direct)
                    ? direct
                    : (fallbackStrategy ?? direct);
            const parameters = { ...strategy.parameters };

            for (const [key, entries] of parameterEntries) {
                if (entries.some((entry) => entry.pointer === null)) {
                    if (match?.parameters[key] !== undefined) {
                        parameters[key] = match.parameters[key];
                    } else {
                        delete parameters[key];
                    }
                    continue;
                }

                const merged = mergeIgnoredJsonValue(
                    parameters[key],
                    match?.parameters[key],
                    entries.map((entry) => entry.pointer as string[]),
                );
                lost.push(...merged.lost.map((pointer) => `${key}${pointer}`));
                if (merged.value === undefined) {
                    delete parameters[key];
                } else {
                    parameters[key] = merged.value;
                }
            }

            // Keep the target's key order when the value is semantically
            // unchanged, even if the source and target order their keys
            // differently.
            for (const key of Object.keys(parameters)) {
                const kept = preserveJsonString(
                    parameters[key],
                    match?.parameters[key],
                );
                if (kept !== undefined) {
                    parameters[key] = kept;
                }
            }

            return {
                ...strategy,
                parameters,
                variants: this.preserveVariantPayloads(
                    strategy.variants,
                    match?.variants ?? fallbackVariants,
                    payloadEntries,
                    lost,
                ),
            };
        });

        const variants = this.preserveVariantPayloads(
            config.variants,
            existing.variants,
            payloadEntries,
            lost,
        );

        if (lost.length > 0) {
            throw new BadDataError(
                `Cannot sync "${config.featureName}": these environment-specific values exist on the target but could not be preserved: ${unique(lost).join(', ')}. Restore the value on the target or remove the entry from this target's environment-specific values.`,
            );
        }

        return { strategies, variants };
    }

    private preserveVariantPayloads(
        variants: EnvironmentSyncVariant[],
        existing: EnvironmentSyncVariant[],
        entries: IgnoredEntryGroup,
        lost: string[],
    ): EnvironmentSyncVariant[] {
        return variants.map((variant) => {
            const existingVariant = existing.find(
                (entry) => entry.name === variant.name,
            );
            const rule = payloadIgnoreFor(variant.name, entries);
            const result: EnvironmentSyncVariant = { ...variant };

            if (rule.whole) {
                if (existingVariant?.payload) {
                    result.payload = existingVariant.payload;
                } else {
                    delete result.payload;
                }
            } else if (rule.pointers.length > 0) {
                if (existingVariant?.payload?.type === 'json') {
                    if (variant.payload?.type !== 'json') {
                        lost.push(
                            `${variant.name}::${rule.pointers
                                .map((pointer) => `/${pointer.join('/')}`)
                                .join(',')}`,
                        );
                    } else {
                        const merged = mergeIgnoredJsonValue(
                            variant.payload.value,
                            existingVariant.payload.value,
                            rule.pointers,
                        );
                        lost.push(
                            ...merged.lost.map(
                                (pointer) => `${variant.name}${pointer}`,
                            ),
                        );
                        result.payload = {
                            ...variant.payload,
                            value: merged.value ?? variant.payload.value,
                        };
                    }
                }
            }

            // Preserve the target's exact JSON string (key order) when the
            // value is semantically unchanged.
            if (
                result.payload?.type === 'json' &&
                existingVariant?.payload?.type === 'json'
            ) {
                const kept = preserveJsonString(
                    result.payload.value,
                    existingVariant.payload.value,
                );
                if (kept !== undefined) {
                    result.payload = { ...result.payload, value: kept };
                }
            }

            return result;
        });
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

        const localConfigs = await this.resolveLocalConfigs(
            this.loadLocalConfigsByTarget(projectId, featureNames, targets),
        );
        const tagsByFeature = await this.getTagsByFeature(featureNames);

        const results: EnvironmentSyncSyncResult[] = [];

        for (const target of targets) {
            const local = localConfigs.get(
                this.localConfigKey(
                    target.sourceEnvironment,
                    target.ignoredConfig,
                ),
            );
            const configs: {
                featureName: string;
                strategies: EnvironmentSyncStrategy[];
                variants: EnvironmentSyncVariant[];
            }[] = [];
            const skipped: EnvironmentSyncSyncResult['features'] = featureNames
                .filter((featureName) =>
                    isFeatureIgnored(
                        featureName,
                        target.ignoredConfig,
                        tagsByFeature.get(featureName) ?? [],
                    ),
                )
                .map((featureName) => ({
                    featureName,
                    status: 'skipped' as const,
                    error: 'Excluded from this sync target',
                }));

            if (!onlyOutOfSync) {
                // The status check normally verifies the target protocol
                // version. This path skips it, so verify before writing: a
                // peer that does not understand environment-specific values
                // would otherwise overwrite them.
                const versionError = await this.verifyTargetVersion(
                    target,
                    projectId,
                    featureNames[0],
                );
                if (versionError) {
                    await this.store.updateSyncState(target.id, {
                        status: 'error',
                        error: versionError,
                        at: new Date(),
                    });
                    results.push({
                        targetId: target.id,
                        targetName: target.name,
                        features: featureNames.map((featureName) => ({
                            featureName,
                            status: 'error' as const,
                            error: versionError,
                        })),
                    });
                    continue;
                }
            }

            for (const featureName of featureNames.filter(
                (name) =>
                    !isFeatureIgnored(
                        name,
                        target.ignoredConfig,
                        tagsByFeature.get(name) ?? [],
                    ),
            )) {
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
                        targetStatus.status === 'archived' ||
                        targetStatus.status === 'excluded'
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
                try {
                    await existing;
                } catch {
                    // The caller that owned the in-flight request reports
                    // its failure. This caller still returns per-feature
                    // results instead of failing with someone else's error.
                }
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
                    ignoredConfig: target.ignoredConfig,
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

    /**
     * Peer side of the catalog: every flag configuration in the instance for
     * one environment, aggregated by field path.
     */
    async getCatalogSnapshot(
        environment: string,
        featureNames?: string[],
    ): Promise<EnvironmentSyncRemoteCatalog> {
        const configs = await this.loadAllConfigs(environment);
        const requested = featureNames ? new Set(featureNames) : undefined;
        const scoped = requested
            ? configs.filter((config) => requested.has(config.name))
            : configs;
        const catalog = collectEnvironmentSyncCatalog(environment, scoped);
        return {
            version: SYNC_PROTOCOL_VERSION,
            environment: catalog.environment,
            entries: catalog.entries,
            flags: scoped.map((config) => config.name),
            truncated: catalog.truncated,
        };
    }

    async getConfigFingerprints(
        projectId: string,
        environment: string,
        featureNames?: string[],
        ignored: EnvironmentSyncIgnoredConfig = emptyIgnoredConfig(),
    ): Promise<{
        version: number;
        environmentAvailable: boolean;
        features: EnvironmentSyncFingerprint[];
    }> {
        const loaded = await this.loadConfigs(
            projectId,
            environment,
            featureNames,
            ignored,
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
        ignored: EnvironmentSyncIgnoredConfig = emptyIgnoredConfig(),
    ): Promise<{
        version: number;
        environmentAvailable: boolean;
        exists: boolean;
        archived: boolean;
        strategies: EnvironmentSyncStrategy[];
        variants: EnvironmentSyncVariant[];
    }> {
        const loaded = await this.loadConfigs(
            projectId,
            environment,
            [featureName],
            ignored,
        );
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
        const referenced = new Set<string>();
        const resolved = strategies.map((strategy) => {
            const segmentIds = (strategy.segments ?? []).map((name) => {
                referenced.add(name);
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

        // Only reject names this sync actually uses. An unrelated duplicate
        // elsewhere on the instance must not block every configuration.
        const ambiguousInUse = [...ambiguous].filter((name) =>
            referenced.has(name),
        );
        if (ambiguousInUse.length > 0) {
            const names = ambiguousInUse.join(', ');
            throw new BadDataError(
                `These segment names match more than one segment on the target instance: ${names}. Rename the duplicates so each name is unique.`,
            );
        }

        return resolved;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    private async getTagsByFeature(
        featureNames: string[],
    ): Promise<Map<string, string[]>> {
        if (featureNames.length === 0) {
            return new Map();
        }
        const rows = await this.featureTagStore.getAllByFeatures(featureNames);
        const tagsByFeature = new Map<string, string[]>();
        for (const row of rows) {
            const existing = tagsByFeature.get(row.featureName) ?? [];
            existing.push(row.tagValue);
            tagsByFeature.set(row.featureName, existing);
        }
        return tagsByFeature;
    }

    private async loadConfigsFor(
        environment: string,
        names: string[],
        projectFilter: string | null,
        ignored: EnvironmentSyncIgnoredConfig,
    ): Promise<LoadedConfig[]> {
        if (names.length === 0) {
            return [];
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
        const scopedFeatures =
            projectFilter === null
                ? featureRows
                : featureRows.filter(
                      (feature) => feature.project === projectFilter,
                  );

        return names.map((name): LoadedConfig => {
            const feature = scopedFeatures.find((row) => row.name === name);
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

            const config = canonicalConfig(
                {
                    strategies:
                        strategies as unknown as RawEnvironmentSyncStrategy[],
                    variants: environmentRow?.variants ?? [],
                    strategySegments,
                    segmentNamesById,
                },
                ignoredConfigForFeature(ignored, name),
            );

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
    }

    private async loadConfigs(
        projectId: string,
        environment: string,
        featureNames?: string[],
        ignored: EnvironmentSyncIgnoredConfig = emptyIgnoredConfig(),
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

        const features = await this.loadConfigsFor(
            environment,
            names,
            projectId,
            ignored,
        );

        return { environmentAvailable, features };
    }

    /**
     * Loads every flag in the instance for an environment. The catalog is
     * instance wide because a sync target's environment-specific values apply
     * to every project.
     */
    private async loadAllConfigs(environment: string): Promise<LoadedConfig[]> {
        const rows = await this.featureToggleStore.getAll({ archived: false });
        return this.loadConfigsFor(
            environment,
            rows.map((row) => row.name),
            null,
            emptyIgnoredConfig(),
        );
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
        input: EnvironmentSyncTargetInput | undefined,
    ): Promise<void> {
        if (typeof input?.name !== 'string' || !input.name.trim()) {
            throw new BadDataError('An environment name is required');
        }
        if (
            typeof input.targetEnvironment !== 'string' ||
            !input.targetEnvironment.trim()
        ) {
            throw new BadDataError('A target environment is required');
        }
        if (!input.sourceEnvironment) {
            throw new BadDataError('A source environment is required');
        }
        if (typeof input.url !== 'string' || !input.url.trim()) {
            throw new BadDataError('The instance URL is required');
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

    private async verifyTargetVersion(
        target: EnvironmentSyncTargetWithToken,
        projectId: string,
        featureName: string,
    ): Promise<string | undefined> {
        try {
            const probe = await this.client.fingerprints(
                this.toRemoteTarget(target),
                {
                    projectId: target.project ?? projectId,
                    environment: target.targetEnvironment,
                    featureNames: [featureName],
                    ignoredConfig: target.ignoredConfig,
                },
            );
            if (probe.version !== SYNC_PROTOCOL_VERSION) {
                return `The target uses environment sync version ${probe.version}; this instance uses ${SYNC_PROTOCOL_VERSION}. Upgrade the target.`;
            }
            return undefined;
        } catch (error) {
            return remoteError(error);
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

/**
 * Pairs incoming strategies with the ones that already exist on the target.
 * The ladder mirrors the diff view: exact targeting, then title or variant
 * names, then the strategy name. Only unused candidates are considered, so a
 * pair is never reused.
 */
const matchStrategies = (
    incoming: EnvironmentSyncStrategy[],
    existing: EnvironmentSyncStrategy[],
): Map<number, EnvironmentSyncStrategy | undefined> => {
    const used = new Set<number>();
    const matches = new Map<number, EnvironmentSyncStrategy | undefined>();

    const assign = (
        predicate: (
            candidate: EnvironmentSyncStrategy,
            current: EnvironmentSyncStrategy,
        ) => boolean,
    ) => {
        for (const [index, strategy] of incoming.entries()) {
            if (matches.has(index)) {
                continue;
            }
            const candidateIndex = existing.findIndex(
                (current, currentIndex) =>
                    !used.has(currentIndex) && predicate(strategy, current),
            );
            if (candidateIndex !== -1) {
                used.add(candidateIndex);
                matches.set(index, existing[candidateIndex]);
            }
        }
    };

    assign(
        (candidate, current) =>
            candidate.name === current.name &&
            stableStringify(candidate.constraints) ===
                stableStringify(current.constraints),
    );
    assign((candidate, current) => {
        const title = candidate.title?.trim();
        return Boolean(title) && current.title?.trim() === title;
    });
    assign((candidate, current) => {
        const variantNames = (strategy: EnvironmentSyncStrategy) =>
            strategy.variants
                .map((variant) => variant.name)
                .sort()
                .join('|');
        const names = variantNames(candidate);
        return Boolean(names) && names === variantNames(current);
    });
    assign((candidate, current) => candidate.name === current.name);

    for (const index of incoming.keys()) {
        if (!matches.has(index)) {
            matches.set(index, undefined);
        }
    }

    return matches;
};

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
