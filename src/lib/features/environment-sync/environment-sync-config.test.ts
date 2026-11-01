import { describe, expect, test } from 'vitest';
import {
    canonicalConfig,
    diffConfigs,
    emptyConfig,
    fingerprintConfig,
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
