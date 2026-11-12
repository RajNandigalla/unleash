import { expect, test } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { useSWRConfig } from 'swr';
import { http, HttpResponse } from 'msw';
import { render } from 'utils/testRenderer';
import { testServerRoute, testServerSetup } from 'utils/testServer';
import { EnvironmentSyncTargetConfigPage } from './EnvironmentSyncTargetConfigPage';

const server = testServerSetup();

const target = {
    id: 7,
    name: 'QA',
    url: 'https://qa.example.com',
    project: 'default',
    sourceEnvironment: 'development',
    targetEnvironment: 'production',
    enabled: true,
    ignoredConfig: {
        parameters: ['loginUrl'],
        variantPayloads: [],
        ignoredFeatures: ['legacy-*'],
    },
    createdAt: new Date().toISOString(),
    createdBy: null,
    hasToken: true,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestError: null,
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
};

const flags = [
    { name: 'login-url-flag', project: 'default', tags: [] },
    { name: 'legacy-checkout', project: 'default', tags: ['legacy'] },
    { name: 'plain-flag', project: 'default', tags: [] },
];

const catalog = {
    sourceEnvironment: 'development',
    targetEnvironment: 'production',
    comparedWithTarget: true,
    entries: [
        {
            entry: 'loginUrl',
            kind: 'parameter',
            differs: true,
            local: {
                entry: 'loginUrl',
                kind: 'parameter',
                flagCount: 1,
                usageCount: 1,
                samples: ['https://ab-test.com'],
                valuesByFlag: { 'login-url-flag': 'https://ab-test.com' },
            },
            remote: {
                entry: 'loginUrl',
                kind: 'parameter',
                flagCount: 1,
                usageCount: 1,
                samples: ['https://test.com'],
                valuesByFlag: { 'login-url-flag': 'https://test.com' },
            },
        },
        {
            entry: '*::/redirectUrl',
            kind: 'variantPayload',
            differs: true,
            local: {
                entry: '*::/redirectUrl',
                kind: 'variantPayload',
                flagCount: 1,
                usageCount: 1,
                samples: ['https://ab-test.com'],
                valuesByFlag: { 'login-url-flag': 'https://ab-test.com' },
            },
            remote: {
                entry: '*::/redirectUrl',
                kind: 'variantPayload',
                flagCount: 1,
                usageCount: 1,
                samples: ['https://test.com'],
                valuesByFlag: { 'login-url-flag': 'https://test.com' },
            },
        },
    ],
    flags,
    truncated: false,
};

const setup = () => {
    testServerRoute(server, '/api/admin/environment-sync/targets', {
        tokenStorageConfigured: true,
        targets: [target],
    });
    testServerRoute(server, '/api/admin/environment-sync/flags', { flags });
    testServerRoute(
        server,
        '/api/admin/environment-sync/projects/catalog',
        catalog,
        'post',
    );
    return testServerRoute(
        server,
        '/api/admin/environment-sync/targets/7/ignored-config',
        { tokenStorageConfigured: true, targets: [target] },
        'put',
    );
};

const renderPage = () =>
    render(
        <Routes>
            <Route
                path='/admin/environment-sync/:targetId'
                element={<EnvironmentSyncTargetConfigPage />}
            />
        </Routes>,
        { route: '/admin/environment-sync/7' },
    );

test('shows entire and partial exclusions and toggles a flag', async () => {
    const updates = setup();
    renderPage();

    expect(await screen.findByText('QA · configuration')).toBeInTheDocument();

    // Whole flag excluded by the legacy-* rule: summary chip + table row.
    expect(
        (await screen.findAllByText('legacy-checkout')).length,
    ).toBeGreaterThan(1);

    const partialRow = (await screen.findByText('login-url-flag')).closest(
        'tr',
    );
    expect(within(partialRow!).getByText('Partial')).toBeInTheDocument();
    expect(within(partialRow!).getByText('1 field')).toBeInTheDocument();

    const plainRow = screen.getByText('plain-flag').closest('tr');
    await userEvent.click(
        within(plainRow!).getByRole('button', { name: 'Exclude' }),
    );

    await waitFor(() => expect(updates.requests).toHaveLength(1));
    expect(updates.requests[0]).toEqual({
        ignoredConfig: {
            parameters: ['loginUrl'],
            variantPayloads: [],
            ignoredFeatures: ['legacy-*', 'plain-flag'],
            featureFields: [],
        },
    });
});

test('edits the configuration at the target level', async () => {
    const updates = setup();
    renderPage();

    await screen.findByText('QA · configuration');
    await userEvent.click(
        screen.getByRole('button', { name: 'Edit configuration' }),
    );

    expect(
        await screen.findByText('Fields that may differ per environment'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updates.requests).toHaveLength(1));
    expect(updates.requests[0]).toEqual({
        ignoredConfig: {
            parameters: ['loginUrl'],
            variantPayloads: [],
            ignoredFeatures: ['legacy-*'],
            featureFields: [],
        },
    });
});

test('offers import and export', async () => {
    setup();
    renderPage();

    await screen.findByText('QA · configuration');

    expect(screen.getByRole('button', { name: /Export/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import/ })).toBeInTheDocument();
});

