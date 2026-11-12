import { beforeEach, expect, test } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from 'utils/testRenderer';
import { testServerRoute, testServerSetup } from 'utils/testServer';
import { ADMIN } from 'component/providers/AccessProvider/permissions';
import { EnvironmentSyncAdmin } from './EnvironmentSyncAdmin';

const server = testServerSetup();

beforeEach(() => {
    localStorage.clear();
});

const setupApi = () => {
    testServerRoute(server, '/api/admin/ui-config', {
        flags: { environmentSync: true },
    });
    testServerRoute(server, '/api/admin/environments', {
        version: 1,
        environments: [
            {
                name: 'development',
                type: 'development',
                sortOrder: 1,
                enabled: true,
                protected: false,
            },
        ],
    });
    testServerRoute(server, '/api/admin/environment-sync/targets', {
        tokenStorageConfigured: true,
        targets: [
            {
                id: 1,
                name: 'QA',
                url: 'https://qa.example.com',
                project: null,
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
    testServerRoute(server, '/api/admin/environment-sync/flags', {
        flags: [{ name: 'my-flag', project: null, tags: [] }],
    });
    testServerRoute(
        server,
        '/api/admin/environment-sync/projects/catalog',
        {
            sourceEnvironment: 'development',
            targetEnvironment: 'production',
            comparedWithTarget: true,
            entries: [],
            flags: [{ name: 'my-flag', project: null, tags: [] }],
            truncated: false,
        },
        'post',
    );
};

test('lists connected environments and never exposes the token', async () => {
    setupApi();

    render(<EnvironmentSyncAdmin />, {
        permissions: [
            {
                permission: ADMIN,
                project: '*',
                environment: '*',
            },
        ],
    });

    expect(await screen.findByText('QA')).toBeInTheDocument();
    expect(screen.getByText('https://qa.example.com')).toBeInTheDocument();
    expect(screen.getByText('development → production')).toBeInTheDocument();
    expect(screen.queryByText(/secret/i)).not.toBeInTheDocument();
});

test('opens the configuration as a side panel', async () => {
    setupApi();

    render(<EnvironmentSyncAdmin />, {
        permissions: [
            {
                permission: ADMIN,
                project: '*',
                environment: '*',
            },
        ],
    });

    fireEvent.click(
        await screen.findByTitle('Environment-specific values and exclusions'),
    );

    expect(await screen.findByText('QA · configuration')).toBeInTheDocument();
    expect(await screen.findByText('my-flag')).toBeInTheDocument();
});
