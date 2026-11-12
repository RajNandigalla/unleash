import { createHash } from 'node:crypto';
import { BadDataError } from '../../error/index.js';
import {
    MAX_IGNORE_ENTRIES,
    MAX_IGNORE_ENTRY_LENGTH,
    deletePointer,
    getPointer,
    hasPointer,
    hasWildcard,
    matchesFeaturePattern,
    mergeWildcardFields,
    parseIgnoredEntry,
    setPointer,
    type IgnoredEntry,
} from './environment-sync-paths.js';

export const SYNC_PROTOCOL_VERSION = 5;

/**
 * Values that are expected to differ per environment. They are excluded from
 * the fingerprint (so they never show up as drift) and are never copied on
 * sync: the target environment always keeps its own value.
 */
export interface EnvironmentSyncFeatureFields {
    feature: string;
    parameters: string[];
    variantPayloads: string[];
}

export interface EnvironmentSyncIgnoredConfig {
    /** `loginUrl` (whole parameter) or `config::/sso/loginUrl` (one field). */
    parameters: string[];
    /** `*`, `control`, `*::/redirectUrl` or `v1.2::/settings/theme`. */
    variantPayloads: string[];
    /** Feature flags this target never compares or syncs. `*` and `?` globs. */
    ignoredFeatures: string[];
    /**
     * Field exclusions that apply to one feature flag only. Global entries
     * above still apply to every flag.
     */
    featureFields?: EnvironmentSyncFeatureFields[];
}

