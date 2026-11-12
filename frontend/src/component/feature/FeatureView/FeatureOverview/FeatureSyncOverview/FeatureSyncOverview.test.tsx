import { beforeEach, expect, test } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from 'utils/testRenderer';
import { testServerRoute, testServerSetup } from 'utils/testServer';
import { http, HttpResponse } from 'msw';
import {
    ADMIN,
    UPDATE_FEATURE_ENVIRONMENT,
} from 'component/providers/AccessProvider/permissions';
import { FeatureSyncOverview } from './FeatureSyncOverview';

const server = testServerSetup();

beforeEach(() => {
    localStorage.clear();
});

const strategy = (value: string) => ({
    name: 'flexibleRollout',
    title: 'User 1',
    parameters: { rollout: '100', stickiness: 'default', groupId: 'example' },
    constraints: [{ contextName: 'userId', operator: 'IN', values: ['1'] }],
    segments: [],
    variants: [
        {
            name: 'user-1',
            weight: 1000,
            weightType: 'variable',
            stickiness: 'default',
            payload: { type: 'json', value },
        },
    ],
});

const compareResponse = (status: 'drift' | 'in_sync') => {
    const local = strategy('{"tier":"gold"}');
    const remote = status === 'in_sync' ? local : strategy('{"tier":"silver"}');

    return {
        featureName: 'example-flag',
        targets: [
            {
                targetId: 1,
                targetName: 'Remote',
                sourceEnvironment: 'development',
                targetEnvironment: 'production',
                status,
                differences:
                    status === 'in_sync'
                        ? []
                        : [{ field: 'strategies', local: 1, remote: 1 }],
                local: { strategies: [local], variants: [] },
                remote: { strategies: [remote], variants: [] },
                diff: {
                    strategies: [
                        {
                            key: 'user-1',
                            label: 'User 1',
                            status:
                                status === 'in_sync' ? 'in_sync' : 'modified',
                            changes: status === 'in_sync' ? [] : ['variants'],
                            local,
                            remote,
                        },
                    ],
                    variants: [],
                    orderChanged: false,
                    summary: {
                        total: 1,
                        inSync: status === 'in_sync' ? 1 : 0,
                        outOfSync: status === 'in_sync' ? 0 : 1,
                    },
                },
            },
        ],
    };
};

const setupApi = (
    firstStatus: 'drift' | 'in_sync' = 'drift',
    nextStatus: 'drift' | 'in_sync' = 'drift',
) => {
    testServerRoute(server, '/api/admin/ui-config', {
        flags: { environmentSync: true },
    });
    testServerRoute(server, '/api/admin/environment-sync/targets', {
        tokenStorageConfigured: true,
        targets: [
            {
                id: 1,
                name: 'Remote',
                url: 'https://remote.example.com',
                project: 'default',
                sourceEnvironment: 'development',
                targetEnvironment: 'production',
                enabled: true,
                ignoredConfig: {
                    parameters: [],
                    variantPayloads: [],
                    ignoredFeatures: [],
                },
                createdAt: new Date().toISOString(),
                createdBy: 'admin',
                hasToken: true,
                lastTestedAt: null,
                lastTestStatus: null,
                lastTestError: null,
                lastSyncedAt: null,
                lastSyncStatus: null,
                lastSyncError: null,
            },
        ],
    });

    let compareCalls = 0;
    server.use(
        http.get(
            '/api/admin/environment-sync/projects/default/features/example-flag/compare',
            () => {
                const status = compareCalls++ === 0 ? firstStatus : nextStatus;
                return HttpResponse.json(compareResponse(status));
            },
        ),
    );
};

const renderOverview = () =>
    render(
        <FeatureSyncOverview projectId='default' featureName='example-flag' />,
        {
            permissions: [
                { permission: ADMIN },
                { permission: UPDATE_FEATURE_ENVIRONMENT },
            ],
        },
    );

test('Sync configuration is a link to the admin targets page', async () => {
    setupApi();
    renderOverview();

    const link = await screen.findByRole('link', {
        name: 'Sync configuration',
    });
    expect(link).toHaveAttribute('href', '/admin/environment-sync');
});

test('View diff opens the per-strategy diff', async () => {
    setupApi();
    renderOverview();

    fireEvent.click(await screen.findByRole('button', { name: 'View diff' }));

    expect(
        await screen.findByText('0 of 1 strategies in sync'),
    ).toBeInTheDocument();
    expect(screen.getByText('User 1')).toBeInTheDocument();
});

test('Sync opens the confirmation directly', async () => {
    setupApi();
    renderOverview();

    fireEvent.click(await screen.findByRole('button', { name: 'Sync' }));

    expect(await screen.findByText('Sync configuration?')).toBeInTheDocument();
});

