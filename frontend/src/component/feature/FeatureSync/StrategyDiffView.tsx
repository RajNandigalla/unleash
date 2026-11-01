import { useMemo, useState } from 'react';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Alert,
    Box,
    Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Badge } from 'component/common/Badge/Badge';
import { JsonDiffViewer } from 'component/common/JsonDiffViewer/JsonDiffViewer';
import {
    expandDiffItemPayloads,
    expandJsonPayloads,
} from './expandJsonPayloads';
import type {
    EnvironmentSyncConfig,
    EnvironmentSyncDiff,
    EnvironmentSyncDiffStatus,
    EnvironmentSyncStrategyDiff,
    EnvironmentSyncVariantDiff,
} from 'interfaces/environmentSync';

type StrategyDiffViewProps = {
    diff: EnvironmentSyncDiff;
    local?: EnvironmentSyncConfig;
    remote?: EnvironmentSyncConfig;
    leftLabel: string;
    rightLabel: string;
};

const statusMeta: Record<
    EnvironmentSyncDiffStatus,
    { color: 'success' | 'warning' | 'neutral'; label: string }
> = {
    in_sync: { color: 'success', label: 'In sync' },
    modified: { color: 'warning', label: 'Out of sync' },
    only_source: { color: 'warning', label: 'Only on source' },
    only_target: { color: 'warning', label: 'Only on target' },
};

const changeLabels: Record<string, string> = {
    variants: 'variants / payload',
    name: 'strategy type',
    parameters: 'parameters',
    constraints: 'constraints',
    segments: 'segments',
    title: 'title',
    disabled: 'disabled',
    payload: 'payload',
    weight: 'weight',
    weightType: 'weight type',
    stickiness: 'stickiness',
    overrides: 'overrides',
};

const formatChanges = (changes: string[]): string =>
    changes.map((change) => changeLabels[change] ?? change).join(', ');

type DiffItem = EnvironmentSyncStrategyDiff | EnvironmentSyncVariantDiff;

const DiffAccordion = ({
    item,
    leftLabel,
    rightLabel,
}: {
    item: DiffItem;
    leftLabel: string;
    rightLabel: string;
}) => {
    const meta = statusMeta[item.status];
    const left = useMemo(
        () => expandDiffItemPayloads(item.local),
        [item.local],
    );
    const right = useMemo(
        () => expandDiffItemPayloads(item.remote),
        [item.remote],
    );

    return (
        <Accordion disableGutters defaultExpanded={item.status !== 'in_sync'}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        flexWrap: 'wrap',
                        width: '100%',
                    }}
                >
                    <Badge color={meta.color} sx={{ whiteSpace: 'nowrap' }}>
                        {meta.label}
                    </Badge>
                    <Typography sx={{ fontWeight: 600 }}>
                        {item.label}
                    </Typography>
                    {item.changes.length > 0 && (
                        <Typography variant='caption' color='text.secondary'>
                            {formatChanges(item.changes)}
                        </Typography>
                    )}
                </Box>
            </AccordionSummary>
            <AccordionDetails>
                <JsonDiffViewer
                    left={left}
                    right={right}
                    leftLabel={leftLabel}
                    rightLabel={rightLabel}
                    height='30vh'
                    defaultView='full'
                    showViewToggle={false}
                />
            </AccordionDetails>
        </Accordion>
    );
};

export const StrategyDiffView = ({
    diff,
    local,
    remote,
    leftLabel,
    rightLabel,
}: StrategyDiffViewProps) => {
    const [fullConfigOpen, setFullConfigOpen] = useState(false);
    const expandedLocal = useMemo(() => expandJsonPayloads(local), [local]);
    const expandedRemote = useMemo(() => expandJsonPayloads(remote), [remote]);

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    flexWrap: 'wrap',
                }}
            >
                <Typography variant='subtitle2'>
                    {diff.summary.total === 0
                        ? 'No strategies configured'
                        : diff.orderChanged
                          ? `${diff.summary.inSync} of ${diff.summary.total} strategies match — order differs`
                          : `${diff.summary.inSync} of ${diff.summary.total} strategies in sync`}
                </Typography>
                {diff.summary.outOfSync > 0 && (
                    <Badge color='warning' sx={{ whiteSpace: 'nowrap' }}>
                        {diff.summary.outOfSync} out of sync
                    </Badge>
                )}
            </Box>

            {diff.orderChanged && (
                <Alert severity='warning'>
                    Strategy order differs. Unleash uses the first matching
                    strategy that has variants, so order changes which payload a
                    user receives.
                </Alert>
            )}

            {diff.strategies.map((item) => (
                <DiffAccordion
                    key={item.key}
                    item={item}
                    leftLabel={leftLabel}
                    rightLabel={rightLabel}
                />
            ))}

            {diff.variants.length > 0 && (
                <>
                    <Typography variant='subtitle2' sx={{ mt: 1 }}>
                        Environment variants
                    </Typography>
                    {diff.variants.map((item) => (
                        <DiffAccordion
                            key={item.key}
                            item={item}
                            leftLabel={leftLabel}
                            rightLabel={rightLabel}
                        />
                    ))}
                </>
            )}

            <Accordion
                disableGutters
                expanded={fullConfigOpen}
                onChange={(_event, expanded) => setFullConfigOpen(expanded)}
            >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography variant='subtitle2'>Full config</Typography>
                </AccordionSummary>
                <AccordionDetails>
                    <JsonDiffViewer
                        left={expandedLocal}
                        right={expandedRemote}
                        leftLabel={leftLabel}
                        rightLabel={rightLabel}
                        height='40vh'
                    />
                </AccordionDetails>
            </Accordion>
        </Box>
    );
};
