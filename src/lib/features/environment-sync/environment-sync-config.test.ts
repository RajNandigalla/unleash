import {
    canonicalConfig,
    diffConfigs,
    emptyConfig,
    emptyIgnoredConfig,
    fingerprintConfig,
    isFeatureIgnored,
    ignoredConfigForFeature,
    mergeIgnoredJsonValue,
    preserveJsonString,
    normalizeIgnoredConfig,
    parseIgnoredConfig,
    stableStringify,
} from './environment-sync-config.js';

const segmentNames = new Map([
    [1, 'internal-users'],
    [2, 'beta-users'],
]);

const baseInput = {
    strategySegments: [
        { featureStrategyId: 'a', segmentId: 1 },
        { featureStrategyId: 'a', segmentId: 2 },
    ],
    segmentNamesById: segmentNames,
};

const strategies = [
    {
        id: 'a',
        strategyName: 'flexibleRollout',
        title: 'Rollout 50%',
        disabled: false,
        parameters: { rollout: '50', stickiness: 'default', groupId: 'flag' },
        constraints: [
            {
                contextName: 'environment',
                operator: 'IN',
                values: ['production', 'development'],
            },
        ],
        variants: [],
    },
    {
        id: 'b',
        strategyName: 'userWithId',
        parameters: { userIds: '1,2' },
        constraints: [],
        variants: [
            {
                name: 'b',
                weight: 1000,
                weightType: 'variable',
                stickiness: 'default',
            },
        ],
    },
];

describe('canonicalConfig', () => {
    test('strips ids and maps segment ids to names', () => {
        const config = canonicalConfig({
            ...baseInput,
            strategies,
            variants: [
                {
                    name: 'b',
                    weight: 1000,
                    weightType: 'variable',
                    stickiness: 'default',
                },
                {
                    name: 'a',
                    weight: 0,
                    weightType: 'variable',
                    stickiness: 'default',
                },
            ],
        });

        expect(config.strategies).toHaveLength(2);
        expect(config.strategies[0]).not.toHaveProperty('id');
        expect(config.strategies[0]).not.toHaveProperty('strategyName');
        expect(
            config.strategies.find(
                (strategy) => strategy.name === 'flexibleRollout',
            )?.segments,
        ).toEqual(['beta-users', 'internal-users']);
        expect(config.variants.map((variant) => variant.name)).toEqual([
            'a',
            'b',
        ]);
    });

    test('ignores key order inside strategies but preserves strategy order', () => {
        const first = canonicalConfig({
            ...baseInput,
            strategies,
            variants: [],
        });
        const reorderedKeys = canonicalConfig({
            ...baseInput,
            strategies: strategies.map((strategy) => ({
                ...strategy,
                constraints: [...strategy.constraints].reverse(),
                parameters: Object.fromEntries(
                    Object.entries(strategy.parameters).reverse(),
                ),
            })),
            variants: [],
        });
        const reorderedStrategies = canonicalConfig({
            ...baseInput,
            strategies: [...strategies].reverse(),
            variants: [],
        });

        expect(stableStringify(first)).toEqual(stableStringify(reorderedKeys));
        expect(fingerprintConfig(first)).toEqual(
            fingerprintConfig(reorderedKeys),
        );
        expect(fingerprintConfig(first)).not.toEqual(
            fingerprintConfig(reorderedStrategies),
        );
    });

    test('changes the fingerprint when a strategy or variant changes', () => {
        const base = canonicalConfig({
            ...baseInput,
            strategies,
            variants: [],
        });
        const changedStrategy = canonicalConfig({
            ...baseInput,
            strategies: [
                {
                    ...strategies[0],
                    parameters: { ...strategies[0].parameters, rollout: '10' },
                },
                strategies[1],
            ],
            variants: [],
        });
        const changedVariant = canonicalConfig({
            ...baseInput,
            strategies,
            variants: [
                {
                    name: 'a',
                    weight: 1000,
                    weightType: 'variable',
                    stickiness: 'default',
                },
            ],
        });

        expect(fingerprintConfig(base)).not.toEqual(
            fingerprintConfig(changedStrategy),
        );
        expect(fingerprintConfig(base)).not.toEqual(
            fingerprintConfig(changedVariant),
        );
    });

    test('diffConfigs reports strategies and variants', () => {
        const local = canonicalConfig({
            ...baseInput,
            strategies,
            variants: [],
        });
        const remote = canonicalConfig({
            ...baseInput,
            strategies: [strategies[0]],
            variants: [
                {
                    name: 'a',
                    weight: 1000,
                    weightType: 'variable',
                    stickiness: 'default',
                },
            ],
        });

        expect(diffConfigs(local, remote)).toEqual([
            { field: 'strategies', local: 2, remote: 1 },
            { field: 'variants', local: 0, remote: 1 },
        ]);
    });

    test('empty config has a stable fingerprint', () => {
        expect(fingerprintConfig(emptyConfig())).toEqual(
            fingerprintConfig(emptyConfig()),
        );
    });
});

