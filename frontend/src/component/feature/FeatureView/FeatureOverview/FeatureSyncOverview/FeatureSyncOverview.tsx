import { useContext, useState } from 'react';
import {
    Box,
    Button,
    CircularProgress,
    Paper,
    Typography,
} from '@mui/material';
import { Link } from 'react-router';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Badge } from 'component/common/Badge/Badge';
import { useUiFlag } from 'hooks/useUiFlag';
import { useCheckProjectPermissions } from 'hooks/useHasAccess';
import { UPDATE_FEATURE_ENVIRONMENT } from 'component/providers/AccessProvider/permissions';
import useToast from 'hooks/useToast';
import { formatUnknownError } from 'utils/formatUnknownError';
import { useFeatureSyncCompare } from 'hooks/api/getters/useFeatureSyncCompare/useFeatureSyncCompare';
import { useEnvironmentSyncApi } from 'hooks/api/actions/useEnvironmentSyncApi/useEnvironmentSyncApi';
import { FeatureSyncDialog } from 'component/feature/FeatureSync/FeatureSyncDialog';
import { SidebarModal } from 'component/common/SidebarModal/SidebarModal';
import { EnvironmentSyncTargetConfigPage } from 'component/admin/environmentSync/EnvironmentSyncTargetConfigPage';
import AccessContext from 'contexts/AccessContext';
import { ADMIN } from 'component/providers/AccessProvider/permissions';
import type {
    EnvironmentSyncConfig,
    EnvironmentSyncTargetStatus,
} from 'interfaces/environmentSync';

type FeatureSyncOverviewProps = {
    projectId: string;
    featureName: string;
};

const statusLabel: Record<EnvironmentSyncTargetStatus, string> = {
    in_sync: 'In sync',
    drift: 'Out of sync',
    missing_remote: 'Missing on target',
    no_local_config: 'No source config',
    env_not_available: 'Environment unavailable',
    archived: 'Archived on target',
    excluded: 'Excluded',
    error: 'Check failed',
};

const isJsonContainer = (value: string): boolean => {
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null;
    } catch {
        return false;
    }
};

const hasJsonFields = (config: EnvironmentSyncConfig | undefined): boolean => {
    if (!config) {
        return false;
    }
    const payloads = [
        ...(config.variants ?? []),
        ...config.strategies.flatMap((strategy) => strategy.variants ?? []),
    ];
    if (payloads.some((variant) => variant.payload?.type === 'json')) {
        return true;
    }
    return config.strategies.some((strategy) =>
        Object.values(strategy.parameters ?? {}).some(isJsonContainer),
    );
};

const statusColor = (
    status: EnvironmentSyncTargetStatus,
): 'success' | 'warning' | 'error' | 'neutral' => {
    if (status === 'in_sync') {
        return 'success';
    }
    if (status === 'error' || status === 'archived') {
        return 'error';
    }
    if (status === 'no_local_config' || status === 'excluded') {
        return 'neutral';
    }
    return 'warning';
};

