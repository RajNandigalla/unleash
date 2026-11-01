import { expect, test } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from 'utils/testRenderer';
import { JsonDiffViewer } from './JsonDiffViewer';

test('renders labels, sorts object keys and is read-only', () => {
    const { container } = render(
        <JsonDiffViewer
            left={{ z: 1, a: 2 }}
            right={{ z: 3, a: 2 }}
            leftLabel='This instance · development'
            rightLabel='QA · production'
        />,
    );

    expect(screen.getByText('This instance · development')).toBeInTheDocument();
    expect(screen.getByText('QA · production')).toBeInTheDocument();

    const text = container.textContent ?? '';
    expect(text).toContain('"a": 2');
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"z"'));

    expect(
        container.querySelectorAll('[contenteditable="false"]').length,
    ).toBeGreaterThan(0);
});

test('renders the full config when requested', async () => {
    const { container } = render(
        <JsonDiffViewer
            left={{ strategies: [], variants: [] }}
            right={{ strategies: [], variants: [] }}
            leftLabel='left'
            rightLabel='right'
            defaultView='full'
        />,
    );

    const text = container.textContent ?? '';
    expect(text).toContain('"strategies"');
    expect(text).toContain('"variants"');
});
