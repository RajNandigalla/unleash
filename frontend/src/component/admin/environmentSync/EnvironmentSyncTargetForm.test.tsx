import { beforeEach, expect, test } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from 'utils/testRenderer';
import { testServerRoute, testServerSetup } from 'utils/testServer';
import { EnvironmentSyncTargetForm } from './EnvironmentSyncTargetForm';

const server = testServerSetup();

beforeEach(() => {
    localStorage.clear();
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
            {
                name: 'production',
                type: 'production',
                sortOrder: 2,
                enabled: true,
                protected: false,
            },
        ],
    });
});

test('loads the target environments into the dropdown', async () => {
    const requests = testServerRoute(
        server,
        '/api/admin/environment-sync/targets/test',
        {
            ok: true,
            environments: ['development', 'production'],
            projectExists: true,
        },
        'post',
    );

    render(
        <EnvironmentSyncTargetForm
            open
            onClose={() => undefined}
            onSaved={() => undefined}
        />,
    );

    fireEvent.change(
        screen.getByPlaceholderText('https://unleash.qa.example.com'),
        { target: { value: 'http://localhost:4243' } },
    );
    fireEvent.change(
        screen.getByPlaceholderText('Admin API token for the target instance'),
        { target: { value: 'secret-token' } },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load environments' }));

    await waitFor(() => expect(requests.requests).toHaveLength(1));

    const comboboxes = await screen.findAllByRole('combobox');
    const targetEnvironment = comboboxes[1];
    await userEvent.click(targetEnvironment);

    expect(
        await screen.findByRole('option', { name: 'production' }),
    ).toBeInTheDocument();
});

test('target environment can be cleared and edited', async () => {
    render(
        <EnvironmentSyncTargetForm
            open
            onClose={() => undefined}
            onSaved={() => undefined}
        />,
    );

    const comboboxes = await screen.findAllByRole('combobox');
    const targetEnvironment = comboboxes[1] as HTMLInputElement;

    await waitFor(() => expect(targetEnvironment).toHaveValue('development'));

    fireEvent.change(targetEnvironment, { target: { value: '' } });
    await waitFor(() => expect(targetEnvironment).toHaveValue(''));

    fireEvent.change(targetEnvironment, { target: { value: 'production' } });
    await waitFor(() => expect(targetEnvironment).toHaveValue('production'));
});

test('editing a target does not test the connection on open', async () => {
    let testCalls = 0;
    server.use(
        http.post('/api/admin/environment-sync/targets/7/test', () => {
            testCalls += 1;
            return HttpResponse.json({
                ok: true,
                environments: ['development', 'production'],
            });
        }),
    );

    render(
        <EnvironmentSyncTargetForm
            open
            target={{
                id: 7,
                name: 'QA',
                url: 'https://qa.example.com',
                project: null,
                sourceEnvironment: 'development',
                targetEnvironment: 'production',
                enabled: true,
                createdAt: new Date().toISOString(),
                createdBy: null,
                hasToken: true,
                lastTestedAt: null,
                lastTestStatus: null,
                lastTestError: null,
                lastSyncedAt: null,
                lastSyncStatus: null,
                lastSyncError: null,
            }}
            onClose={() => undefined}
            onSaved={() => undefined}
        />,
    );

    expect(await screen.findByDisplayValue('QA')).toBeInTheDocument();
    await waitFor(() =>
        expect(screen.getAllByRole('combobox')).toHaveLength(2),
    );

    // Opening the edit form must not send a request to the target instance,
    // because that would overwrite the stored connection test result.
    expect(testCalls).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Load environments' }));

    await waitFor(() => expect(testCalls).toBe(1));
});
