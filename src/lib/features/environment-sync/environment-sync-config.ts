import { createHash } from 'node:crypto';

export const SYNC_PROTOCOL_VERSION = 2;

export interface EnvironmentSyncVariant {
    name: string;
    weight: number;
    weightType?: string;
    stickiness?: string;
    payload?: { type: string; value: string };
    overrides?: { contextName: string; values: string[] }[];
}

export interface EnvironmentSyncConstraint {
    contextName?: string;
    operator?: string;
    value?: unknown;
    values?: string[];
    caseInsensitive?: boolean;
    inverted?: boolean;
}

export interface EnvironmentSyncStrategy {
    name: string;
    title?: string;
    disabled?: boolean;
    parameters: Record<string, string>;
    constraints: EnvironmentSyncConstraint[];
    segments: string[];
    variants: EnvironmentSyncVariant[];
}

export interface EnvironmentSyncConfig {
    strategies: EnvironmentSyncStrategy[];
    variants: EnvironmentSyncVariant[];
}

export interface RawEnvironmentSyncStrategy {
    id: string;
    strategyName: string;
    title?: string | null;
    disabled?: boolean | null;
    parameters?: Record<string, unknown> | null;
    constraints?: unknown[] | null;
    variants?: unknown[] | null;
}

export interface RawEnvironmentSyncVariant {
    name?: string;
    weight?: number | string;
    weightType?: string;
    stickiness?: string;
    payload?: { type?: string; value?: string } | null;
    overrides?: { contextName?: string; values?: string[] }[] | null;
}

export interface StrategySegment {
    featureStrategyId: string;
    segmentId: number;
}

export interface ConfigSnapshotInput {
    strategies: RawEnvironmentSyncStrategy[];
    variants: RawEnvironmentSyncVariant[];
    strategySegments: StrategySegment[];
    segmentNamesById: Map<number, string>;
}

