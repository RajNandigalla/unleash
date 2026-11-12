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

export type EnvironmentSyncDifference = {
    field: 'strategies' | 'variants';
    local: number;
    remote: number;
};

export type EnvironmentSyncVariant = {
    name: string;
    weight: number;
    weightType?: string;
    stickiness?: string;
    payload?: { type: string; value: string };
    overrides?: { contextName: string; values: string[] }[];
};

export type EnvironmentSyncConstraint = {
    contextName?: string;
    operator?: string;
    value?: unknown;
    values?: string[];
    caseInsensitive?: boolean;
    inverted?: boolean;
};

export type EnvironmentSyncStrategy = {
    name: string;
    title?: string;
    disabled?: boolean;
    parameters: Record<string, string>;
    constraints: EnvironmentSyncConstraint[];
    segments: string[];
    variants: EnvironmentSyncVariant[];
};

export type EnvironmentSyncConfig = {
    strategies: EnvironmentSyncStrategy[];
    variants: EnvironmentSyncVariant[];
};

export type EnvironmentSyncFeatureFields = {
    feature: string;
    parameters: string[];
    variantPayloads: string[];
};

export type EnvironmentSyncIgnoredConfig = {
    parameters: string[];
    variantPayloads: string[];
    ignoredFeatures: string[];
    featureFields?: EnvironmentSyncFeatureFields[];
};

export type EnvironmentSyncCatalogKind = 'parameter' | 'variantPayload';

export type EnvironmentSyncCatalogEntry = {
    entry: string;
    kind: EnvironmentSyncCatalogKind;
    flagCount: number;
    usageCount: number;
    samples: string[];
    /** A digest per flag, used to compare the same flag on both sides. */
    valuesByFlag: Record<string, string>;
};

export type EnvironmentSyncCatalogEntryView = {
    entry: string;
    kind: EnvironmentSyncCatalogKind;
    local?: EnvironmentSyncCatalogEntry;
    remote?: EnvironmentSyncCatalogEntry;
    differs: boolean;
};

export type EnvironmentSyncCatalogFlag = {
    name: string;
    project: string | null;
    tags: string[];
};

export type EnvironmentSyncCatalogView = {
    sourceEnvironment: string;
    targetEnvironment?: string;
    comparedWithTarget: boolean;
    entries: EnvironmentSyncCatalogEntryView[];
    flags: EnvironmentSyncCatalogFlag[];
    remoteError?: string;
    truncated: boolean;
};

export type EnvironmentSyncFeatureExclusionResult = {
    excluded: boolean;
    changed: boolean;
    reason?: string;
};

export type EnvironmentSyncFlagsResponse = {
    flags: EnvironmentSyncCatalogFlag[];
};

export type EnvironmentSyncCatalogRequest = {
    sourceEnvironment: string;
    targetId?: number;
    url?: string;
    token?: string;
    targetEnvironment?: string;
};

export type EnvironmentSyncTarget = {
    id: number;
    name: string;
    url: string;
    project: string | null;
    sourceEnvironment: string;
    targetEnvironment: string;
    enabled: boolean;
    ignoredConfig: EnvironmentSyncIgnoredConfig;
    createdAt: string;
    createdBy: string | null;
    hasToken: boolean;
    lastTestedAt: string | null;
    lastTestStatus: 'ok' | 'error' | null;
    lastTestError: string | null;
    lastSyncedAt: string | null;
    lastSyncStatus: 'ok' | 'error' | null;
    lastSyncError: string | null;
};

export type EnvironmentSyncTargetsResponse = {
    tokenStorageConfigured: boolean;
    targets: EnvironmentSyncTarget[];
};

export type EnvironmentSyncTargetInput = {
    name: string;
    url: string;
    token?: string;
    project?: string | null;
    sourceEnvironment: string;
    targetEnvironment: string;
    ignoredConfig?: EnvironmentSyncIgnoredConfig;
    enabled?: boolean;
};

export type EnvironmentSyncTestResult = {
    ok: boolean;
    environments: string[];
    projectExists?: boolean;
    error?: string;
};

export type EnvironmentSyncDiffStatus =
    | 'in_sync'
    | 'modified'
    | 'only_source'
    | 'only_target';

export type EnvironmentSyncStrategyDiff = {
    key: string;
    label: string;
    status: EnvironmentSyncDiffStatus;
    changes: string[];
    local?: EnvironmentSyncStrategy;
    remote?: EnvironmentSyncStrategy;
};

export type EnvironmentSyncVariantDiff = {
    key: string;
    label: string;
    status: EnvironmentSyncDiffStatus;
    changes: string[];
    local?: EnvironmentSyncVariant;
    remote?: EnvironmentSyncVariant;
};

export type EnvironmentSyncDiff = {
    strategies: EnvironmentSyncStrategyDiff[];
    variants: EnvironmentSyncVariantDiff[];
    orderChanged: boolean;
    summary: {
        total: number;
        inSync: number;
        outOfSync: number;
    };
};

export type EnvironmentSyncTargetStatusView = {
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
    lastSyncedAt?: string | null;
};

export type EnvironmentSyncFeatureCompare = {
    featureName: string;
    targets: EnvironmentSyncTargetStatusView[];
};

export type EnvironmentSyncProjectStatus = {
    checkedAt: string;
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
};

export type EnvironmentSyncSyncResponse = {
    results: {
        targetId: number;
        targetName: string;
        features: {
            featureName: string;
            status: 'synced' | 'skipped' | 'error';
            created?: boolean;
            error?: string;
        }[];
    }[];
};
