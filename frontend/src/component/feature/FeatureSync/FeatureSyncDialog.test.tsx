import { beforeEach, expect, test } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { SWRConfig } from 'swr';
import { render } from 'utils/testRenderer';
import { testServerRoute, testServerSetup } from 'utils/testServer';
import { FeatureSyncDialog } from './FeatureSyncDialog';

const server = testServerSetup();

beforeEach(() => {
    localStorage.clear();
});

const userStrategy = (userId: string, value: string, title: string) => ({
    name: 'flexibleRollout',
    title,
    parameters: {
        rollout: '100',
        stickiness: 'default',
        groupId: 'example-flag',
    },
    constraints: [{ contextName: 'userId', operator: 'IN', values: [userId] }],
    segments: [],
    variants: [
        {
            name: `user-${userId}`,
            weight: 1000,
            weightType: 'variable',
            stickiness: 'default',
            payload: { type: 'json', value },
        },
    ],
});

const fallbackStrategy = {
    name: 'flexibleRollout',
    title: 'Fallback',
    parameters: {
        rollout: '100',
        stickiness: 'default',
        groupId: 'example-flag',
    },
    constraints: [],
    segments: [],
    variants: [
        {
            name: 'default',
            weight: 1000,
            weightType: 'variable',
            stickiness: 'default',
            payload: { type: 'json', value: '{"tier":"free"}' },
        },
    ],
};

const setupApi = () => {
    testServerRoute(server, '/api/admin/ui-config', {
        flags: { environmentSync: true },
    });
    const user1 = userStrategy('1', '{"tier":"gold"}', 'User 1');
    const user2 = userStrategy('2', '{"tier":"silver"}', 'User 2');
    const modifiedUser2 = {
        ...user2,
        variants: [
            {
                ...user2.variants[0],
                payload: { type: 'json', value: '{"tier":"bronze"}' },
            },
        ],
    };
    testServerRoute(
        server,
        '/api/admin/environment-sync/projects/default/features/example-flag/compare',
        {
            featureName: 'example-flag',
            targets: [
                {
                    targetId: 1,
                    targetName: 'QA',
                    sourceEnvironment: 'development',
                    targetEnvironment: 'production',
                    status: 'drift',
                    differences: [
                        {
                            field: 'strategies',
                            local: 3,
                            remote: 3,
                        },
                    ],
                    local: {
                        strategies: [user1, user2, fallbackStrategy],
                        variants: [],
                    },
                    remote: {
                        strategies: [user1, modifiedUser2, fallbackStrategy],
                        variants: [],
                    },
                    diff: {
                        strategies: [
                            {
                                key: 'user-1',
                                label: 'User 1',
                                status: 'in_sync',
                                changes: [],
                                local: user1,
                                remote: user1,
                            },
                            {
                                key: 'user-2',
                                label: 'User 2',
                                status: 'modified',
                                changes: ['variants'],
                                local: user2,
                                remote: modifiedUser2,
                            },
                            {
                                key: 'fallback',
                                label: 'Fallback',
                                status: 'in_sync',
                                changes: [],
                                local: fallbackStrategy,
                                remote: fallbackStrategy,
                            },
                        ],
                        variants: [],
                        orderChanged: false,
                        summary: { total: 3, inSync: 2, outOfSync: 1 },
                    },
                },
            ],
        },
    );
    return testServerRoute(
        server,
        '/api/admin/environment-sync/projects/default/sync',
        {
            results: [
                {
                    targetId: 1,
                    targetName: 'QA',
                    features: [
                        {
                            featureName: 'example-flag',
                            status: 'synced',
                            created: false,
                        },
                    ],
                },
            ],
        },
        'post',
    );
};

test('shows the config diff and syncs the out-of-sync target', async () => {
    const syncRequests = setupApi();

    render(
        <FeatureSyncDialog
            projectId='default'
            featureName='example-flag'
            open
            onClose={() => undefined}
        />,
    );

    expect(await screen.findByText('QA')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 strategies in sync')).toBeInTheDocument();
    expect(screen.getByText('1 out of sync')).toBeInTheDocument();
    expect(screen.getByText('User 2')).toBeInTheDocument();
    expect(screen.getByText('variants / payload')).toBeInTheDocument();
    expect(screen.getAllByText('Out of sync').length).toBeGreaterThan(0);

    fireEvent.click(
        screen.getByRole('button', {
            name: 'Sync this target',
        }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));

    await waitFor(() => expect(syncRequests.requests).toHaveLength(1));
    expect(syncRequests.requests[0]).toEqual({
        featureNames: ['example-flag'],
        targetIds: [1],
        onlyOutOfSync: false,
    });
});

test('opens the sync confirmation directly when asked to sync', async () => {
    setupApi();

    render(
        <FeatureSyncDialog
            projectId='default'
            featureName='example-flag'
            open
            initialTargetId={1}
            initialAction='sync'
            onClose={() => undefined}
        />,
    );

    expect(await screen.findByText('Sync configuration?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
        expect(
            screen.queryByText('Sync configuration?'),
        ).not.toBeInTheDocument(),
    );
});

test('keeps the selected tab when the compare request revalidates', async () => {
    testServerRoute(server, '/api/admin/ui-config', {
        flags: { environmentSync: true },
    });

    let compareCalls = 0;
    const target = (targetId: number, targetName: string) => ({
        targetId,
        targetName,
        sourceEnvironment: 'development',
        targetEnvironment: 'production',
        status: 'drift',
        // Changes on every request so SWR does not skip the re-render.
        lastSyncedAt: new Date(compareCalls).toISOString(),
        differences: [],
        local: { strategies: [fallbackStrategy], variants: [] },
        remote: { strategies: [], variants: [] },
    });
    server.use(
        http.get(
            '/api/admin/environment-sync/projects/default/features/example-flag/compare',
            () => {
                compareCalls += 1;
                return HttpResponse.json({
                    featureName: 'example-flag',
                    targets: [target(1, 'QA'), target(2, 'EU')],
                });
            },
        ),
    );

    render(
        <SWRConfig value={{ focusThrottleInterval: 0 }}>
            <FeatureSyncDialog
                projectId='default'
                featureName='example-flag'
                open
                onClose={() => undefined}
            />
        </SWRConfig>,
    );

    await waitFor(() => expect(compareCalls).toBe(1));

    fireEvent.click(await screen.findByRole('tab', { name: /EU/ }));

    await waitFor(() =>
        expect(screen.getByRole('tab', { name: /EU/ })).toHaveAttribute(
            'aria-selected',
            'true',
        ),
    );

    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));

    await waitFor(() => expect(compareCalls).toBeGreaterThan(1), {
        timeout: 3000,
    });

    expect(screen.getByRole('tab', { name: /EU/ })).toHaveAttribute(
        'aria-selected',
        'true',
    );
});