export const emptyIgnoredConfig = (): EnvironmentSyncIgnoredConfig => ({
    parameters: [],
    variantPayloads: [],
    ignoredFeatures: [],
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const parseStringList = (
    input: unknown,
    field: keyof EnvironmentSyncIgnoredConfig,
): string[] => {
    if (input === undefined || input === null) {
        return [];
    }
    if (!Array.isArray(input)) {
        throw new BadDataError(`"${field}" must be an array of strings`);
    }

    const result: string[] = [];
    for (const item of input) {
        if (typeof item !== 'string') {
            throw new BadDataError(`"${field}" must be an array of strings`);
        }
        const trimmed = item.trim();
        if (!trimmed) {
            continue;
        }
        if (trimmed.length > MAX_IGNORE_ENTRY_LENGTH) {
            throw new BadDataError(
                `An entry in "${field}" is longer than ${MAX_IGNORE_ENTRY_LENGTH} characters`,
            );
        }
        result.push(trimmed);
    }

    if (result.length > MAX_IGNORE_ENTRIES) {
        throw new BadDataError(
            `"${field}" can contain at most ${MAX_IGNORE_ENTRIES} entries`,
        );
    }
    return unique(result);
};

const parseFeatureFields = (input: unknown): EnvironmentSyncFeatureFields[] => {
    if (input === undefined || input === null) {
        return [];
    }
    if (!Array.isArray(input)) {
        throw new BadDataError('"featureFields" must be an array');
    }

    const merged = new Map<string, EnvironmentSyncFeatureFields>();
    for (const item of input) {
        if (!isPlainObject(item)) {
            throw new BadDataError(
                'Each "featureFields" item must be an object',
            );
        }
        const feature =
            typeof item.feature === 'string' ? item.feature.trim() : '';
        if (!feature) {
            throw new BadDataError(
                'Each "featureFields" item needs a feature name',
            );
        }
        const parameters = parseStringList(item.parameters, 'parameters');
        const variantPayloads = parseStringList(
            item.variantPayloads,
            'variantPayloads',
        );
        for (const entry of parameters) {
            if (parseIgnoredEntry(entry).name === '*') {
                throw new BadDataError(
                    'The "parameters" list cannot use "*"; list the parameter names instead',
                );
            }
        }
        for (const entry of variantPayloads) {
            parseIgnoredEntry(entry);
        }

        const existing = merged.get(feature);
        if (existing) {
            existing.parameters = unique([
                ...existing.parameters,
                ...parameters,
            ]);
            existing.variantPayloads = unique([
                ...existing.variantPayloads,
                ...variantPayloads,
            ]);
        } else {
            merged.set(feature, { feature, parameters, variantPayloads });
        }
    }

    if (merged.size > MAX_IGNORE_ENTRIES) {
        throw new BadDataError(
            `"featureFields" can contain at most ${MAX_IGNORE_ENTRIES} features`,
        );
    }
    return [...merged.values()].sort((a, b) =>
        a.feature.localeCompare(b.feature),
    );
};

export const parseIgnoredConfig = (
    input: unknown,
): EnvironmentSyncIgnoredConfig => {
    if (input === undefined || input === null) {
        return emptyIgnoredConfig();
    }
    if (!isPlainObject(input)) {
        throw new BadDataError(
            'The environment-specific values must be an object',
        );
    }

    const parameters = parseStringList(input.parameters, 'parameters');
    const variantPayloads = parseStringList(
        input.variantPayloads,
        'variantPayloads',
    );
    const ignoredFeatures = parseStringList(
        input.ignoredFeatures,
        'ignoredFeatures',
    );

    for (const entry of parameters) {
        const parsed = parseIgnoredEntry(entry);
        if (parsed.name === '*') {
            throw new BadDataError(
                'The "parameters" list cannot use "*"; list the parameter names instead',
            );
        }
    }
    for (const entry of variantPayloads) {
        parseIgnoredEntry(entry);
    }

    const featureFields = parseFeatureFields(input.featureFields);
    return {
        parameters,
        variantPayloads,
        ignoredFeatures,
        ...(featureFields.length > 0 ? { featureFields } : {}),
    };
};

/**
 * Parses a value that replaces the environment-specific config wholesale.
 * Unlike `parseIgnoredConfig`, a missing list is an error: defaulting it to
 * an empty array would silently delete every exclusion in that list.
 */
export const parseCompleteIgnoredConfig = (
    input: unknown,
): EnvironmentSyncIgnoredConfig => {
    if (!isPlainObject(input)) {
        throw new BadDataError(
            'The environment-specific values must be an object with parameters, variantPayloads, ignoredFeatures and featureFields',
        );
    }
    const missing = (
        [
            'parameters',
            'variantPayloads',
            'ignoredFeatures',
            'featureFields',
        ] as const
    ).filter((field) => input[field] === undefined);
    if (missing.length > 0) {
        throw new BadDataError(
            `The environment-specific values are missing ${missing.join(
                ', ',
            )}. Send the complete configuration, including empty arrays, so no exclusion is removed by accident.`,
        );
    }
    return parseIgnoredConfig(input);
};

export const TAG_RULE_PREFIX = 'tag:';

/**
 * Exclusion rules are either a flag name pattern (`legacy-*`, `login-url`) or
 * a tag rule (`tag:no-env-sync`, `tag:no-*`). Tag rules match the tag value
 * regardless of its type so one rule covers `simple` and `owner` style tags.
 */
export const matchesIgnoreRule = (
    featureName: string,
    tags: string[],
    rule: string,
): boolean => {
    if (rule.startsWith(TAG_RULE_PREFIX)) {
        const pattern = rule.slice(TAG_RULE_PREFIX.length).trim();
        return (
            Boolean(pattern) &&
            tags.some((tag) => matchesFeaturePattern(tag, pattern))
        );
    }
    return matchesFeaturePattern(featureName, rule);
};

export const isFeatureIgnored = (
    featureName: string,
    ignored: EnvironmentSyncIgnoredConfig,
    tags: string[] = [],
): boolean =>
    ignored.ignoredFeatures.some((rule) =>
        matchesIgnoreRule(featureName, tags, rule),
    );

/**
 * Tolerant reader for persisted values. Unlike `parseIgnoredConfig` it never
 * throws: a malformed entry is dropped so an old or hand-edited row cannot
 * break sync for every target.
 */
export const normalizeIgnoredConfig = (
    input: unknown,
): EnvironmentSyncIgnoredConfig => {
    if (!isPlainObject(input)) {
        return emptyIgnoredConfig();
    }

    const plainList = (value: unknown): string[] =>
        Array.isArray(value)
            ? unique(
                  value
                      .filter(
                          (item): item is string => typeof item === 'string',
                      )
                      .map((item) => item.trim())
                      .filter(Boolean),
              )
            : [];

    const entryList = (value: unknown, allowStar: boolean): string[] =>
        plainList(value).filter((entry) => {
            try {
                return allowStar || parseIgnoredEntry(entry).name !== '*';
            } catch {
                return false;
            }
        });

    const normalizeFeatureFields = (): EnvironmentSyncFeatureFields[] => {
        if (!Array.isArray(input.featureFields)) {
            return [];
        }
        const merged = new Map<string, EnvironmentSyncFeatureFields>();
        for (const item of input.featureFields) {
            if (!isPlainObject(item)) {
                continue;
            }
            const feature =
                typeof item.feature === 'string' ? item.feature.trim() : '';
            if (!feature) {
                continue;
            }
            const parameters = entryList(item.parameters, false);
            const variantPayloads = entryList(item.variantPayloads, true);
            const existing = merged.get(feature);
            if (existing) {
                existing.parameters = unique([
                    ...existing.parameters,
                    ...parameters,
                ]);
                existing.variantPayloads = unique([
                    ...existing.variantPayloads,
                    ...variantPayloads,
                ]);
            } else {
                merged.set(feature, { feature, parameters, variantPayloads });
            }
        }
        return [...merged.values()].sort((a, b) =>
            a.feature.localeCompare(b.feature),
        );
    };

    const featureFields = normalizeFeatureFields();
    return {
        parameters: entryList(input.parameters, false),
        variantPayloads: entryList(input.variantPayloads, true),
        ignoredFeatures: plainList(input.ignoredFeatures),
        ...(featureFields.length > 0 ? { featureFields } : {}),
    };
};

/**
 * Merges the exclusions scoped to one feature with the global exclusions.
 * Canonicalisation and preservation run per feature, so both sides must call
 * this before applying the ignore list.
 */
export const ignoredConfigForFeature = (
    ignored: EnvironmentSyncIgnoredConfig,
    featureName: string,
): EnvironmentSyncIgnoredConfig => {
    const scoped = (ignored.featureFields ?? []).filter(
        (entry) => entry.feature === featureName,
    );
    if (scoped.length === 0) {
        return ignored;
    }
    return {
        ...ignored,
        parameters: unique([
            ...ignored.parameters,
            ...scoped.flatMap((entry) => entry.parameters),
        ]),
        variantPayloads: unique([
            ...ignored.variantPayloads,
            ...scoped.flatMap((entry) => entry.variantPayloads),
        ]),
    };
};

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

export type IgnoredEntryGroup = Map<string, IgnoredEntry[]>;

export const groupIgnoredEntries = (entries: string[]): IgnoredEntryGroup => {
    const grouped: IgnoredEntryGroup = new Map();
    for (const entry of entries) {
        const parsed = parseIgnoredEntry(entry);
        const existing = grouped.get(parsed.name) ?? [];
        existing.push(parsed);
        grouped.set(parsed.name, existing);
    }
    return grouped;
};

/**
 * Removes the configured fields from a JSON encoded value. The result is
 * serialised deterministically so key order and whitespace can never produce
 * drift. Values that are not JSON objects/arrays are returned untouched.
 */
const stripJsonFields = (raw: string, pointers: string[][]): string => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return raw;
    }
    if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
        return raw;
    }
    for (const pointer of pointers) {
        deletePointer(parsed, pointer);
    }
    // Preserve the key order of the value we were given. Fingerprints strip
    // the order back out (see normalizeConfigForComparison), but the target
    // should receive readable JSON in its original order.
    return JSON.stringify(parsed, null, 2);
};