export type EnvironmentSyncDifference = {
    field: 'strategies' | 'variants';
    local: number;
    remote: number;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Deterministic JSON: object keys are sorted recursively. Arrays keep their
 * order because the config canonicaliser sorts them before serialisation.
 */
export const stableStringify = (value: unknown): string => {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (isPlainObject(value)) {
        const entries = Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${stableStringify(value[key])}`,
            );
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value ?? null);
};

const sortByStableString = (values: unknown[]): unknown[] =>
    [...values].sort((a, b) =>
        stableStringify(a) < stableStringify(b) ? -1 : 1,
    );

const canonicalConstraint = (
    constraint: unknown,
): EnvironmentSyncConstraint => {
    if (!isPlainObject(constraint)) {
        return {};
    }
    const result: EnvironmentSyncConstraint = {};
    if (typeof constraint.contextName === 'string') {
        result.contextName = constraint.contextName;
    }
    if (typeof constraint.operator === 'string') {
        result.operator = constraint.operator;
    }
    if (constraint.value !== undefined) {
        result.value = constraint.value;
    }
    if (Array.isArray(constraint.values)) {
        result.values = [...constraint.values]
            .map((value) => String(value))
            .sort();
    }
    if (constraint.caseInsensitive !== undefined) {
        result.caseInsensitive = Boolean(constraint.caseInsensitive);
    }
    if (constraint.inverted !== undefined) {
        result.inverted = Boolean(constraint.inverted);
    }
    return result;
};

export const canonicalVariant = (
    variant: RawEnvironmentSyncVariant,
): EnvironmentSyncVariant => {
    const result: EnvironmentSyncVariant = {
        name: String(variant.name ?? ''),
        weight: Number(variant.weight ?? 0),
    };
    if (variant.weightType) {
        result.weightType = variant.weightType;
    }
    if (variant.stickiness) {
        result.stickiness = variant.stickiness;
    }
    if (variant.payload?.type && variant.payload?.value !== undefined) {
        result.payload = {
            type: variant.payload.type,
            value: variant.payload.value,
        };
    }
    if (Array.isArray(variant.overrides) && variant.overrides.length > 0) {
        result.overrides = variant.overrides
            .map((override) => ({
                contextName: String(override.contextName ?? ''),
                values: [...(override.values ?? [])]
                    .map((value) => String(value))
                    .sort(),
            }))
            .sort((a, b) => a.contextName.localeCompare(b.contextName));
    }
    return result;
};

const sortVariants = (
    variants: EnvironmentSyncVariant[],
): EnvironmentSyncVariant[] => {
    const sorted = [...variants].sort((a, b) => a.name.localeCompare(b.name));
    const variableVariants = sorted.filter(
        (variant) => variant.weightType === 'variable',
    );
    if (variableVariants.length === 0) {
        return sorted;
    }

    // Unleash normalises variable weights to equal shares of the remaining
    // traffic when persisting them. Canonicalise the same way so a target
    // that rounded the remainder to a different variant is not reported as
    // drift. Fixed weights keep their exact value.
    const fixedWeight = sorted
        .filter((variant) => variant.weightType === 'fix')
        .reduce((total, variant) => total + variant.weight, 0);
    const available = Math.max(0, 1000 - fixedWeight);
    const average = Math.floor(available / variableVariants.length);
    let remainder = available % variableVariants.length;

    return sorted.map((variant) => {
        if (variant.weightType !== 'variable') {
            return variant;
        }
        const weight = average + (remainder > 0 ? 1 : 0);
        remainder = Math.max(0, remainder - 1);
        return { ...variant, weight };
    });
};

export const canonicalConfig = ({
    strategies,
    variants,
    strategySegments,
    segmentNamesById,
}: ConfigSnapshotInput): EnvironmentSyncConfig => {
    const segmentsByStrategy = new Map<string, number[]>();
    for (const relation of strategySegments) {
        const existing =
            segmentsByStrategy.get(relation.featureStrategyId) ?? [];
        existing.push(relation.segmentId);
        segmentsByStrategy.set(relation.featureStrategyId, existing);
    }

    const canonicalStrategies = strategies.map((strategy) => {
        const result: EnvironmentSyncStrategy = {
            name: strategy.strategyName,
            parameters: Object.fromEntries(
                Object.entries(strategy.parameters ?? {})
                    .sort(([a], [b]) => (a < b ? -1 : 1))
                    .map(([key, value]) => [key, String(value)]),
            ),
            constraints: sortByStableString(
                (strategy.constraints ?? []).map(canonicalConstraint),
            ) as EnvironmentSyncConstraint[],
            segments: (segmentsByStrategy.get(strategy.id) ?? [])
                .map(
                    (segmentId) =>
                        segmentNamesById.get(segmentId) ??
                        `unknown-segment-${segmentId}`,
                )
                .sort(),
            variants: sortVariants(
                (strategy.variants ?? []).map((variant) =>
                    canonicalVariant(variant as RawEnvironmentSyncVariant),
                ),
            ),
        };
        if (strategy.title) {
            result.title = strategy.title;
        }
        if (strategy.disabled) {
            result.disabled = true;
        }
        return result;
    });

    return {
        // Strategy order is semantic: Unleash uses the first enabled strategy
        // that has variants. Callers must pass strategies in display order.
        strategies: canonicalStrategies,
        variants: sortVariants(
            variants.map((variant) => canonicalVariant(variant)),
        ),
    };
};

export const fingerprintConfig = (config: EnvironmentSyncConfig): string =>
    createHash('sha256').update(stableStringify(config)).digest('hex');

export const diffConfigs = (
    local: EnvironmentSyncConfig,
    remote: EnvironmentSyncConfig,
): EnvironmentSyncDifference[] => {
    const differences: EnvironmentSyncDifference[] = [];
    if (
        stableStringify(local.strategies) !== stableStringify(remote.strategies)
    ) {
        differences.push({
            field: 'strategies',
            local: local.strategies.length,
            remote: remote.strategies.length,
        });
    }
    if (stableStringify(local.variants) !== stableStringify(remote.variants)) {
        differences.push({
            field: 'variants',
            local: local.variants.length,
            remote: remote.variants.length,
        });
    }
    return differences;
};

export const emptyConfig = (): EnvironmentSyncConfig => ({
    strategies: [],
    variants: [],
});
