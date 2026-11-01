import { expect, test } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from 'utils/testRenderer';
import { StrategyDiffView } from './StrategyDiffView';
import type { EnvironmentSyncDiff } from 'interfaces/environmentSync';

const strategy = (name: string) => ({
    name: 'flexibleRollout',
    title: name,
    parameters: { rollout: '100', stickiness: 'default', groupId: 'flag' },
    constraints: [],
    segments: [],
    variants: [],
});

const diff = (
    overrides: Partial<EnvironmentSyncDiff>,
): EnvironmentSyncDiff => ({
    strategies: [],
    variants: [],
    orderChanged: false,
    summary: { total: 0, inSync: 0, outOfSync: 0 },
    ...overrides,
});

test('shows an order warning when strategy content matches', () => {
    const first = strategy('First');
    const second = strategy('Second');

    render(
        <StrategyDiffView
            diff={diff({
                strategies: [
                    {
                        key: 'first',
                        label: 'First',
                        status: 'in_sync',
                        changes: [],
                        local: first,
                        remote: first,
                    },
                    {
                        key: 'second',
                        label: 'Second',
                        status: 'in_sync',
                        changes: [],
                        local: second,
                        remote: second,
                    },
                ],
                orderChanged: true,
                summary: { total: 2, inSync: 2, outOfSync: 0 },
            })}
            local={{ strategies: [first, second], variants: [] }}
            remote={{ strategies: [second, first], variants: [] }}
            leftLabel='source'
            rightLabel='target'
        />,
    );

    expect(
        screen.getByText('2 of 2 strategies match — order differs'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Strategy order differs/)).toBeInTheDocument();
});

test('marks a strategy that only exists on the source', () => {
    const only = strategy('Only source');

    render(
        <StrategyDiffView
            diff={diff({
                strategies: [
                    {
                        key: 'only',
                        label: 'Only source',
                        status: 'only_source',
                        changes: [],
                        local: only,
                    },
                ],
                summary: { total: 1, inSync: 0, outOfSync: 1 },
            })}
            local={{ strategies: [only], variants: [] }}
            remote={{ strategies: [], variants: [] }}
            leftLabel='source'
            rightLabel='target'
        />,
    );

    expect(screen.getByText('Only on source')).toBeInTheDocument();
    expect(screen.getByText('Only source')).toBeInTheDocument();
});

test('renders json payload strings as nested json', () => {
    const base = strategy('User 1');
    const local = {
        ...base,
        variants: [
            {
                name: 'user-1',
                weight: 1000,
                weightType: 'variable',
                stickiness: 'default',
                payload: {
                    type: 'json',
                    value: '{\n  "enabled": true\n}',
                },
            },
        ],
    };
    const remote = {
        ...local,
        variants: [
            {
                ...local.variants[0],
                payload: {
                    type: 'json',
                    value: '{\n  "enabled": false\n}',
                },
            },
        ],
    };

    const { container } = render(
        <StrategyDiffView
            diff={diff({
                strategies: [
                    {
                        key: 'user-1',
                        label: 'User 1',
                        status: 'modified',
                        changes: ['variants'],
                        local,
                        remote,
                    },
                ],
                summary: { total: 1, inSync: 0, outOfSync: 1 },
            })}
            local={{ strategies: [local], variants: [] }}
            remote={{ strategies: [remote], variants: [] }}
            leftLabel='source'
            rightLabel='target'
        />,
    );

    const text = container.textContent ?? '';
    expect(text).toContain('"enabled": true');
    expect(text).toContain('"enabled": false');
    expect(text).not.toContain('\\"enabled\\"');
});