const canonicalParameterValue = (
    value: unknown,
    entries: IgnoredEntry[] | undefined,
): string | null => {
    if (!entries) {
        return String(value);
    }
    if (entries.some((entry) => entry.pointer === null)) {
        return null;
    }
    return stripJsonFields(
        String(value),
        entries.map((entry) => entry.pointer as string[]),
    );
};

export const payloadIgnoreFor = (
    name: string,
    grouped: IgnoredEntryGroup,
): { whole: boolean; pointers: string[][] } => {
    const entries = [...(grouped.get('*') ?? []), ...(grouped.get(name) ?? [])];
    return {
        whole: entries.some((entry) => entry.pointer === null),
        pointers: entries
            .map((entry) => entry.pointer)
            .filter((pointer): pointer is string[] => pointer !== null),
    };
};

const applyPayloadIgnore = (
    variant: EnvironmentSyncVariant,
    grouped: IgnoredEntryGroup,
): EnvironmentSyncVariant => {
    const rule = payloadIgnoreFor(variant.name, grouped);
    if (rule.whole) {
        const result: EnvironmentSyncVariant = { ...variant };
        delete result.payload;
        return result;
    }
    if (rule.pointers.length > 0 && variant.payload?.type === 'json') {
        return {
            ...variant,
            payload: {
                ...variant.payload,
                value: stripJsonFields(variant.payload.value, rule.pointers),
            },
        };
    }
    return variant;
};

