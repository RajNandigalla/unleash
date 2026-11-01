import { expect, test } from 'vitest';
import { expandJsonPayloads } from './expandJsonPayloads';

const payload = (value: string) => ({ type: 'json', value });

test('parses json payload strings for display', () => {
    const expanded = expandJsonPayloads({
        strategies: [
            {
                name: 'flexibleRollout',
                parameters: {},
                constraints: [],
                segments: [],
                variants: [
                    {
                        name: 'user-1',
                        weight: 1000,
                        payload: payload('{\n  "enabled": true\n}'),
                    },
                ],
            },
        ],
        variants: [
            {
                name: 'user-2',
                weight: 1000,
                payload: payload('{"tier":"gold"}'),
            },
        ],
    }) as {
        strategies: {
            variants: { payload: { value: unknown } }[];
        }[];
        variants: { payload: { value: unknown } }[];
    };

    expect(expanded.strategies[0].variants[0].payload.value).toEqual({
        enabled: true,
    });
    expect(expanded.variants[0].payload.value).toEqual({ tier: 'gold' });
});

test('keeps invalid json and non-json payloads untouched', () => {
    const expanded = expandJsonPayloads({
        strategies: [],
        variants: [
            {
                name: 'invalid',
                weight: 1000,
                payload: payload('{not json'),
            },
            {
                name: 'text',
                weight: 1000,
                payload: { type: 'string', value: '{"enabled":true}' },
            },
        ],
    }) as {
        variants: { payload: { type: string; value: unknown } }[];
    };

    expect(expanded.variants[0].payload.value).toBe('{not json');
    expect(expanded.variants[1].payload.value).toBe('{"enabled":true}');
});
