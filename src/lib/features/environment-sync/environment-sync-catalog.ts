import { createHash } from 'node:crypto';
import {
    stableStringify,
    type EnvironmentSyncConfig,
    type EnvironmentSyncVariant,
} from './environment-sync-config.js';
import {
    WILDCARD_SEGMENT,
    formatJsonPointer,
    isForbiddenSegment,
} from './environment-sync-paths.js';

export const CATALOG_MAX_DEPTH = 6;
export const CATALOG_MAX_PATHS = 100;
export const CATALOG_MAX_ENTRIES = 500;
export const CATALOG_MAX_SAMPLES = 3;
export const CATALOG_MAX_SAMPLE_LENGTH = 160;

export type EnvironmentSyncCatalogKind = 'parameter' | 'variantPayload';

export interface EnvironmentSyncCatalogEntry {
    entry: string;
    kind: EnvironmentSyncCatalogKind;
    flagCount: number;
    usageCount: number;
    samples: string[];
    /**
     * One digest per flag, used to compare the same flag on both sides. A
     * digest keeps the response bounded even when a value is large and shared
     * by many flags; the full value must never be needed for comparison.
     */
    valuesByFlag: Record<string, string>;
}

export interface EnvironmentSyncCatalogFlag {
    name: string;
    project: string | null;
    tags: string[];
}

export interface EnvironmentSyncCatalog {
    environment: string;
    entries: EnvironmentSyncCatalogEntry[];
    flags: EnvironmentSyncCatalogFlag[];
    truncated: boolean;
}

interface Aggregate {
    kind: EnvironmentSyncCatalogKind;
    flags: Set<string>;
    usageCount: number;
    samples: Set<string>;
    valuesByFlag: Record<string, string>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const digestCatalogValue = (value: string): string =>
    createHash('sha256').update(value).digest('hex');

const truncateSample = (value: string): string =>
    value.length > CATALOG_MAX_SAMPLE_LENGTH
        ? `${value.slice(0, CATALOG_MAX_SAMPLE_LENGTH)}…`
        : value;

const sampleOf = (value: unknown): string => {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return stableStringify(value ?? null);
};

const parseJson = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
};

const isContainer = (value: unknown): boolean =>
    isPlainObject(value) || Array.isArray(value);

interface JsonLeaf {
    segments: string[];
    value: unknown;
}

const collectJsonLeaves = (
    value: unknown,
    segments: string[],
    depth: number,
    leaves: JsonLeaf[],
    seen: Set<string>,
    state: { truncated: boolean },
): void => {
    if (leaves.length >= CATALOG_MAX_PATHS) {
        state.truncated = true;
        return;
    }

    const pushLeaf = (leafSegments: string[], leafValue: unknown): void => {
        // Array elements share one wildcard path, so dedupe by pointer. This
        // keeps the cap about distinct paths rather than array length.
        const key = formatJsonPointer(leafSegments);
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        leaves.push({ segments: leafSegments, value: leafValue });
    };

    if (depth >= CATALOG_MAX_DEPTH) {
        // A path cannot end on a wildcard: it would not identify a field.
        if (segments[segments.length - 1] !== WILDCARD_SEGMENT) {
            pushLeaf(segments, value);
        }
        return;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            pushLeaf(segments, value);
            return;
        }
        const elements = value.filter(isContainer);
        if (elements.length === 0) {
            // An array of primitives has no fields inside; the array itself is
            // the value that can be excluded.
            pushLeaf(segments, value);
            return;
        }
        for (const item of elements) {
            collectJsonLeaves(
                item,
                [...segments, WILDCARD_SEGMENT],
                depth + 1,
                leaves,
                seen,
                state,
            );
        }
        return;
    }

    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0) {
            pushLeaf(segments, value);
            return;
        }
        for (const [key, item] of entries) {
            // The pointer parser rejects these segments, so offering them
            // would produce an option that cannot be saved.
            if (isForbiddenSegment(key)) {
                continue;
            }
            collectJsonLeaves(
                item,
                [...segments, key],
                depth + 1,
                leaves,
                seen,
                state,
            );
        }
        return;
    }

    pushLeaf(segments, value);
};

