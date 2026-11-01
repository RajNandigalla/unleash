import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Tab,
    Tabs,
    Typography,
} from '@mui/material';
import { Badge } from 'component/common/Badge/Badge';
import { Dialogue } from 'component/common/Dialogue/Dialogue';
import { JsonDiffViewer } from 'component/common/JsonDiffViewer/JsonDiffViewer';
import { StrategyDiffView } from './StrategyDiffView';
import { useFeatureSyncCompare } from 'hooks/api/getters/useFeatureSyncCompare/useFeatureSyncCompare';
import { useEnvironmentSyncApi } from 'hooks/api/actions/useEnvironmentSyncApi/useEnvironmentSyncApi';
import useToast from 'hooks/useToast';
import { useTracking } from 'hooks/useTracking';
import { syncConfigurationTracking } from './environmentSyncTracking';
import { formatUnknownError } from 'utils/formatUnknownError';
import type {
    EnvironmentSyncTargetStatus,
    EnvironmentSyncTargetStatusView,
} from 'interfaces/environmentSync';

type FeatureSyncDialogProps = {
    projectId: string;
    featureName: string;
    open: boolean;
    initialTargetId?: number;
    initialAction?: 'diff' | 'sync';
    onClose: () => void;
    onSynced?: () => void;
};

const statusMeta: Record<
    EnvironmentSyncTargetStatus,
    { color: 'success' | 'warning' | 'error' | 'neutral'; label: string }
> = {
    in_sync: { color: 'success', label: 'In sync' },
    drift: { color: 'warning', label: 'Out of sync' },
    missing_remote: { color: 'warning', label: 'Missing on target' },
    no_local_config: { color: 'neutral', label: 'No source config' },
    env_not_available: { color: 'error', label: 'Environment unavailable' },
    archived: { color: 'error', label: 'Archived on target' },
    error: { color: 'error', label: 'Check failed' },
};

