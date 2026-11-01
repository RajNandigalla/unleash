import { describe, expect, test } from 'vitest';
import type {
    EnvironmentSyncConfig,
    EnvironmentSyncStrategy,
    EnvironmentSyncVariant,
} from './environment-sync-config.js';
import {
    diffEnvironmentSyncConfigs,
    strategyLabel,
} from './environment-sync-diff.js';

const payload = (value: string) => ({ type: 'json', value });

const userStrategy = (
    userId: string,
    value: string,
    title?: string,
): EnvironmentSyncStrategy => ({
    name: 'flexibleRollout',
    ...(title ? { title } : {}),
    parameters: {
        rollout: '100',
        stickiness: 'default',
        groupId: 'multi',
    },
    constraints: [{ contextName: 'userId', operator: 'IN', values: [userId] }],
    segments: [],
    variants: [
        {
            name: `user-${userId}`,
            weight: 1000,
            weightType: 'variable',
            stickiness: 'default',
            payload: payload(value),
        },
    ],
});

const fallbackStrategy = (): EnvironmentSyncStrategy => ({
    name: 'flexibleRollout',
    parameters: { rollout: '100', stickiness: 'default', groupId: 'multi' },
    constraints: [],
    segments: [],
    variants: [
        {
            name: 'default',
            weight: 1000,
            weightType: 'variable',
            stickiness: 'default',
            payload: payload('{"tier":"free","limit":10}'),
        },
    ],
});

const config = (
    strategies: EnvironmentSyncStrategy[],
    variants: EnvironmentSyncVariant[] = [],
): EnvironmentSyncConfig => ({ strategies, variants });

const user1 = userStrategy('1', '{"tier":"gold","limit":100}', 'User 1');
const user2 = userStrategy('2', '{"tier":"silver","limit":50}', 'User 2');
const fallback = fallbackStrategy();

describe('diffEnvironmentSyncConfigs', () => {
    test('reports one modified strategy among three', () => {
        const local = config([user1, user2, fallback]);
        const remote = config([
            user1,
            {
                ...user2,
                variants: [
                    {
                        ...user2.variants[0],
                        payload: payload('{"tier":"bronze","limit":25}'),
                    },
                ],
            },
            fallback,
        ]);

        const diff = diffEnvironmentSyncConfigs(local, remote);

        expect(diff.summary).toEqual({
            total: 3,
            inSync: 2,
            outOfSync: 1,
        });
        expect(diff.strategies.map((item) => item.status)).toEqual([
            'in_sync',
            'modified',
            'in_sync',
        ]);
        expect(diff.strategies[1].label).toBe('User 2');
        expect(diff.strategies[1].changes).toContain('variants');
        expect(diff.orderChanged).toBe(false);
    });

    test('pairs a strategy whose targeting changed as modified', () => {
        const changedTargeting = {
            ...user1,
            constraints: [
                {
                    contextName: 'userId',
                    operator: 'IN',
                    values: ['1', '11'],
                },
            ],
        };

        const diff = diffEnvironmentSyncConfigs(
            config([changedTargeting, user2, fallback]),
            config([user1, user2, fallback]),
        );

        expect(diff.strategies.map((item) => item.status)).toEqual([
            'modified',
            'in_sync',
            'in_sync',
        ]);
        expect(diff.strategies[0].changes).toContain('constraints');
        expect(diff.summary).toEqual({
            total: 3,
            inSync: 2,
            outOfSync: 1,
        });
    });

    test('detects strategy order changes even when content matches', () => {
        const local = config([user1, user2, fallback]);
        const remote = config([fallback, user1, user2]);

        const diff = diffEnvironmentSyncConfigs(local, remote);

        expect(diff.orderChanged).toBe(true);
        expect(diff.summary.outOfSync).toBe(0);
        expect(diff.strategies.every((item) => item.status === 'in_sync')).toBe(
            true,
        );
    });

    test('reports strategies only on one side', () => {
        const local = config([user1, user2]);
        const remote = config([user1]);

        const addedOnSource = diffEnvironmentSyncConfigs(local, remote);
        expect(addedOnSource.strategies.map((item) => item.status)).toEqual([
            'in_sync',
            'only_source',
        ]);
        expect(addedOnSource.summary).toEqual({
            total: 2,
            inSync: 1,
            outOfSync: 1,
        });

        const addedOnTarget = diffEnvironmentSyncConfigs(remote, local);
        expect(addedOnTarget.strategies.map((item) => item.status)).toEqual([
            'in_sync',
            'only_target',
        ]);
    });

    test('pairs duplicate identities by content and detects reordering', () => {
        const first = userStrategy('1', '{"a":1}', 'First');
        const second = userStrategy('1', '{"a":2}', 'Second');

        const diff = diffEnvironmentSyncConfigs(
            config([first, second]),
            config([second, first]),
        );

        expect(diff.orderChanged).toBe(true);
        expect(diff.strategies.map((item) => item.label)).toEqual([
            'First',
            'Second',
        ]);
        expect(diff.strategies.every((item) => item.status === 'in_sync')).toBe(
            true,
        );
    });

    test('reports environment variant payload and override changes', () => {
        const baseVariant: EnvironmentSyncVariant = {
            name: 'user-1',
            weight: 1000,
            weightType: 'variable',
            stickiness: 'default',
            payload: payload('{"a":1}'),
            overrides: [{ contextName: 'userId', values: ['1'] }],
        };
        const defaultVariant: EnvironmentSyncVariant = {
            name: 'default',
            weight: 1000,
            weightType: 'variable',
            stickiness: 'default',
            payload: payload('{"a":0}'),
        };
        const local = config([], [baseVariant, defaultVariant]);
        const remote = config(
            [],
            [
                {
                    ...baseVariant,
                    payload: payload('{"a":2}'),
                    overrides: [{ contextName: 'userId', values: ['2'] }],
                },
                defaultVariant,
            ],
        );

        const diff = diffEnvironmentSyncConfigs(local, remote);

        expect(diff.variants[0].status).toBe('modified');
        expect(diff.variants[0].changes).toEqual(
            expect.arrayContaining(['payload', 'overrides']),
        );
        expect(diff.variants[1].status).toBe('in_sync');
    });

    test('labels constrained strategies by name and constraints', () => {
        const { title: _title, ...withoutTitle } = user1;
        expect(strategyLabel(withoutTitle)).toBe(
            'flexibleRollout · userId IN [1]',
        );
        expect(strategyLabel(user1)).toBe('User 1');
    });
});