/**
 * Builds the list of values an operator can mark as environment specific,
 * aggregated across every flag instead of per flag. The result is bounded by
 * `CATALOG_MAX_ENTRIES`; `truncated` tells callers some values were dropped.
 */
export const collectEnvironmentSyncCatalog = (
    environment: string,
    configs: { name: string; config: EnvironmentSyncConfig }[],
    flags: EnvironmentSyncCatalogFlag[] = [],
): EnvironmentSyncCatalog => {
    const aggregates = new Map<string, Aggregate>();
    const state = { truncated: false };

    const add = (
        entry: string,
        kind: EnvironmentSyncCatalogKind,
        flagName: string,
        sample: string,
    ): void => {
        const existing = aggregates.get(entry);
        if (!existing && aggregates.size >= CATALOG_MAX_ENTRIES) {
            state.truncated = true;
            return;
        }
        const aggregate: Aggregate = existing ?? {
            kind,
            flags: new Set<string>(),
            usageCount: 0,
            samples: new Set<string>(),
            valuesByFlag: {},
        };
        aggregate.flags.add(flagName);
        aggregate.usageCount += 1;
        const truncated = truncateSample(sample);
        if (aggregate.samples.size < CATALOG_MAX_SAMPLES) {
            aggregate.samples.add(truncated);
        }
        if (aggregate.valuesByFlag[flagName] === undefined) {
            // Compare a digest of the untruncated value: two long values can
            // differ only past the truncation point, and storing the raw value
            // would grow the response by value length times flag count.
            aggregate.valuesByFlag[flagName] = digestCatalogValue(sample);
        }
        aggregates.set(entry, aggregate);
    };

    const addValue = (
        prefix: string,
        kind: EnvironmentSyncCatalogKind,
        flagName: string,
        raw: string,
        json: boolean,
    ): void => {
        const parsed = json ? parseJson(raw) : undefined;
        if (!isContainer(parsed)) {
            add(prefix, kind, flagName, raw);
            return;
        }

        const leaves: JsonLeaf[] = [];
        collectJsonLeaves(parsed, [], 0, leaves, new Set(), state);
        if (leaves.length === 0) {
            add(prefix, kind, flagName, raw);
            return;
        }

        for (const leaf of leaves) {
            if (leaf.segments.length === 0) {
                add(prefix, kind, flagName, sampleOf(leaf.value));
            } else {
                add(
                    `${prefix}::${formatJsonPointer(leaf.segments)}`,
                    kind,
                    flagName,
                    sampleOf(leaf.value),
                );
            }
        }

        if (leaves.length >= CATALOG_MAX_PATHS) {
            // The JSON is too large to enumerate. Keep the whole value as an
            // escape hatch so it can still be marked environment specific.
            state.truncated = true;
            add(prefix, kind, flagName, raw);
        }
    };

    const addVariant = (
        flagName: string,
        variant: EnvironmentSyncVariant,
    ): void => {
        const payload = variant.payload;
        if (!payload) {
            return;
        }
        addValue(
            '*',
            'variantPayload',
            flagName,
            payload.value,
            payload.type === 'json',
        );
    };

    for (const config of configs) {
        for (const strategy of config.config.strategies) {
            for (const [key, value] of Object.entries(strategy.parameters)) {
                addValue(key, 'parameter', config.name, value, true);
            }
            for (const variant of strategy.variants) {
                addVariant(config.name, variant);
            }
        }
        for (const variant of config.config.variants) {
            addVariant(config.name, variant);
        }
    }

    const entries: EnvironmentSyncCatalogEntry[] = [...aggregates.entries()]
        .map(([entry, aggregate]) => ({
            entry,
            kind: aggregate.kind,
            flagCount: aggregate.flags.size,
            usageCount: aggregate.usageCount,
            samples: [...aggregate.samples],
            valuesByFlag: aggregate.valuesByFlag,
        }))
        .sort(
            (a, b) =>
                b.flagCount - a.flagCount || a.entry.localeCompare(b.entry),
        );

    return {
        environment,
        entries,
        flags,
        truncated: state.truncated,
    };
};