export const FeatureSyncOverview = ({
    projectId,
    featureName,
}: FeatureSyncOverviewProps) => {
    const enabled = useUiFlag('environmentSync');
    const canSync = useCheckProjectPermissions(projectId)(
        UPDATE_FEATURE_ENVIRONMENT,
    );
    // The targets endpoint requires ADMIN, but compare (like sync) only
    // requires UPDATE_FEATURE_ENVIRONMENT, so the configured targets are
    // read from the compare response instead.
    const show = enabled && canSync;
    const { compare, loading, refetch } = useFeatureSyncCompare(
        projectId,
        featureName,
        show,
    );
    const { hasAccess } = useContext(AccessContext);
    const { setFeatureExclusion } = useEnvironmentSyncApi();
    const [busyTargetId, setBusyTargetId] = useState<number | undefined>();
    const [configTargetId, setConfigTargetId] = useState<number | undefined>();
    const [dialogTarget, setDialogTarget] = useState<number | undefined>();
    const [dialogAction, setDialogAction] = useState<'diff' | 'sync'>('diff');
    const [dialogOpen, setDialogOpen] = useState(false);
    const [checking, setChecking] = useState(false);
    const { setToastData, setToastApiError } = useToast();

    const hasTargets = (compare?.targets.length ?? 0) > 0;

    if (!show || (!loading && !hasTargets)) {
        return null;
    }

    const recheck = async () => {
        setChecking(true);
        try {
            const fresh = await refetch();
            const notInSync = (fresh?.targets ?? []).filter(
                (target) =>
                    target.status !== 'in_sync' && target.status !== 'excluded',
            ).length;
            if (notInSync === 0) {
                setToastData({
                    type: 'success',
                    text: 'All targets are in sync',
                });
            } else {
                setToastData({
                    type: 'error',
                    text: `${notInSync} target${
                        notInSync === 1 ? '' : 's'
                    } not in sync`,
                });
            }
        } catch (error) {
            setToastApiError(formatUnknownError(error));
        } finally {
            setChecking(false);
        }
    };

    const setExclusion = async (targetId: number, excluded: boolean) => {
        setBusyTargetId(targetId);
        try {
            const result = await setFeatureExclusion(
                targetId,
                featureName,
                excluded,
            );
            if (result.reason) {
                setToastApiError(result.reason);
            } else {
                setToastData({
                    type: 'success',
                    text: excluded
                        ? 'Flag excluded from sync'
                        : 'Flag included in sync',
                });
            }
            await refetch();
        } catch (error) {
            setToastApiError(formatUnknownError(error));
        } finally {
            setBusyTargetId(undefined);
        }
    };

    const openDialog = (
        targetId?: number,
        action: 'diff' | 'sync' = 'diff',
    ) => {
        setDialogTarget(targetId);
        setDialogAction(action);
        setDialogOpen(true);
    };

    return (
        <Paper
            elevation={0}
            sx={{
                p: 3,
                border: (theme) => `1px solid ${theme.palette.divider}`,
            }}
        >
            <Box
                sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 2,
                    mb: 2,
                }}
            >
                <Box>
                    <Typography variant='h3'>Environment sync</Typography>
                    <Typography variant='body2' color='text.secondary'>
                        Syncs strategies and variants only. Everything else on
                        the target is left untouched.
                    </Typography>
                </Box>
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        flexWrap: 'wrap',
                    }}
                >
                    <Button
                        variant='outlined'
                        size='small'
                        onClick={recheck}
                        disabled={checking || loading || !compare}
                        startIcon={
                            checking ? (
                                <CircularProgress size={14} />
                            ) : (
                                <RefreshIcon />
                            )
                        }
                    >
                        {checking ? 'Checking…' : 'Recheck'}
                    </Button>
                    {hasAccess(ADMIN) && (
                        <Button
                            variant='outlined'
                            size='small'
                            component={Link}
                            to='/admin/environment-sync'
                        >
                            Sync configuration
                        </Button>
                    )}
                </Box>
            </Box>

            {loading && !compare ? (
                <Typography variant='body2'>Checking targets…</Typography>
            ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {(compare?.targets ?? []).map((target) => (
                        <Box
                            key={target.targetId}
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 2,
                                flexWrap: 'wrap',
                                py: 1,
                                borderTop: (theme) =>
                                    `1px solid ${theme.palette.divider}`,
                            }}
                        >
                            <Typography
                                sx={{ fontWeight: 'bold', minWidth: 120 }}
                            >
                                {target.targetName}
                            </Typography>
                            <Typography variant='body2' color='text.secondary'>
                                {target.sourceEnvironment} →{' '}
                                {target.targetEnvironment}
                            </Typography>
                            <Badge color={statusColor(target.status)}>
                                {statusLabel[target.status]}
                            </Badge>
                            {target.differences.length > 0 && (
                                <Typography
                                    variant='body2'
                                    color='text.secondary'
                                >
                                    {target.differences
                                        .map((difference) =>
                                            difference.field === 'strategies'
                                                ? `Strategies: ${difference.local} → ${difference.remote}`
                                                : `Variants: ${difference.local} → ${difference.remote}`,
                                        )
                                        .join(' · ')}
                                </Typography>
                            )}
                            <Box
                                sx={{
                                    marginLeft: 'auto',
                                    display: 'flex',
                                    gap: 1,
                                }}
                            >
                                {hasAccess(ADMIN) &&
                                    target.status !== 'excluded' &&
                                    (hasJsonFields(target.local) ||
                                        hasJsonFields(target.remote)) && (
                                        <Button
                                            size='small'
                                            onClick={() =>
                                                setConfigTargetId(
                                                    target.targetId,
                                                )
                                            }
                                        >
                                            Field exclusions
                                        </Button>
                                    )}
                                {hasAccess(ADMIN) && (
                                    <Button
                                        size='small'
                                        onClick={() =>
                                            setExclusion(
                                                target.targetId,
                                                target.status !== 'excluded',
                                            )
                                        }
                                        disabled={
                                            busyTargetId === target.targetId
                                        }
                                    >
                                        {target.status === 'excluded'
                                            ? 'Include'
                                            : 'Exclude'}
                                    </Button>
                                )}
                                <Button
                                    size='small'
                                    onClick={() =>
                                        openDialog(target.targetId, 'diff')
                                    }
                                >
                                    View diff
                                </Button>
                                <Button
                                    size='small'
                                    variant='contained'
                                    onClick={() =>
                                        openDialog(target.targetId, 'sync')
                                    }
                                    disabled={
                                        target.status !== 'drift' &&
                                        target.status !== 'missing_remote'
                                    }
                                >
                                    Sync
                                </Button>
                            </Box>
                        </Box>
                    ))}
                </Box>
            )}

            {configTargetId !== undefined && (
                <SidebarModal
                    open
                    onClose={() => {
                        setConfigTargetId(undefined);
                        void refetch();
                    }}
                    label='Field exclusions'
                >
                    <EnvironmentSyncTargetConfigPage
                        targetId={configTargetId}
                        featureFilter={featureName}
                        autoEdit
                        onClose={() => {
                            setConfigTargetId(undefined);
                            void refetch();
                        }}
                    />
                </SidebarModal>
            )}

            <FeatureSyncDialog
                projectId={projectId}
                featureName={featureName}
                open={dialogOpen}
                initialTargetId={dialogTarget}
                initialAction={dialogAction}
                onClose={() => setDialogOpen(false)}
                onSynced={refetch}
            />
        </Paper>
    );
};
