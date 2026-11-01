import type {
    EnvironmentSyncConfig,
    EnvironmentSyncStrategy,
    EnvironmentSyncVariant,
} from './environment-sync-config.js';
import { stableStringify } from './environment-sync-config.js';

export type EnvironmentSyncDiffStatus =
    | 'in_sync'
    | 'modified'
    | 'only_source'
    | 'only_target';

export interface EnvironmentSyncStrategyDiff {
    key: string;
    label: string;
    status: EnvironmentSyncDiffStatus;
    changes: string[];
    local?: EnvironmentSyncStrategy;
    remote?: EnvironmentSyncStrategy;
}

export interface EnvironmentSyncVariantDiff {
    key: string;
    label: string;
    status: EnvironmentSyncDiffStatus;
    changes: string[];
    local?: EnvironmentSyncVariant;
    remote?: EnvironmentSyncVariant;
}

export interface EnvironmentSyncDiff {
    strategies: EnvironmentSyncStrategyDiff[];
    variants: EnvironmentSyncVariantDiff[];
    orderChanged: boolean;
    summary: {
        total: number;
        inSync: number;
        outOfSync: number;
    };
}

interface ItemDiff<T> {
    key: string;
    label: string;
    status: EnvironmentSyncDiffStatus;
    changes: string[];
    local?: T;
    remote?: T;
}

interface ItemDiffResult<T> {
    diffs: ItemDiff<T>[];
    orderChanged: boolean;
}

const constraintValues = (constraint: {
    values?: string[];
    value?: unknown;
}): string[] => {
    if (constraint.values) {
        return constraint.values;
    }
    if (constraint.value !== undefined && constraint.value !== null) {
        return [String(constraint.value)];
    }
    return [];
};

export const strategyLabel = (strategy: EnvironmentSyncStrategy): string => {
    const title = strategy.title?.trim();
    if (title) {
        return title;
    }
    const constraints = strategy.constraints
        .map((constraint) => {
            const values = constraintValues(constraint);
            return `${constraint.contextName ?? 'context'} ${
                constraint.operator ?? 'IN'
            } [${values.join(', ')}]`;
        })
        .join(' AND ');
    return constraints ? `${strategy.name} · ${constraints}` : strategy.name;
};

const strategyIdentity = (strategy: EnvironmentSyncStrategy): string =>
    `${strategy.name}|${stableStringify(strategy.constraints)}`;

// A constraint change (e.g. userId [1] -> [1, 11]) should be shown as a
// modification of the same strategy, not as a removal plus an addition.
// Title and variant names remain stable when only the targeting changes.
const strategyWeakIdentity = (
    strategy: EnvironmentSyncStrategy,
): string | undefined => {
    const title = strategy.title?.trim();
    if (title) {
        return `title:${title}`;
    }
    const variantNames = strategy.variants
        .map((variant) => variant.name)
        .sort()
        .join('|');
    return variantNames ? `variants:${variantNames}` : undefined;
};

const strategyFallbackIdentity = (strategy: EnvironmentSyncStrategy): string =>
    strategy.name;

const strategyChanges = (
    local: EnvironmentSyncStrategy,
    remote: EnvironmentSyncStrategy,
): string[] => {
    const fields: (keyof EnvironmentSyncStrategy)[] = [
        'name',
        'title',
        'disabled',
        'parameters',
        'constraints',
        'segments',
        'variants',
    ];
    return fields.filter(
        (field) =>
            stableStringify(local[field] ?? null) !==
            stableStringify(remote[field] ?? null),
    );
};

const variantChanges = (
    local: EnvironmentSyncVariant,
    remote: EnvironmentSyncVariant,
): string[] => {
    const fields: (keyof EnvironmentSyncVariant)[] = [
        'payload',
        'weight',
        'weightType',
        'stickiness',
        'overrides',
    ];
    return fields.filter(
        (field) =>
            stableStringify(local[field] ?? null) !==
            stableStringify(remote[field] ?? null),
    );
};