describe('stableStringify', () => {
    test('sorts object keys recursively', () => {
        expect(
            stableStringify({
                b: 1,
                a: { d: 2, c: 3 },
                list: [{ z: 1, y: 2 }],
            }),
        ).toEqual('{"a":{"c":3,"d":2},"b":1,"list":[{"y":2,"z":1}]}');
    });
});

describe('ignored environment-specific values', () => {
    const build = (
        parameters: Record<string, string>,
        ignored: Parameters<typeof canonicalConfig>[1],
        variants: {
            name: string;
            payload?: { type: string; value: string };
        }[] = [],
    ) =>
        canonicalConfig(
            {
                strategySegments: [],
                segmentNamesById: new Map(),
                strategies: [
                    {
                        id: 'a',
                        strategyName: 'customStrategy',
                        parameters,
                        constraints: [],
                        variants: [],
                    },
                ],
                variants: variants.map((variant) => ({
                    name: variant.name,
                    weight: 1000,
                    weightType: 'variable',
                    stickiness: 'default',
                    payload: variant.payload,
                })),
            },
            ignored,
        );

    test('drops a whole parameter from the fingerprint', () => {
        const ignored = {
            parameters: ['loginUrl'],
            variantPayloads: [],
            ignoredFeatures: [],
        };
        const dev = build({ loginUrl: 'https://ab-test.com' }, ignored);
        const prod = build({ loginUrl: 'https://test.com' }, ignored);

        expect(fingerprintConfig(dev)).toEqual(fingerprintConfig(prod));
        expect(dev.strategies[0].parameters).toEqual({});
    });

    test('drops only the nested field from a JSON parameter', () => {
        const ignored = {
            parameters: ['config::/sso/loginUrl', 'config::/sso/secret'],
            variantPayloads: [],
            ignoredFeatures: [],
        };
        const dev = build(
            {
                config: JSON.stringify({
                    sso: {
                        loginUrl: 'https://ab-test.com',
                        secret: 'dev',
                        timeout: 5,
                    },
                }),
            },
            ignored,
        );
        const prod = build(
            {
                config: JSON.stringify({
                    sso: {
                        loginUrl: 'https://test.com',
                        secret: 'prod',
                        timeout: 5,
                    },
                }),
            },
            ignored,
        );

        expect(fingerprintConfig(dev)).toEqual(fingerprintConfig(prod));
        expect(JSON.parse(dev.strategies[0].parameters.config)).toEqual({
            sso: { timeout: 5 },
        });
    });

    test('nested ignores make JSON key order and whitespace irrelevant', () => {
        const ignored = {
            parameters: ['config::/sso/loginUrl'],
            variantPayloads: [],
            ignoredFeatures: [],
        };
        const compact = build(
            {
                config: '{"sso":{"loginUrl":"https://ab-test.com","timeout":5}}',
            },
            ignored,
        );
        const reordered = build(
            {
                config: '{ "sso": { "timeout": 5, "loginUrl": "https://ab-test.com" } }',
            },
            ignored,
        );

        expect(fingerprintConfig(compact)).toEqual(
            fingerprintConfig(reordered),
        );
    });

    test('leaves a non-JSON value untouched', () => {
        const ignored = {
            parameters: ['config::/sso/loginUrl'],
            variantPayloads: [],
            ignoredFeatures: [],
        };
        const dev = build({ config: 'not-json' }, ignored);

        expect(dev.strategies[0].parameters.config).toEqual('not-json');
    });

    test('ignores every variant payload with *', () => {
        const ignored = {
            parameters: [],
            variantPayloads: ['*'],
            ignoredFeatures: [],
        };
        const dev = build({}, ignored, [
            { name: 'a', payload: { type: 'json', value: '{"x":1}' } },
        ]);
        const prod = build({}, ignored, [
            { name: 'a', payload: { type: 'json', value: '{"x":2}' } },
        ]);

        expect(fingerprintConfig(dev)).toEqual(fingerprintConfig(prod));
        expect(dev.variants[0]).not.toHaveProperty('payload');
    });

    test('ignores one nested field of a variant payload', () => {
        const ignored = {
            parameters: [],
            variantPayloads: ['*::/redirectUrl'],
            ignoredFeatures: [],
        };
        const dev = build({}, ignored, [
            {
                name: 'a',
                payload: {
                    type: 'json',
                    value: '{"redirectUrl":"https://ab-test.com","n":1}',
                },
            },
        ]);
        const prod = build({}, ignored, [
            {
                name: 'a',
                payload: {
                    type: 'json',
                    value: '{"redirectUrl":"https://test.com","n":1}',
                },
            },
        ]);

        expect(fingerprintConfig(dev)).toEqual(fingerprintConfig(prod));
        expect(JSON.parse(dev.variants[0].payload!.value)).toEqual({ n: 1 });
    });

    test('does not ignore anything without a configured entry', () => {
        const dev = build({ loginUrl: 'https://ab-test.com' }, undefined);
        const prod = build({ loginUrl: 'https://test.com' }, undefined);

        expect(fingerprintConfig(dev)).not.toEqual(fingerprintConfig(prod));
    });
});

