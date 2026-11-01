import { beforeEach, expect, test } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
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
