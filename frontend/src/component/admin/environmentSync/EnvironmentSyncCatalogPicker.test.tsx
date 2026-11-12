import { expect, test, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from 'utils/testRenderer';
import { EnvironmentSyncCatalogPicker } from './EnvironmentSyncCatalogPicker';
import type {
    EnvironmentSyncCatalogEntryView,
    EnvironmentSyncCatalogView,
} from 'interfaces/environmentSync';

const field = (
    entry: string,
    kind: 'parameter' | 'variantPayload',
    differs: boolean,
    localSample: string,
    remoteSample: string,
): EnvironmentSyncCatalogEntryView => ({
    entry,
    kind,
    differs,
    local: {
        entry,
        kind,
        flagCount: 1,
        usageCount: 1,
        samples: [localSample],
        valuesByFlag: { 'flag-a': localSample },
    },
    remote: {
        entry,
        kind,
        flagCount: 1,
        usageCount: 1,
        samples: [remoteSample],
        valuesByFlag: { 'flag-a': remoteSample },
    },
});

const catalog: EnvironmentSyncCatalogView = {
    sourceEnvironment: 'development',
    targetEnvironment: 'production',
    comparedWithTarget: true,
    entries: [
        field('loginUrl', 'parameter', true, 'ab-test.com', 'test.com'),
        field('rollout', 'parameter', false, '50', '50'),
        field(
            '*::/redirectUrl',
            'variantPayload',
            true,
            'ab-test.com',
            'test.com',
        ),
    ],
    flags: [{ name: 'flag-a', project: 'default', tags: [] }],
    truncated: false,
};

const renderPicker = (
    props: Partial<Parameters<typeof EnvironmentSyncCatalogPicker>[0]> = {},
) => {
    const onChange = vi.fn();
    const onFeatureFieldsChange = vi.fn();
    render(
        <EnvironmentSyncCatalogPicker
            catalog={catalog}
            loading={false}
            parameters={[]}
            variantPayloads={[]}
            featureFields={[]}
            onFeatureFieldsChange={onFeatureFieldsChange}
            onChange={onChange}
            {...props}
        />,
    );
    return { onChange, onFeatureFieldsChange };
};

const openPaths = async () => {
    await userEvent.click(screen.getByRole('combobox', { name: /Paths in/ }));
};

const openList = async () => {
    await userEvent.click(screen.getByRole('combobox'));
};

test('selects a whole field for the active flag', async () => {
    const { onFeatureFieldsChange } = renderPicker();
    await openPaths();

    await userEvent.click(
        await screen.findByRole('option', { name: /loginUrl/ }),
    );

    expect(onFeatureFieldsChange).toHaveBeenCalledWith([
        {
            feature: 'flag-a',
            parameters: ['loginUrl'],
            variantPayloads: [],
        },
    ]);
});

test('selects a JSON field for the active flag', async () => {
    const { onFeatureFieldsChange } = renderPicker();
    await openPaths();

    await userEvent.click(
        await screen.findByRole('option', { name: /redirectUrl/ }),
    );

    expect(onFeatureFieldsChange).toHaveBeenCalledWith([
        {
            feature: 'flag-a',
            parameters: [],
            variantPayloads: ['*::/redirectUrl'],
        },
    ]);
});

test('shows array paths without indices', async () => {
    renderPicker({
        catalog: {
            ...catalog,
            entries: [
                ...catalog.entries,
                field('*::/items/*/url', 'variantPayload', true, 'a', 'b'),
            ],
        },
    });
    await openPaths();

    expect(await screen.findByText('items[].url')).toBeInTheDocument();
});

test('can hide unchanged fields', async () => {
    renderPicker({
        catalog: {
            ...catalog,
            entries: [
                ...catalog.entries,
                field('*::/sameField', 'variantPayload', false, 'x', 'x'),
            ],
        },
    });
    await openPaths();

    expect(await screen.findByText('sameField')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByLabelText('Only fields that differ'));
    await openPaths();

    await waitFor(() =>
        expect(screen.queryByText('sameField')).not.toBeInTheDocument(),
    );
});

test('shows selected values that are not in the catalog', () => {
    renderPicker({
        featureFields: [
            {
                feature: 'custom',
                parameters: ['custom::/path'],
                variantPayloads: [],
            },
        ],
    });

    expect(screen.getAllByText('custom::/path').length).toBeGreaterThan(0);
});

test('shows configured exclusions per flag', async () => {
    renderPicker({
        featureFields: [
            {
                feature: 'flag-a',
                parameters: ['loginUrl'],
                variantPayloads: [],
            },
            {
                feature: 'flag-b',
                parameters: [],
                variantPayloads: ['*::/redirectUrl'],
            },
        ],
    });

    expect(
        await screen.findByText('Configured exclusions'),
    ).toBeInTheDocument();
    expect(
        screen.getAllByRole('button', { name: 'flag-a' }).length,
    ).toBeGreaterThan(0);
    expect(
        screen.getAllByRole('button', { name: 'flag-b' }).length,
    ).toBeGreaterThan(0);
});

test('scopes fields to one flag and can clear the scope', async () => {
    const onClear = vi.fn();
    const scoped = field('*::/limit', 'variantPayload', true, '100', '200');
    scoped.local = { ...scoped.local!, valuesByFlag: { 'flag-a': '100' } };
    scoped.remote = { ...scoped.remote!, valuesByFlag: { 'flag-a': '200' } };
    const other = field('*::/other', 'variantPayload', true, 'a', 'b');
    other.local = { ...other.local!, valuesByFlag: { 'flag-b': 'a' } };
    other.remote = { ...other.remote!, valuesByFlag: { 'flag-b': 'b' } };

    renderPicker({
        catalog: { ...catalog, entries: [scoped, other] },
        featureFilter: 'flag-a',
        onClearFeatureFilter: onClear,
    });

    expect(screen.getByText(/Editing fields for/)).toBeInTheDocument();
    await openList();

    expect(
        await screen.findByRole('option', { name: /limit/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText('other')).not.toBeInTheDocument();

    await userEvent.click(
        screen.getByRole('button', { name: 'Show all fields' }),
    );
    expect(onClear).toHaveBeenCalled();
});

test('asks upfront and can exclude all variant payloads', async () => {
    const scoped = field('*::/limit', 'variantPayload', true, '100', '200');
    const { onChange } = renderPicker({
        catalog: { ...catalog, entries: [scoped] },
        featureFilter: 'flag-a',
    });

    await userEvent.click(
        screen.getByRole('radio', { name: 'All variant payloads' }),
    );

    expect(onChange).toHaveBeenCalledWith([], ['*']);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

test('switches back from the whole payload to fields', async () => {
    const scoped = field('*::/limit', 'variantPayload', true, '100', '200');
    const { onChange } = renderPicker({
        catalog: { ...catalog, entries: [scoped] },
        featureFilter: 'flag-a',
        variantPayloads: ['*'],
    });

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    await userEvent.click(
        screen.getByRole('radio', { name: 'Individual fields' }),
    );

    expect(onChange).toHaveBeenCalledWith([], []);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
});

test('whole payload and individual fields are mutually exclusive', async () => {
    renderPicker({
        featureFields: [
            {
                feature: 'flag-a',
                parameters: [],
                variantPayloads: ['*'],
            },
        ],
    });
    await openPaths();

    const option = await screen.findByRole('option', {
        name: /redirectUrl/,
    });
    expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/A parent value is excluded/)).toBeInTheDocument();
});
