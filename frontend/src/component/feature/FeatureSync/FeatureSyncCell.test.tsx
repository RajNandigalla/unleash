import { expect, test, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from 'utils/testRenderer';
import { FeatureSyncCell } from './FeatureSyncCell';

test('shows a dash when no environments are connected', () => {
    render(<FeatureSyncCell hasTargets={false} onOpen={() => undefined} />);
    expect(screen.getByText('—')).toBeInTheDocument();
});

test.each([
    ['in_sync', 'In sync'],
    ['out_of_sync', 'Out of sync'],
    ['no_config', 'No config'],
    ['error', 'Check failed'],
] as const)('renders %s as %s', (status, label) => {
    render(
        <FeatureSyncCell hasTargets status={status} onOpen={() => undefined} />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
});

test('opens the sync dialog when clicked', () => {
    const onOpen = vi.fn();
    render(<FeatureSyncCell hasTargets status='out_of_sync' onOpen={onOpen} />);

    fireEvent.click(screen.getByText('Out of sync'));
    expect(onOpen).toHaveBeenCalledTimes(1);
});

test('is reachable and activatable with the keyboard', async () => {
    const onOpen = vi.fn();
    render(<FeatureSyncCell hasTargets status='out_of_sync' onOpen={onOpen} />);

    const button = screen.getByRole('button', {
        name: 'Environment sync: Out of sync',
    });
    button.focus();
    expect(button).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);

    await userEvent.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(2);
});
