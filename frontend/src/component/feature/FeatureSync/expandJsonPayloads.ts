const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const expandPayload = (payload: unknown): unknown => {
    if (
        !isRecord(payload) ||
        payload.type !== 'json' ||
        typeof payload.value !== 'string'
    ) {
        return payload;
    }

    try {
        return { ...payload, value: JSON.parse(payload.value) };
    } catch {
        // Not valid JSON: keep the original string so the diff still shows it.
        return payload;
    }
};

export const expandVariantPayloads = (variant: unknown): unknown => {
    if (!isRecord(variant)) {
        return variant;
    }
    return { ...variant, payload: expandPayload(variant.payload) };
};

export const expandStrategyPayloads = (strategy: unknown): unknown => {
    if (!isRecord(strategy)) {
        return strategy;
    }
    return {
        ...strategy,
        variants: Array.isArray(strategy.variants)
            ? strategy.variants.map(expandVariantPayloads)
            : strategy.variants,
    };
};

/**
 * Returns a display-only copy of the config where JSON payload strings are
 * parsed so the diff shows their structure. The synced config still contains
 * the original strings.
 */
export const expandJsonPayloads = (config: unknown): unknown => {
    if (!isRecord(config)) {
        return config;
    }
    return {
        ...config,
        strategies: Array.isArray(config.strategies)
            ? config.strategies.map(expandStrategyPayloads)
            : config.strategies,
        variants: Array.isArray(config.variants)
            ? config.variants.map(expandVariantPayloads)
            : config.variants,
    };
};

export const expandDiffItemPayloads = (item: unknown): unknown => {
    if (!isRecord(item)) {
        return item;
    }
    return 'parameters' in item
        ? expandStrategyPayloads(item)
        : expandVariantPayloads(item);
};