export const FeatureSyncDialog = ({
    projectId,
    featureName,
    open,
    initialTargetId,
    initialAction = 'diff',
    onClose,
    onSynced,
}: FeatureSyncDialogProps) => {
    const { compare, loading, error, refetch } = useFeatureSyncCompare(
        projectId,
        featureName,
        open,
    );
    const { sync } = useEnvironmentSyncApi();
    const trackSync = useTracking(syncConfigurationTracking);
    const { setToastData, setToastApiError } = useToast();

    const [selected, setSelected] = useState(0);
    const [confirmTargets, setConfirmTargets] = useState<
        EnvironmentSyncTargetStatusView[]
    >([]);
    const [syncing, setSyncing] = useState(false);

    const targets = useMemo(() => compare?.targets ?? [], [compare]);

    // The initial tab and confirmation are applied once per open. Revalidating
    // the compare request produces a new `targets` array, which must not
    // reset the tab the user selected or re-open a cancelled confirmation.
    const appliedInitialStateRef = useRef<string | null>(null);

    useEffect(() => {
        if (!open) {
            appliedInitialStateRef.current = null;
            setSelected(0);
            setConfirmTargets([]);
            return;
        }

        const key = `${initialTargetId ?? ''}:${initialAction}`;
        if (appliedInitialStateRef.current === key) {
            return;
        }

        if (initialTargetId === undefined) {
            setSelected(0);
            appliedInitialStateRef.current = key;
            return;
        }

        const index = targets.findIndex(
            (target) => target.targetId === initialTargetId,
        );
        if (index < 0) {
            // The compare request has not resolved yet; retry when it does.
            return;
        }

        setSelected(index);
        const target = targets[index];
        if (
            initialAction === 'sync' &&
            (target.status === 'drift' || target.status === 'missing_remote')
        ) {
            setConfirmTargets([target]);
        }
        appliedInitialStateRef.current = key;
    }, [open, initialTargetId, initialAction, targets]);

    const outOfSyncTargets = useMemo(
        () =>
            targets.filter(
                (target) =>
                    target.status === 'drift' ||
                    target.status === 'missing_remote',
            ),
        [targets],
    );

    const current = targets[selected];

    const runSync = async () => {
        if (confirmTargets.length === 0) {
            return;
        }
        setSyncing(true);
        try {
            const response = await trackSync.mutation(() =>
                sync({
                    projectId,
                    featureNames: [featureName],
                    targetIds: confirmTargets.map((target) => target.targetId),
                    onlyOutOfSync: false,
                }),
            );
            const failures = response.results.flatMap((result) =>
                result.features.filter((feature) => feature.status === 'error'),
            );
            if (failures.length > 0) {
                setToastApiError(
                    failures[0].error ?? 'Some targets could not be synced',
                );
            } else {
                setToastData({
                    type: 'success',
                    text: `Configuration synced to ${confirmTargets
                        .map((target) => target.targetName)
                        .join(', ')}`,
                });
            }
            setConfirmTargets([]);
            await refetch();
            onSynced?.();
        } catch (syncError) {
            setToastApiError(formatUnknownError(syncError));
        } finally {
            setSyncing(false);
        }
    };

    return (
        <>
            <Dialog
                open={open}
                onClose={onClose}
                fullScreen
                aria-label={`Sync ${featureName}`}
            >
                <DialogTitle>Sync {featureName}</DialogTitle>
                <DialogContent dividers>
                    <Alert severity='info' sx={{ mb: 2 }}>
                        This replaces <strong>strategies and variants</strong>{' '}
                        in the selected target environments. Variant payloads
                        and <code>userId</code> overrides are copied, and
                        strategy order is preserved because the first matching
                        strategy with variants wins. Enabled state and metadata
                        are not changed. Change-request rules on the targets are
                        not enforced.
                    </Alert>

                    {loading && <Typography>Checking targets…</Typography>}
                    {error && (
                        <Alert severity='error'>
                            {formatUnknownError(error)}
                        </Alert>
                    )}

                    {targets.length > 0 && (
                        <>
                            <Tabs
                                value={Math.min(selected, targets.length - 1)}
                                onChange={(_event, value) => setSelected(value)}
                                variant='scrollable'
                                allowScrollButtonsMobile
                            >
                                {targets.map((target) => (
                                    <Tab
                                        key={target.targetId}
                                        label={
                                            <Box
                                                sx={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: 1,
                                                }}
                                            >
                                                {target.targetName}
                                                <Badge
                                                    color={
                                                        statusMeta[
                                                            target.status
                                                        ].color
                                                    }
                                                >
                                                    {
                                                        statusMeta[
                                                            target.status
                                                        ].label
                                                    }
                                                </Badge>
                                            </Box>
                                        }
                                    />
                                ))}
                            </Tabs>

                            {current && (
                                <Box
                                    sx={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 2,
                                        pt: 2,
                                    }}
                                >
                                    <Typography variant='body2'>
                                        {current.sourceEnvironment} →{' '}
                                        {current.targetEnvironment}
                                    </Typography>

                                    {current.status === 'error' && (
                                        <Alert severity='error'>
                                            {current.error}
                                        </Alert>
                                    )}
                                    {current.status === 'env_not_available' && (
                                        <Alert severity='warning'>
                                            {current.error ??
                                                'The environment is not enabled for this project on one of the instances.'}
                                        </Alert>
                                    )}
                                    {current.status === 'archived' && (
                                        <Alert severity='warning'>
                                            The flag is archived on the target
                                            instance.
                                        </Alert>
                                    )}
                                    {current.status === 'no_local_config' && (
                                        <Alert severity='info'>
                                            The flag has no configuration in the
                                            source environment.
                                        </Alert>
                                    )}
                                    {current.status === 'missing_remote' && (
                                        <Alert severity='info'>
                                            The flag does not exist on the
                                            target. Sync will create it disabled
                                            and apply this configuration.
                                        </Alert>
                                    )}

                                    {current.diff ? (
                                        <StrategyDiffView
                                            key={current.targetId}
                                            diff={current.diff}
                                            local={current.local}
                                            remote={current.remote}
                                            leftLabel={`This instance · ${current.sourceEnvironment}`}
                                            rightLabel={`${current.targetName} · ${current.targetEnvironment}`}
                                        />
                                    ) : current.local || current.remote ? (
                                        <JsonDiffViewer
                                            left={current.local}
                                            right={current.remote}
                                            leftLabel={`This instance · ${current.sourceEnvironment}`}
                                            rightLabel={`${current.targetName} · ${current.targetEnvironment}`}
                                            height='60vh'
                                        />
                                    ) : null}
                                </Box>
                            )}
                        </>
                    )}

                    {!loading && targets.length === 0 && (
                        <Alert severity='info'>
                            No environments are connected yet.
                        </Alert>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={onClose}>Close</Button>
                    {outOfSyncTargets.length > 1 && (
                        <Button
                            variant='outlined'
                            onClick={() => setConfirmTargets(outOfSyncTargets)}
                        >
                            Sync all out-of-sync targets (
                            {outOfSyncTargets.length})
                        </Button>
                    )}
                    {current &&
                        (current.status === 'drift' ||
                            current.status === 'missing_remote') && (
                            <Button
                                variant='contained'
                                onClick={() => setConfirmTargets([current])}
                            >
                                Sync this target
                            </Button>
                        )}
                </DialogActions>
            </Dialog>

            <Dialogue
                open={confirmTargets.length > 0}
                title='Sync configuration?'
                primaryButtonText={syncing ? 'Syncing…' : 'Sync'}
                secondaryButtonText='Cancel'
                onClick={runSync}
                onClose={() => {
                    if (!syncing) {
                        setConfirmTargets([]);
                    }
                }}
            >
                <p>
                    Strategies and variants for <strong>{featureName}</strong>{' '}
                    will be written to:
                </p>
                <ul>
                    {confirmTargets.map((target) => (
                        <li key={target.targetId}>
                            <strong>{target.targetName}</strong> (
                            {target.sourceEnvironment} →{' '}
                            {target.targetEnvironment})
                        </li>
                    ))}
                </ul>
                <p>
                    Only <strong>strategies and variants</strong> will be
                    replaced. Everything else on the target — its enabled state,
                    metadata (description, type, impression data), tags, links,
                    dependencies, release plans and safeguards — stays exactly
                    as it is.
                </p>
            </Dialogue>
        </>
    );
};
