import { describe, expect, test } from 'vitest';
import {
    collectEnvironmentSyncCatalog,
    digestCatalogValue,
} from './environment-sync-catalog.js';
import {
    canonicalConfig,
    type EnvironmentSyncConfig,
} from './environment-sync-config.js';

const config = (
    parameters: Record<string, string>,
    variants: {
        name: string;
        payload?: { type: string; value: string };
    }[] = [],
): EnvironmentSyncConfig =>
    canonicalConfig({
        strategies: [
            {
                id: 's',
                strategyName: 'custom',
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
        strategySegments: [],
        segmentNamesById: new Map(),
    });

const collect = (entries: { name: string; config: EnvironmentSyncConfig }[]) =>
    collectEnvironmentSyncCatalog('development', entries);

describe('collectEnvironmentSyncCatalog', () => {
    test('aggregates a parameter across flags', () => {
        const catalog = collect([
            { name: 'a', config: config({ loginUrl: 'https://ab-test.com' }) },
            { name: 'b', config: config({ loginUrl: 'https://ab-test.com' }) },
        ]);

        expect(catalog.entries).toEqual([
            {
                entry: 'loginUrl',
                kind: 'parameter',
                flagCount: 2,
                usageCount: 2,
                samples: ['https://ab-test.com'],
                valuesByFlag: {
                    a: digestCatalogValue('https://ab-test.com'),
                    b: digestCatalogValue('https://ab-test.com'),
                },
            },
        ]);
    });

    test('lists JSON leaves as pointer entries', () => {
        const catalog = collect([
            {
                name: 'a',
                config: config({
                    config: JSON.stringify({
                        sso: { loginUrl: 'https://ab-test.com', timeout: 5 },
                    }),
                }),
            },
        ]);

        expect(catalog.entries.map((entry) => entry.entry).sort()).toEqual([
            'config::/sso/loginUrl',
            'config::/sso/timeout',
        ]);
        expect(
            catalog.entries.find(
                (entry) => entry.entry === 'config::/sso/timeout',
            )?.samples,
        ).toEqual(['5']);
    });

    test('aggregates variant payload leaves under *', () => {
        const catalog = collect([
            {
                name: 'a',
                config: config({}, [
                    {
                        name: 'control',
                        payload: {
                            type: 'json',
                            value: '{"redirectUrl":"https://ab-test.com"}',
                        },
                    },
                ]),
            },
        ]);

        expect(catalog.entries).toEqual([
            {
                entry: '*::/redirectUrl',
                kind: 'variantPayload',
                flagCount: 1,
                usageCount: 1,
                samples: ['https://ab-test.com'],
                valuesByFlag: {
                    a: digestCatalogValue('https://ab-test.com'),
                },
            },
        ]);
    });

    test('keeps non-JSON payloads as the whole value', () => {
        const catalog = collect([
            {
                name: 'a',
                config: config({}, [
                    {
                        name: 'control',
                        payload: { type: 'string', value: 'hello' },
                    },
                ]),
            },
        ]);

        expect(catalog.entries.map((entry) => entry.entry)).toEqual(['*']);
    });

    test('counts distinct flags and sample values', () => {
        const catalog = collect([
            { name: 'a', config: config({ loginUrl: 'https://ab-test.com' }) },
            { name: 'b', config: config({ loginUrl: 'https://test.com' }) },
            { name: 'c', config: config({ loginUrl: 'https://test.com' }) },
        ]);

        expect(catalog.entries[0].flagCount).toBe(3);
        expect(catalog.entries[0].usageCount).toBe(3);
        expect(catalog.entries[0].samples).toEqual([
            'https://ab-test.com',
            'https://test.com',
        ]);
    });

    test('compares values past the sample truncation point', () => {
        const prefix = 'x'.repeat(160);
        const catalog = collect([
            { name: 'a', config: config({ loginUrl: `${prefix}A` }) },
            { name: 'b', config: config({ loginUrl: `${prefix}B` }) },
        ]);

        const entry = catalog.entries[0];
        // Both samples render identically, but the digests differ.
        expect(entry.samples).toEqual([`${prefix}…`]);
        expect(entry.valuesByFlag.a).toHaveLength(64);
        expect(entry.valuesByFlag.a).not.toBe(entry.valuesByFlag.b);
    });

    test('skips path segments the pointer parser rejects', () => {
        const catalog = collect([
            {
                name: 'a',
                config: config({
                    config: '{"__proto__":{"x":1},"constructor":{"y":2},"safe":3}',
                }),
            },
        ]);

        expect(catalog.entries.map((entry) => entry.entry)).toEqual([
            'config::/safe',
        ]);
    });

    test('returns the flag list for the exclusion picker', () => {
        const flags = [
            { name: 'a', project: 'p', tags: ['no-sync'] },
            { name: 'b', project: 'p', tags: [] },
        ];
        const catalog = collectEnvironmentSyncCatalog(
            'development',
            [{ name: 'a', config: config({ loginUrl: 'x' }) }],
            flags,
        );

        expect(catalog.flags).toEqual(flags);
    });

    test('truncates large JSON and keeps the whole parameter', () => {
        const large = Object.fromEntries(
            Array.from({ length: 150 }, (_, index) => [`key${index}`, index]),
        );
        const catalog = collect([
            {
                name: 'a',
                config: config({ config: JSON.stringify(large) }),
            },
        ]);

        expect(catalog.truncated).toBe(true);
        expect(catalog.entries.some((entry) => entry.entry === 'config')).toBe(
            true,
        );
    });
});

describe('array paths', () => {
    test('collapses indices into one wildcard path', () => {
        const catalog = collect([
            {
                name: 'a',
                config: config({
                    config: JSON.stringify([
                        { url: 'x', id: 1 },
                        { url: 'y', id: 2 },
                    ]),
                }),
            },
        ]);

        expect(catalog.entries.map((entry) => entry.entry).sort()).toEqual([
            'config::/*/id',
            'config::/*/url',
        ]);
    });

    test('treats an array of primitives as the whole value', () => {
        const catalog = collect([
            { name: 'a', config: config({ tags: '["a","b"]' }) },
        ]);

        expect(catalog.entries.map((entry) => entry.entry)).toEqual(['tags']);
    });

    test('does not truncate a large array with a small shape', () => {
        const items = Array.from({ length: 300 }, (_, index) => ({
            url: `u${index}`,
            id: index,
        }));
        const catalog = collect([
            {
                name: 'a',
                config: config({ config: JSON.stringify(items) }),
            },
        ]);

        expect(catalog.truncated).toBe(false);
        expect(catalog.entries).toHaveLength(2);
    });
});