export const canonicalConfig = (
    {
        strategies,
        variants,
        strategySegments,
        segmentNamesById,
    }: ConfigSnapshotInput,
    ignored: EnvironmentSyncIgnoredConfig = emptyIgnoredConfig(),
): EnvironmentSyncConfig => {
    const segmentsByStrategy = new Map<string, number[]>();
    for (const relation of strategySegments) {
        const existing =
            segmentsByStrategy.get(relation.featureStrategyId) ?? [];
        existing.push(relation.segmentId);
        segmentsByStrategy.set(relation.featureStrategyId, existing);
    }

    const parameterEntries = groupIgnoredEntries(ignored.parameters);
    const payloadEntries = groupIgnoredEntries(ignored.variantPayloads);

    const canonicalStrategies = strategies.map((strategy) => {
        const parameters: Record<string, string> = {};
        for (const [key, value] of Object.entries(strategy.parameters ?? {})) {
            const canonical = canonicalParameterValue(
                value,
                parameterEntries.get(key),
            );
            if (canonical !== null) {
                parameters[key] = canonical;
            }
        }

        const result: EnvironmentSyncStrategy = {
            name: strategy.strategyName,
            parameters: Object.fromEntries(
                Object.entries(parameters).sort(([a], [b]) => (a < b ? -1 : 1)),
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
                (strategy.variants ?? [])
                    .map((variant) =>
                        canonicalVariant(variant as RawEnvironmentSyncVariant),
                    )
                    .map((variant) =>
                        applyPayloadIgnore(variant, payloadEntries),
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
            variants
                .map((variant) => canonicalVariant(variant))
                .map((variant) => applyPayloadIgnore(variant, payloadEntries)),
        ),
    };
};

const parseJsonContainers = (raw: string | undefined): unknown => {
    if (raw === undefined) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return isPlainObject(parsed) || Array.isArray(parsed)
            ? parsed
            : undefined;
    } catch {
        return undefined;
    }
};

export interface MergeIgnoredJsonResult {
    value: string | undefined;
    /** Nested paths that exist on the target but could not be preserved. */
    lost: string[];
}

/**
 * Merges the target's environment-specific fields into the incoming value.
 * The source's values for those fields are never written: they are copied from
 * `existing`. When the target has a value that cannot be merged (the incoming
 * value is not JSON), the path is reported in `lost` so the caller can refuse
 * the write instead of silently dropping it.
 */
export const mergeIgnoredJsonValue = (
    incoming: string | undefined,
    existing: string | undefined,
    pointers: string[][],
): MergeIgnoredJsonResult => {
    const existingParsed = parseJsonContainers(existing);
    const incomingParsed = parseJsonContainers(incoming);

    if (existingParsed === undefined) {
        return { value: incoming, lost: [] };
    }
    if (incomingParsed === undefined) {
        return {
            value: incoming,
            lost: pointers
                .filter(
                    (pointer) =>
                        hasWildcard(pointer) ||
                        hasPointer(existingParsed, pointer),
                )
                .map((pointer) => `/${pointer.join('/')}`),
        };
    }

    const lost: string[] = [];
    for (const pointer of pointers) {
        if (hasWildcard(pointer)) {
            lost.push(
                ...mergeWildcardFields(incomingParsed, existingParsed, pointer),
            );
            continue;
        }
        const found = getPointer(existingParsed, pointer);
        if (found.found) {
            setPointer(incomingParsed, pointer, found.value);
        } else {
            deletePointer(incomingParsed, pointer);
        }
    }

    return { value: JSON.stringify(incomingParsed, null, 2), lost };
};

const normalizeJsonString = (value: string): string => {
    try {
        const parsed = JSON.parse(value);
        return parsed !== null && typeof parsed === 'object'
            ? stableStringify(parsed)
            : value;
    } catch {
        return value;
    }
};

const normalizeVariant = (
    variant: EnvironmentSyncVariant,
): EnvironmentSyncVariant =>
    variant.payload
        ? {
              ...variant,
              payload: {
                  ...variant.payload,
                  value: normalizeJsonString(variant.payload.value),
              },
          }
        : variant;

/**
 * JSON object key order is not semantic. Comparisons parse JSON-encoded
 * values and sort their keys so two environments that hold the same data in a
 * different order are not reported as drift.
 */
export const normalizeConfigForComparison = (
    config: EnvironmentSyncConfig,
): EnvironmentSyncConfig => ({
    strategies: config.strategies.map((strategy) => ({
        ...strategy,
        parameters: Object.fromEntries(
            Object.entries(strategy.parameters).map(([key, value]) => [
                key,
                normalizeJsonString(value),
            ]),
        ),
        variants: strategy.variants.map(normalizeVariant),
    })),
    variants: config.variants.map(normalizeVariant),
});

/**
 * Keeps the target's exact JSON string (and therefore its key order) when the
 * incoming value is semantically identical. A real change still writes the
 * incoming value.
 */
export const preserveJsonString = (
    incoming: string | undefined,
    existing: string | undefined,
): string | undefined => {
    if (incoming === undefined || existing === undefined) {
        return incoming;
    }
    let incomingParsed: unknown;
    let existingParsed: unknown;
    try {
        incomingParsed = JSON.parse(incoming);
        existingParsed = JSON.parse(existing);
    } catch {
        return incoming;
    }
    if (
        incomingParsed === null ||
        typeof incomingParsed !== 'object' ||
        existingParsed === null ||
        typeof existingParsed !== 'object'
    ) {
        return incoming;
    }

    if (stableStringify(incomingParsed) === stableStringify(existingParsed)) {
        // Same data: keep the target's exact string, including its spacing.
        return existing;
    }

    const mergePreservingOrder = (
        existingValue: unknown,
        incomingValue: unknown,
    ): unknown => {
        if (isPlainObject(existingValue) && isPlainObject(incomingValue)) {
            const result: Record<string, unknown> = {};
            for (const key of Object.keys(existingValue)) {
                if (Object.prototype.hasOwnProperty.call(incomingValue, key)) {
                    result[key] = mergePreservingOrder(
                        existingValue[key],
                        incomingValue[key],
                    );
                }
            }
            for (const key of Object.keys(incomingValue)) {
                if (!Object.prototype.hasOwnProperty.call(existingValue, key)) {
                    result[key] = incomingValue[key];
                }
            }
            return result;
        }
        // Array order is semantic; a different array is a real change.
        return incomingValue;
    };

    const merged = mergePreservingOrder(existingParsed, incomingParsed);
    return merged !== null && typeof merged === 'object'
        ? JSON.stringify(merged, null, 2)
        : incoming;
};

export const fingerprintConfig = (config: EnvironmentSyncConfig): string =>
    createHash('sha256')
        .update(stableStringify(normalizeConfigForComparison(config)))
        .digest('hex');

export const diffConfigs = (
    local: EnvironmentSyncConfig,
    remote: EnvironmentSyncConfig,
): EnvironmentSyncDifference[] => {
    const differences: EnvironmentSyncDifference[] = [];
    const localNormalized = normalizeConfigForComparison(local);
    const remoteNormalized = normalizeConfigForComparison(remote);
    if (
        stableStringify(localNormalized.strategies) !==
        stableStringify(remoteNormalized.strategies)
    ) {
        differences.push({
            field: 'strategies',
            local: local.strategies.length,
            remote: remote.strategies.length,
        });
    }
    if (
        stableStringify(localNormalized.variants) !==
        stableStringify(remoteNormalized.variants)
    ) {
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
