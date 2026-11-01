import { beforeEach, expect, test } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from 'utils/testRenderer';
import { testServerRoute, testServerSetup } from 'utils/testServer';
import { OutOfSyncFlagsDialog } from './OutOfSyncFlagsDialog';

const server = testServerSetup();

beforeEach(() => {
    localStorage.clear();
});

test('does not force-sync targets where the flag is already in sync', async () => {
    testServerRoute(server, '/api/admin/ui-config', {
        flags: { environmentSync: true },
    });
    const syncRequests = testServerRoute(
        server,
        '/api/admin/environment-sync/projects/default/sync',
        {
            results: [
                { targetId: 1, targetName: 'QA', features: [] },
                { targetId: 2, targetName: 'EU', features: [] },
            ],
        },
        'post',
    );

    render(
        <OutOfSyncFlagsDialog
            open
            onClose={() => undefined}
            projectId='default'
            onRefresh={() => undefined}
            status={{
                checkedAt: new Date().toISOString(),
                summary: {
                    total: 2,
                    inSync: 0,
                    outOfSync: 2,
                    missing: 0,
                    errors: 0,
                },
                targets: [
                    { targetId: 1, targetName: 'QA' },
                    { targetId: 2, targetName: 'EU' },
                ],
                features: [
                    {
                        featureName: 'flag-a',
                        status: 'out_of_sync',
                        targets: [
                            { targetId: 1, status: 'drift' },
                            { targetId: 2, status: 'in_sync' },
                        ],
                    },
                    {
                        featureName: 'flag-b',
                        status: 'out_of_sync',
                        targets: [
                            { targetId: 1, status: 'in_sync' },
                            { targetId: 2, status: 'drift' },
                        ],
                    },
                ],
            }}
        />,
    );

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);

    fireEvent.click(screen.getByRole('button', { name: 'Sync selected (2)' }));

    await waitFor(() => expect(syncRequests.requests).toHaveLength(1));
    // Let the server re-check each flag per target instead of rewriting both
    // flags on both targets.
    expect(syncRequests.requests[0]).toEqual({
        featureNames: ['flag-a', 'flag-b'],
        onlyOutOfSync: true,
    });
});