test('Recheck refreshes the status after an edit', async () => {
    setupApi('drift', 'in_sync');
    renderOverview();

    expect(await screen.findByText('Out of sync')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));

    expect(await screen.findByText('In sync')).toBeInTheDocument();
});

test('Include re-enables a flag excluded from sync', async () => {
    setupApi();
    const requests = testServerRoute(
        server,
        '/api/admin/environment-sync/targets/1/feature-exclusion',
        { excluded: false, changed: true },
        'put',
    );
    server.use(
        http.get(
            '/api/admin/environment-sync/projects/default/features/example-flag/compare',
            () =>
                HttpResponse.json({
                    featureName: 'example-flag',
                    targets: [
                        {
                            targetId: 1,
                            targetName: 'Remote',
                            sourceEnvironment: 'development',
                            targetEnvironment: 'production',
                            status: 'excluded',
                            differences: [],
                        },
                    ],
                }),
        ),
    );

    renderOverview();

    expect(await screen.findByText('Excluded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Include' }));

    await waitFor(() => expect(requests.requests).toHaveLength(1));
    expect(requests.requests[0]).toEqual({
        featureName: 'example-flag',
        excluded: false,
    });
});

test('does not offer exclusion controls without admin access', async () => {
    setupApi();

    render(
        <FeatureSyncOverview projectId='default' featureName='example-flag' />,
        { permissions: [{ permission: UPDATE_FEATURE_ENVIRONMENT }] },
    );

    expect(await screen.findByText('Out of sync')).toBeInTheDocument();
    expect(
        screen.queryByRole('button', { name: 'Exclude' }),
    ).not.toBeInTheDocument();
    expect(
        screen.queryByRole('button', { name: 'Include' }),
    ).not.toBeInTheDocument();
});

test('Exclude adds an exact exclusion for the flag', async () => {
    setupApi();
    const requests = testServerRoute(
        server,
        '/api/admin/environment-sync/targets/1/feature-exclusion',
        { excluded: true, changed: true },
        'put',
    );

    renderOverview();

    fireEvent.click(await screen.findByRole('button', { name: 'Exclude' }));

    await waitFor(() => expect(requests.requests).toHaveLength(1));
    expect(requests.requests[0]).toEqual({
        featureName: 'example-flag',
        excluded: true,
    });
});

test('opens field exclusions scoped to the flag', async () => {
    setupApi();
    testServerRoute(server, '/api/admin/environment-sync/flags', {
        flags: [{ name: 'example-flag', project: 'default', tags: [] }],
    });
    testServerRoute(
        server,
        '/api/admin/environment-sync/projects/catalog',
        {
            sourceEnvironment: 'development',
            targetEnvironment: 'production',
            comparedWithTarget: true,
            entries: [
                {
                    entry: '*::/limit',
                    kind: 'variantPayload',
                    differs: true,
                    local: {
                        entry: '*::/limit',
                        kind: 'variantPayload',
                        flagCount: 1,
                        usageCount: 1,
                        samples: ['100'],
                        valuesByFlag: { 'example-flag': '100' },
                    },
                    remote: {
                        entry: '*::/limit',
                        kind: 'variantPayload',
                        flagCount: 1,
                        usageCount: 1,
                        samples: ['200'],
                        valuesByFlag: { 'example-flag': '200' },
                    },
                },
            ],
            flags: [{ name: 'example-flag', project: 'default', tags: [] }],
            truncated: false,
        },
        'post',
    );

    renderOverview();

    fireEvent.click(
        await screen.findByRole('button', { name: 'Field exclusions' }),
    );

    expect(await screen.findByText(/Editing fields for/)).toBeInTheDocument();

    fireEvent.mouseDown(await screen.findByRole('combobox'));
    expect(
        await screen.findByRole('option', { name: /limit/ }),
    ).toBeInTheDocument();
});

test('hides field exclusions when the flag has no JSON fields', async () => {
    setupApi();
    server.use(
        http.get(
            '/api/admin/environment-sync/projects/default/features/example-flag/compare',
            () =>
                HttpResponse.json({
                    featureName: 'example-flag',
                    targets: [
                        {
                            targetId: 1,
                            targetName: 'Remote',
                            sourceEnvironment: 'development',
                            targetEnvironment: 'production',
                            status: 'drift',
                            differences: [],
                            local: {
                                strategies: [
                                    {
                                        name: 'flexibleRollout',
                                        parameters: { rollout: '100' },
                                        constraints: [],
                                        segments: [],
                                        variants: [],
                                    },
                                ],
                                variants: [],
                            },
                        },
                    ],
                }),
        ),
    );

    renderOverview();

    expect(await screen.findByText('Out of sync')).toBeInTheDocument();
    expect(
        screen.queryByRole('button', { name: 'Field exclusions' }),
    ).not.toBeInTheDocument();
});