const buildItemDiffs = <T>(
    localItems: T[],
    remoteItems: T[],
    identity: (item: T) => string,
    label: (item: T) => string,
    changes: (local: T, remote: T) => string[],
    weakIdentity?: (item: T) => string | undefined,
    fallbackIdentity?: (item: T) => string,
): ItemDiffResult<T> => {
    const remoteByIdentity = new Map<string, number[]>();
    remoteItems.forEach((item, index) => {
        const key = identity(item);
        const indices = remoteByIdentity.get(key) ?? [];
        indices.push(index);
        remoteByIdentity.set(key, indices);
    });

    const byLocalIndex = new Map<number, ItemDiff<T>>();
    const matchedRemoteByLocal = new Map<number, number>();
    const usedRemote = new Set<number>();

    const pair = (localIndex: number, remoteIndex: number) => {
        const localItem = localItems[localIndex];
        const remoteItem = remoteItems[remoteIndex];
        const exact =
            stableStringify(localItem) === stableStringify(remoteItem);
        usedRemote.add(remoteIndex);
        matchedRemoteByLocal.set(localIndex, remoteIndex);
        byLocalIndex.set(localIndex, {
            key: `${identity(localItem)}#${localIndex}`,
            label: label(localItem),
            status: exact ? 'in_sync' : 'modified',
            changes: exact ? [] : changes(localItem, remoteItem),
            local: localItem,
            remote: remoteItem,
        });
    };

    // Exact matches keep the rows in sync even when duplicate identities exist.
    for (const [localIndex, localItem] of localItems.entries()) {
        const candidates = remoteByIdentity.get(identity(localItem)) ?? [];
        const exact = candidates.find(
            (remoteIndex) =>
                !usedRemote.has(remoteIndex) &&
                stableStringify(localItem) ===
                    stableStringify(remoteItems[remoteIndex]),
        );
        if (exact !== undefined) {
            pair(localIndex, exact);
        }
    }

    // Same targeting: payload/parameter changes.
    for (const [localIndex, localItem] of localItems.entries()) {
        if (byLocalIndex.has(localIndex)) {
            continue;
        }
        const candidates = remoteByIdentity.get(identity(localItem)) ?? [];
        const match = candidates.find(
            (remoteIndex) => !usedRemote.has(remoteIndex),
        );
        if (match !== undefined) {
            pair(localIndex, match);
        }
    }

    // Same title or same variant names: targeting changed.
    if (weakIdentity) {
        const unusedRemoteByWeak = new Map<string, number[]>();
        remoteItems.forEach((remoteItem, remoteIndex) => {
            if (usedRemote.has(remoteIndex)) {
                return;
            }
            const key = weakIdentity(remoteItem);
            if (!key) {
                return;
            }
            const indices = unusedRemoteByWeak.get(key) ?? [];
            indices.push(remoteIndex);
            unusedRemoteByWeak.set(key, indices);
        });

        for (const [localIndex, localItem] of localItems.entries()) {
            if (byLocalIndex.has(localIndex)) {
                continue;
            }
            const key = weakIdentity(localItem);
            if (!key) {
                continue;
            }
            const match = (unusedRemoteByWeak.get(key) ?? []).find(
                (remoteIndex) => !usedRemote.has(remoteIndex),
            );
            if (match !== undefined) {
                pair(localIndex, match);
            }
        }
    }

    // Last resort: same strategy name, paired in order among the remainder.
    if (fallbackIdentity) {
        const unusedRemoteByFallback = new Map<string, number[]>();
        remoteItems.forEach((remoteItem, remoteIndex) => {
            if (usedRemote.has(remoteIndex)) {
                return;
            }
            const key = fallbackIdentity(remoteItem);
            const indices = unusedRemoteByFallback.get(key) ?? [];
            indices.push(remoteIndex);
            unusedRemoteByFallback.set(key, indices);
        });

        for (const [localIndex, localItem] of localItems.entries()) {
            if (byLocalIndex.has(localIndex)) {
                continue;
            }
            const match = (
                unusedRemoteByFallback.get(fallbackIdentity(localItem)) ?? []
            ).find((remoteIndex) => !usedRemote.has(remoteIndex));
            if (match !== undefined) {
                pair(localIndex, match);
            }
        }
    }

    // Whatever is still unmatched only exists on one side.
    for (const [localIndex, localItem] of localItems.entries()) {
        if (byLocalIndex.has(localIndex)) {
            continue;
        }
        const key = identity(localItem);
        byLocalIndex.set(localIndex, {
            key: `${key}#${localIndex}`,
            label: label(localItem),
            status: 'only_source',
            changes: [],
            local: localItem,
        });
    }
    remoteItems.forEach((remoteItem, remoteIndex) => {
        if (usedRemote.has(remoteIndex)) {
            return;
        }
        const key = identity(remoteItem);
        byLocalIndex.set(localItems.length + remoteIndex, {
            key: `${key}#remote-${remoteIndex}`,
            label: label(remoteItem),
            status: 'only_target',
            changes: [],
            remote: remoteItem,
        });
    });

    const diffs = [
        ...localItems
            .map((_item, localIndex) => byLocalIndex.get(localIndex))
            .filter((item): item is ItemDiff<T> => item !== undefined),
        ...remoteItems
            .map((_item, remoteIndex) =>
                byLocalIndex.get(localItems.length + remoteIndex),
            )
            .filter((item): item is ItemDiff<T> => item !== undefined),
    ];

    const matchedRemoteOrder = localItems
        .map((_item, localIndex) => matchedRemoteByLocal.get(localIndex))
        .filter((index): index is number => index !== undefined);
    const orderChanged = matchedRemoteOrder.some(
        (remoteIndex, index) =>
            index > 0 && remoteIndex < matchedRemoteOrder[index - 1],
    );

    return { diffs, orderChanged };
};

export const diffEnvironmentSyncConfigs = (
    local: EnvironmentSyncConfig,
    remote: EnvironmentSyncConfig,
): EnvironmentSyncDiff => {
    const strategyDiff = buildItemDiffs(
        local.strategies,
        remote.strategies,
        strategyIdentity,
        strategyLabel,
        strategyChanges,
        strategyWeakIdentity,
        strategyFallbackIdentity,
    );
    const variantDiff = buildItemDiffs(
        local.variants,
        remote.variants,
        (variant) => variant.name,
        (variant) => variant.name,
        variantChanges,
    );
    const inSync = strategyDiff.diffs.filter(
        (diff) => diff.status === 'in_sync',
    ).length;

    return {
        strategies: strategyDiff.diffs,
        variants: variantDiff.diffs,
        orderChanged: strategyDiff.orderChanged,
        summary: {
            total: strategyDiff.diffs.length,
            inSync,
            outOfSync: strategyDiff.diffs.length - inSync,
        },
    };
};