describe('parseIgnoredConfig', () => {
    test('defaults to empty config', () => {
        expect(parseIgnoredConfig(undefined)).toEqual(emptyIgnoredConfig());
    });

    test('trims, dedupes and accepts nested entries', () => {
        expect(
            parseIgnoredConfig({
                parameters: [' loginUrl ', 'loginUrl'],
                variantPayloads: ['*::/redirectUrl'],
                ignoredFeatures: ['legacy-*'],
            }),
        ).toEqual({
            parameters: ['loginUrl'],
            variantPayloads: ['*::/redirectUrl'],
            ignoredFeatures: ['legacy-*'],
        });
    });

    test('rejects malformed input', () => {
        expect(() => parseIgnoredConfig({ parameters: 'loginUrl' })).toThrow(
            'must be an array',
        );
        expect(() =>
            parseIgnoredConfig({ parameters: ['config::nope'] }),
        ).toThrow('must start with "/"');
        expect(() => parseIgnoredConfig({ parameters: ['*'] })).toThrow(
            'cannot use "*"',
        );
    });
});

describe('normalizeIgnoredConfig', () => {
    test('drops malformed persisted entries', () => {
        expect(
            normalizeIgnoredConfig({
                parameters: ['loginUrl', 'config::nope', '*', 42],
                variantPayloads: ['*', 'control::/x'],
                ignoredFeatures: ['legacy-*', ''],
            }),
        ).toEqual({
            parameters: ['loginUrl'],
            variantPayloads: ['*', 'control::/x'],
            ignoredFeatures: ['legacy-*'],
        });
    });

    test('tolerates missing values', () => {
        expect(normalizeIgnoredConfig(null)).toEqual(emptyIgnoredConfig());
    });
});

describe('isFeatureIgnored', () => {
    test('matches exact names and globs', () => {
        const ignored = {
            parameters: [],
            variantPayloads: [],
            ignoredFeatures: ['login-url', 'legacy-*'],
        };

        expect(isFeatureIgnored('login-url', ignored)).toBe(true);
        expect(isFeatureIgnored('legacy-checkout', ignored)).toBe(true);
        expect(isFeatureIgnored('checkout', ignored)).toBe(false);
    });

    test('matches tag rules against the flag tags', () => {
        const ignored = {
            parameters: [],
            variantPayloads: [],
            ignoredFeatures: ['tag:no-env-sync', 'tag:no-*'],
        };

        expect(isFeatureIgnored('a', ignored, ['no-env-sync'])).toBe(true);
        expect(isFeatureIgnored('b', ignored, ['no-sync'])).toBe(true);
        expect(isFeatureIgnored('c', ignored, ['frontend'])).toBe(false);
        expect(isFeatureIgnored('d', ignored, [])).toBe(false);
    });
});

