import { beforeEach, expect, test } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from 'utils/testRenderer';
import { testServerRoute, testServerSetup } from 'utils/testServer';
import { http, HttpResponse } from 'msw';
import { ProjectSyncSummary } from './ProjectSyncSummary';

const server = testServerSetup();

beforeEach(() => {
    localStorage.clear();
});

test('shows the summary and lists out-of-sync flags', async () => {
    testServerRoute(
        server,
        '/api/admin/environment-sync/projects/default/status',
        {
            checkedAt: new Date().toISOString(),
            summary: {
                total: 5,
                inSync: 3,
                outOfSync: 2,
                missing: 1,
                errors: 0,
            },
            targets: [{ targetId: 1, targetName: 'QA' }],
            features: [
                {
                    featureName: 'flag-a',
                    status: 'out_of_sync',
                    targets: [{ targetId: 1, status: 'drift' }],
                },
                {
                    featureName: 'flag-b',
                    status: 'out_of_sync',
                    targets: [{ targetId: 1, status: 'missing_remote' }],
                },
                {
                    featureName: 'flag-c',
                    status: 'in_sync',
                    targets: [{ targetId: 1, status: 'in_sync' }],
                },
            ],
        },
    );

    render(<ProjectSyncSummary projectId='default' enabled />);

    expect(
        await screen.findByText('2 of 5 flags out of sync'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review out-of-sync' }));

    expect(
        await screen.findByText('Out-of-sync flags (2)'),
    ).toBeInTheDocument();
    expect(screen.getByText('flag-a')).toBeInTheDocument();
    expect(screen.getByText('flag-b')).toBeInTheDocument();
    expect(screen.queryByText('flag-c')).not.toBeInTheDocument();
});

test('Check now refreshes the status and shows feedback', async () => {
    const path = '/api/admin/environment-sync/projects/default/status';
    const initial = {
        checkedAt: new Date().toISOString(),
        summary: {
            total: 5,
            inSync: 3,
            outOfSync: 2,
            missing: 1,
            errors: 0,
        },
        targets: [{ targetId: 1, targetName: 'QA' }],
        features: [],
    };
    const refreshed = {
        checkedAt: new Date().toISOString(),
        summary: {
            total: 5,
            inSync: 5,
            outOfSync: 0,
            missing: 0,
            errors: 0,
        },
        targets: [{ targetId: 1, targetName: 'QA' }],
        features: [],
    };

    server.use(
        http.get(path, ({ request }) => {
            const isRefresh =
                new URL(request.url).searchParams.get('refresh') === 'true';
            return HttpResponse.json(isRefresh ? refreshed : initial);
        }),
    );

    render(<ProjectSyncSummary projectId='default' enabled />);

    expect(
        await screen.findByText('2 of 5 flags out of sync'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    expect(await screen.findByText('All 5 flags in sync')).toBeInTheDocument();
    expect(screen.getByText(/Last checked/)).toBeInTheDocument();
});

test('does not claim everything is in sync when no target was checked', async () => {
    testServerRoute(
        server,
        '/api/admin/environment-sync/projects/default/status',
        {
            checkedAt: new Date().toISOString(),
            summary: {
                total: 5,
                inSync: 0,
                outOfSync: 0,
                missing: 0,
                errors: 0,
            },
            targets: [],
            features: [],
        },
    );

    render(<ProjectSyncSummary projectId='default' enabled />);

    expect(
        await screen.findByText('No environments connected'),
    ).toBeInTheDocument();
    expect(screen.queryByText('All 5 flags in sync')).not.toBeInTheDocument();
});
