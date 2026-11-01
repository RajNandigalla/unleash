import { useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { Badge } from 'component/common/Badge/Badge';
import { useProjectSyncStatus } from 'hooks/api/getters/useProjectSyncStatus/useProjectSyncStatus';
import { formatUnknownError } from 'utils/formatUnknownError';
import useToast from 'hooks/useToast';
import { OutOfSyncFlagsDialog } from 'component/feature/FeatureSync/OutOfSyncFlagsDialog';

type ProjectSyncSummaryProps = {
    projectId: string;
    enabled: boolean;
};

export const ProjectSyncSummary = ({
    projectId,
    enabled,
}: ProjectSyncSummaryProps) => {
    const { status, summary, loading, error, refresh } = useProjectSyncStatus(
        projectId,
        enabled,
    );
    const [reviewOpen, setReviewOpen] = useState(false);
    const [checking, setChecking] = useState(false);
    const { setToastData, setToastApiError } = useToast();

    if (!enabled) {
        return null;
    }

    const onCheckNow = async () => {
        setChecking(true);
        try {
            const fresh = await refresh();
            if (fresh) {
                setToastData({
                    type: 'success',
                    text: `Sync status refreshed: ${fresh.summary.outOfSync} of ${fresh.summary.total} flags out of sync`,
                });
            }
        } catch (error) {
            setToastApiError(formatUnknownError(error));
        } finally {
            setChecking(false);
        }
    };

    return (
        <>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    flexWrap: 'wrap',
                    px: 3,
                    pt: 2,
                }}
            >
                {loading && !summary ? (
                    <>
                        <CircularProgress size={16} />
                        <Typography variant='body2'>
                            Checking environment sync…
                        </Typography>
                    </>
                ) : error ? (
                    <Typography variant='body2' color='error'>
                        Sync check failed: {formatUnknownError(error)}
                    </Typography>
                ) : summary ? (
                    <>
                        {summary.total === 0 ? (
                            <Typography variant='body2' color='text.secondary'>
                                No flags to check yet.
                            </Typography>
                        ) : (status?.targets ?? []).length === 0 ? (
                            // Nothing was compared, so do not claim success.
                            <Badge color='neutral'>
                                No environments connected
                            </Badge>
                        ) : summary.outOfSync === 0 && summary.errors === 0 ? (
                            <Badge color='success'>
                                All {summary.total} flags in sync
                            </Badge>
                        ) : (
                            <Badge color='warning'>
                                {summary.outOfSync} of {summary.total} flags out
                                of sync
                            </Badge>
                        )}
                        {summary.errors > 0 && (
                            <Badge
                                color='error'
                                title={(status?.targets ?? [])
                                    .filter((target) => target.error)
                                    .map(
                                        (target) =>
                                            `${target.targetName}: ${target.error}`,
                                    )
                                    .join(' · ')}
                            >
                                {summary.errors} check
                                {summary.errors === 1 ? '' : 's'} failed
                            </Badge>
                        )}
                        <Button
                            size='small'
                            variant='outlined'
                            onClick={() => setReviewOpen(true)}
                            disabled={
                                summary.outOfSync === 0 && summary.errors === 0
                            }
                        >
                            Review out-of-sync
                        </Button>
                    </>
                ) : null}
                <Button
                    size='small'
                    onClick={onCheckNow}
                    disabled={checking}
                    startIcon={
                        checking ? <CircularProgress size={14} /> : undefined
                    }
                >
                    {checking ? 'Checking…' : 'Check now'}
                </Button>
                {status?.checkedAt && !checking ? (
                    <Typography variant='caption' color='text.secondary'>
                        Last checked{' '}
                        {new Date(status.checkedAt).toLocaleTimeString()}
                    </Typography>
                ) : null}
            </Box>

            <OutOfSyncFlagsDialog
                open={reviewOpen}
                onClose={() => setReviewOpen(false)}
                projectId={projectId}
                status={status}
                onRefresh={async () => {
                    await refresh();
                }}
            />
        </>
    );
};