describe('wildcard ignored fields', () => {
    test('restores the field on every array element', () => {
        const result = mergeIgnoredJsonValue(
            JSON.stringify({
                items: [
                    { url: 'in-1', id: 1 },
                    { url: 'in-2', id: 2 },
                ],
            }),
            JSON.stringify({
                items: [
                    { url: 'keep-1', id: 9 },
                    { url: 'keep-2', id: 8 },
                ],
            }),
            [['items', '*', 'url']],
        );

        expect(JSON.parse(result.value as string)).toEqual({
            items: [
                { url: 'keep-1', id: 1 },
                { url: 'keep-2', id: 2 },
            ],
        });
        expect(result.lost).toEqual([]);
    });

    test('reports a wildcard it cannot restore', () => {
        const result = mergeIgnoredJsonValue(
            JSON.stringify({ items: [{ url: 'in-1' }] }),
            JSON.stringify({ items: [{ url: 'keep-1' }, { url: 'keep-2' }] }),
            [['items', '*', 'url']],
        );

        expect(result.lost).toEqual(['/items/*/url']);
    });
});

describe('feature-scoped field exclusions', () => {
    test('parses and merges only into the named feature', () => {
        const parsed = parseIgnoredConfig({
            parameters: [],
            variantPayloads: [],
            ignoredFeatures: [],
            featureFields: [
                {
                    feature: 'flag-a',
                    parameters: ['config::/sso/loginUrl'],
                    variantPayloads: ['*::/redirectUrl'],
                },
            ],
        });

        expect(parsed.featureFields).toEqual([
            {
                feature: 'flag-a',
                parameters: ['config::/sso/loginUrl'],
                variantPayloads: ['*::/redirectUrl'],
            },
        ]);
        expect(ignoredConfigForFeature(parsed, 'flag-a').parameters).toEqual([
            'config::/sso/loginUrl',
        ]);
        expect(
            ignoredConfigForFeature(parsed, 'flag-a').variantPayloads,
        ).toEqual(['*::/redirectUrl']);
        expect(ignoredConfigForFeature(parsed, 'flag-b').parameters).toEqual(
            [],
        );
    });
});

describe('JSON ordering', () => {
    test('ignores object key order in fingerprints', () => {
        const ignored = {
            parameters: [],
            variantPayloads: [],
            ignoredFeatures: [],
        };
        const build = (config: string) =>
            canonicalConfig(
                {
                    strategies: [
                        {
                            id: 'a',
                            strategyName: 'custom',
                            parameters: { config },
                            constraints: [],
                            variants: [],
                        },
                    ],
                    variants: [],
                    strategySegments: [],
                    segmentNamesById: new Map(),
                },
                ignored,
            );

        expect(fingerprintConfig(build('{"a":1,"b":2}'))).toEqual(
            fingerprintConfig(build('{"b":2,"a":1}')),
        );
    });

    test('keeps key order when stripping a nested field', () => {
        const ignored = {
            parameters: ['config::/a/secret'],
            variantPayloads: [],
            ignoredFeatures: [],
        };
        const config = canonicalConfig(
            {
                strategies: [
                    {
                        id: 'a',
                        strategyName: 'custom',
                        parameters: {
                            config: '{"z":1,"a":{"secret":"x","keep":2},"m":3}',
                        },
                        constraints: [],
                        variants: [],
                    },
                ],
                variants: [],
                strategySegments: [],
                segmentNamesById: new Map(),
            },
            ignored,
        );

        const serialized = JSON.parse(config.strategies[0].parameters.config);
        expect(Object.keys(serialized)).toEqual(['z', 'a', 'm']);
        expect(serialized.a).toEqual({ keep: 2 });
    });
});

describe('preserveJsonString', () => {
    test('keeps the target order while updating a value', () => {
        const result = JSON.parse(
            preserveJsonString('{"a":9,"b":2}', '{"b":2,"a":1}') as string,
        );
        expect(Object.keys(result)).toEqual(['b', 'a']);
        expect(result).toEqual({ b: 2, a: 9 });
    });

    test('keeps the target order in nested objects', () => {
        const result = JSON.parse(
            preserveJsonString(
                '{"a":0,"b":{"x":3,"y":1}}',
                '{"b":{"y":1,"x":2},"a":0}',
            ) as string,
        );
        expect(Object.keys(result)).toEqual(['b', 'a']);
        expect(Object.keys(result.b)).toEqual(['y', 'x']);
        expect(result).toEqual({ b: { y: 1, x: 3 }, a: 0 });
    });

    test('keeps the target string when nothing changed', () => {
        expect(preserveJsonString('{"a":1,"b":2}', '{"b":2,"a":1}')).toEqual(
            '{"b":2,"a":1}',
        );
    });

    test('uses the incoming array order for a changed array', () => {
        const result = JSON.parse(
            preserveJsonString('{"items":[2,1]}', '{"items":[1,2]}') as string,
        );
        expect(result.items).toEqual([2, 1]);
    });
});