test('saves field exclusions scoped to the flag', async () => {
    const scopedTarget = {
        ...target,
        ignoredConfig: {
            parameters: [],
            variantPayloads: [],
            ignoredFeatures: [],
            featureFields: [
                {
                    feature: 'login-url-flag',
                    parameters: ['loginUrl'],
                    variantPayloads: [],
                },
                {
                    feature: 'plain-flag',
                    parameters: [],
                    variantPayloads: ['*'],
                },
            ],
        },
    };
    testServerRoute(server, '/api/admin/environment-sync/targets', {
        tokenStorageConfigured: true,
        targets: [scopedTarget],
    });
    testServerRoute(server, '/api/admin/environment-sync/flags', { flags });
    testServerRoute(
        server,
        '/api/admin/environment-sync/projects/catalog',
        catalog,
        'post',
    );
    const updates = testServerRoute(
        server,
        '/api/admin/environment-sync/targets/7/ignored-config',
        { tokenStorageConfigured: true, targets: [scopedTarget] },
        'put',
    );

    render(
        <EnvironmentSyncTargetConfigPage
            targetId={7}
            featureFilter='login-url-flag'
            autoEdit
        />,
    );

    await screen.findByText('Fields that may differ per environment');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updates.requests).toHaveLength(1));
    expect(updates.requests[0]).toEqual({
        ignoredConfig: {
            parameters: [],
            variantPayloads: [],
            ignoredFeatures: [],
            featureFields: [
                {
                    feature: 'login-url-flag',
                    parameters: ['loginUrl'],
                    variantPayloads: [],
                },
                {
                    feature: 'plain-flag',
                    parameters: [],
                    variantPayloads: ['*'],
                },
            ],
        },
    });
});

test('offers field exclusions per flag', async () => {
    setup();
    renderPage();

    await screen.findByText('QA · configuration');

    const row = (await screen.findByText('login-url-flag')).closest('tr');
    await userEvent.click(within(row!).getByRole('button', { name: 'Fields' }));

    expect(
        await screen.findByText('Fields that may differ per environment'),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Flag' })).toHaveValue(
        'login-url-flag',
    );
});

const Revalidate = () => {
    const { mutate } = useSWRConfig();
    return (
        <button
            type='button'
            onClick={() => mutate('/api/admin/environment-sync/targets')}
        >
            Revalidate targets
        </button>
    );
};

test('keeps unsaved edits when the targets revalidate', async () => {
    setup();
    let targetReads = 0;
    server.use(
        http.get('/api/admin/environment-sync/targets', () => {
            targetReads += 1;
            return HttpResponse.json({
                tokenStorageConfigured: true,
                // Revalidation returns a new object with fresh metadata but
                // the same configuration.
                targets: [
                    {
                        ...target,
                        lastSyncedAt: new Date().toISOString(),
                    },
                ],
            });
        }),
    );

    render(
        <>
            <Revalidate />
            <Routes>
                <Route
                    path='/admin/environment-sync/:targetId'
                    element={<EnvironmentSyncTargetConfigPage />}
                />
            </Routes>
        </>,
        { route: '/admin/environment-sync/7' },
    );

    await screen.findByText('QA · configuration');
    await userEvent.click(
        screen.getByRole('button', { name: 'Edit configuration' }),
    );
    await userEvent.click(screen.getByRole('tab', { name: /Excluded flags/ }));

    const rules = screen.getByRole('combobox', {
        name: 'Excluded flags and rules',
    });
    await userEvent.type(rules, 'plain-flag');
    await userEvent.keyboard('{Enter}');

    expect(
        await screen.findByText('2 of 3 flags match these rules'),
    ).toBeInTheDocument();

    await userEvent.click(
        screen.getByRole('button', { name: 'Revalidate targets' }),
    );
    await waitFor(() => expect(targetReads).toBeGreaterThan(1));
    await waitFor(() =>
        expect(
            screen.getByText('2 of 3 flags match these rules'),
        ).toBeInTheDocument(),
    );
});

test('resets to the first page when the filter shrinks the list', async () => {
    const manyFlags = Array.from({ length: 60 }, (_, index) => ({
        name: `flag-${index}`,
        project: 'default',
        tags: [],
    }));
    testServerRoute(server, '/api/admin/environment-sync/targets', {
        tokenStorageConfigured: true,
        targets: [target],
    });
    testServerRoute(server, '/api/admin/environment-sync/flags', {
        flags: manyFlags,
    });
    testServerRoute(
        server,
        '/api/admin/environment-sync/projects/catalog',
        catalog,
        'post',
    );

    renderPage();

    await screen.findByText('QA · configuration');
    await userEvent.click(
        screen.getByRole('button', { name: 'Go to next page' }),
    );
    await screen.findByText('flag-25');

    await userEvent.type(
        screen.getByRole('textbox', { name: 'Search flags' }),
        'flag-3',
    );

    expect(await screen.findByText('flag-3')).toBeInTheDocument();
    expect(
        screen.queryByText('No flags match the current filter.'),
    ).not.toBeInTheDocument();
});
