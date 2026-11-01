import { useMemo, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    LinearProgress,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    Typography,
} from '@mui/material';
import { Badge } from 'component/common/Badge/Badge';
import { useEnvironmentSyncApi } from 'hooks/api/actions/useEnvironmentSyncApi/useEnvironmentSyncApi';
import useToast from 'hooks/useToast';
import { formatUnknownError } from 'utils/formatUnknownError';
import { FeatureSyncDialog } from './FeatureSyncDialog';
import type {
    EnvironmentSyncProjectStatus,
    EnvironmentSyncTargetStatus,
} from 'interfaces/environmentSync';

type OutOfSyncFlagsDialogProps = {
    open: boolean;
    onClose: () => void;
    projectId: string;
    status?: EnvironmentSyncProjectStatus;
    onRefresh: () => Promise<void> | void;
};

const targetStatusLabel: Record<EnvironmentSyncTargetStatus, string> = {
    in_sync: 'In sync',
    drift: 'Drift',
    missing_remote: 'Missing',
    no_local_config: 'No config',
    env_not_available: 'Env unavailable',
    archived: 'Archived',
    error: 'Error',
};

export const OutOfSyncFlagsDialog = ({
    open,
    onClose,
    projectId,
    status,
    onRefresh,
}: OutOfSyncFlagsDialogProps) => {
    const { sync } = useEnvironmentSyncApi();
    const { setToastData, setToastApiError } = useToast();
    const [selected, setSelected] = useState<string[]>([]);
    const [syncing, setSyncing] = useState(false);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [diffFeature, setDiffFeature] = useState<string | null>(null);

    const targetNames = useMemo(
        () =>
            new Map(
                (status?.targets ?? []).map((target) => [
                    target.targetId,
                    target.targetName,
                ]),
            ),
        [status],
    );

    const outOfSync = (status?.features ?? []).filter(
        (feature) => feature.status === 'out_of_sync',
    );

    const toggle = (featureName: string) => {
        setSelected((current) =>
            current.includes(featureName)
                ? current.filter((name) => name !== featureName)
                : [...current, featureName],
        );
    };

    const toggleAll = () => {
        setSelected(
            selected.length === outOfSync.length
                ? []
                : outOfSync.map((feature) => feature.featureName),
        );
    };

    const runSync = async () => {
        if (selected.length === 0) {
            return;
        }
        setSyncing(true);
        setProgress({ done: 0, total: selected.length });
        let failed = 0;
        try {
            // Let the server re-check each flag per target and skip the ones
            // that are already in sync. Narrowing targetIds to the union of
            // out-of-sync targets would rewrite flags on targets where they
            // are already in sync.
            for (let index = 0; index < selected.length; index += 25) {
                const chunk = selected.slice(index, index + 25);
                const response = await sync({
                    projectId,
                    featureNames: chunk,
                    onlyOutOfSync: true,
                });
                failed += response.results.flatMap((result) =>
                    result.features.filter(
                        (feature) => feature.status === 'error',
                    ),
                ).length;
                setProgress({
                    done: Math.min(index + 25, selected.length),
                    total: selected.length,
                });
            }

            if (failed > 0) {
                setToastApiError(
                    `${failed} flag${failed === 1 ? '' : 's'} could not be synced`,
                );
            } else {
                setToastData({
                    type: 'success',
                    text: `Synced ${selected.length} flag${
                        selected.length === 1 ? '' : 's'
                    }`,
                });
            }
            setSelected([]);
            await onRefresh();
        } catch (error) {
            setToastApiError(formatUnknownError(error));
        } finally {
            setSyncing(false);
        }
    };

    return (
        <>
            <Dialog open={open} onClose={onClose} maxWidth='lg' fullWidth>
                <DialogTitle>
                    Out-of-sync flags ({outOfSync.length})
                </DialogTitle>
                <DialogContent dividers>
                    {outOfSync.length === 0 ? (
                        (status?.targets ?? []).some(
                            (target) => target.error,
                        ) ? (
                            <Alert severity='error'>
                                Some targets could not be checked:
                                <ul>
                                    {(status?.targets ?? [])
                                        .filter((target) => target.error)
                                        .map((target) => (
                                            <li key={target.targetId}>
                                                <strong>
                                                    {target.targetName}
                                                </strong>
                                                : {target.error}
                                            </li>
                                        ))}
                                </ul>
                            </Alert>
                        ) : (
                            <Alert severity='success'>
                                Every flag in this project is in sync with the
                                configured environments.
                            </Alert>
                        )
                    ) : (
                        <>
                            <Typography
                                variant='body2'
                                color='text.secondary'
                                sx={{ mb: 2 }}
                            >
                                Only strategies and variants are synced. Enabled
                                state and metadata on the targets are never
                                changed.
                            </Typography>
                            <Box sx={{ maxHeight: 480, overflow: 'auto' }}>
                                <Table size='small' stickyHeader>
                                    <TableHead>
                                        <TableRow>
                                            <TableCell padding='checkbox'>
                                                <Checkbox
                                                    checked={
                                                        selected.length ===
                                                            outOfSync.length &&
                                                        outOfSync.length > 0
                                                    }
                                                    indeterminate={
                                                        selected.length > 0 &&
                                                        selected.length <
                                                            outOfSync.length
                                                    }
                                                    onChange={toggleAll}
                                                />
                                            </TableCell>
                                            <TableCell>Flag</TableCell>
                                            {(status?.targets ?? []).map(
                                                (target) => (
                                                    <TableCell
                                                        key={target.targetId}
                                                    >
                                                        {target.targetName}
                                                    </TableCell>
                                                ),
                                            )}
                                            <TableCell />
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {outOfSync.map((feature) => (
                                            <TableRow
                                                key={feature.featureName}
                                                hover
                                            >
                                                <TableCell padding='checkbox'>
                                                    <Checkbox
                                                        checked={selected.includes(
                                                            feature.featureName,
                                                        )}
                                                        onChange={() =>
                                                            toggle(
                                                                feature.featureName,
                                                            )
                                                        }
                                                    />
                                                </TableCell>
                                                <TableCell>
                                                    {feature.featureName}
                                                </TableCell>
                                                {feature.targets.map(
                                                    (target) => (
                                                        <TableCell
                                                            key={
                                                                target.targetId
                                                            }
                                                        >
                                                            <Badge
                                                                color={
                                                                    target.status ===
                                                                    'in_sync'
                                                                        ? 'success'
                                                                        : target.status ===
                                                                            'error'
                                                                          ? 'error'
                                                                          : 'warning'
                                                                }
                                                                title={
                                                                    targetNames.get(
                                                                        target.targetId,
                                                                    ) ??
                                                                    'Target'
                                                                }
                                                            >
                                                                {
                                                                    targetStatusLabel[
                                                                        target
                                                                            .status
                                                                    ]
                                                                }
                                                            </Badge>
                                                        </TableCell>
                                                    ),
                                                )}
                                                <TableCell>
                                                    <Button
                                                        size='small'
                                                        onClick={() =>
                                                            setDiffFeature(
                                                                feature.featureName,
                                                            )
                                                        }
                                                    >
                                                        View diff
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </Box>
                        </>
                    )}
                    {syncing && (
                        <Box sx={{ mt: 2 }}>
                            <LinearProgress
                                variant='determinate'
                                value={
                                    progress.total
                                        ? (progress.done / progress.total) * 100
                                        : 0
                                }
                            />
                            <Typography variant='body2' sx={{ mt: 1 }}>
                                Syncing {progress.done} of {progress.total}…
                            </Typography>
                        </Box>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={onClose} disabled={syncing}>
                        Close
                    </Button>
                    <Button
                        variant='contained'
                        disabled={selected.length === 0 || syncing}
                        onClick={runSync}
                    >
                        Sync selected ({selected.length})
                    </Button>
                </DialogActions>
            </Dialog>

            {diffFeature && (
                <FeatureSyncDialog
                    projectId={projectId}
                    featureName={diffFeature}
                    open
                    onClose={() => setDiffFeature(null)}
                    onSynced={onRefresh}
                />
            )}
        </>
    );
};
