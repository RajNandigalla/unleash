import { ButtonBase } from '@mui/material';
import { Badge } from 'component/common/Badge/Badge';
import type { EnvironmentSyncFeatureStatus } from 'interfaces/environmentSync';

const badgeSx = { whiteSpace: 'nowrap' } as const;

type SyncBadgeProps = {
    color: 'success' | 'warning' | 'error' | 'neutral';
    label: string;
    title?: string;
    onOpen?: () => void;
};

const SyncBadge = ({ color, label, title, onOpen }: SyncBadgeProps) => {
    if (!onOpen) {
        return (
            <Badge color={color} sx={badgeSx} title={title}>
                {label}
            </Badge>
        );
    }

    // A Badge on its own is a span with a click handler, which keyboard users
    // cannot reach. ButtonBase makes the status focusable and activatable.
    return (
        <ButtonBase
            onClick={onOpen}
            aria-label={`Environment sync: ${label}`}
            sx={{ borderRadius: 1, display: 'inline-flex' }}
        >
            <Badge color={color} sx={badgeSx} title={title}>
                {label}
            </Badge>
        </ButtonBase>
    );
};

type FeatureSyncCellProps = {
    status?: EnvironmentSyncFeatureStatus;
    hasTargets: boolean;
    loading?: boolean;
    onOpen: () => void;
};

export const FeatureSyncCell = ({
    status,
    hasTargets,
    loading,
    onOpen,
}: FeatureSyncCellProps) => {
    if (!hasTargets) {
        return (
            <SyncBadge
                color='neutral'
                label='—'
                title='Connect environments in Admin → Environment sync'
            />
        );
    }

    if (loading && !status) {
        return <SyncBadge color='neutral' label='Checking…' />;
    }

    if (!status) {
        return (
            <SyncBadge
                color='neutral'
                label='—'
                title='Sync status is not available for this flag'
            />
        );
    }

    if (status === 'error') {
        return <SyncBadge color='error' label='Check failed' onOpen={onOpen} />;
    }

    if (status === 'in_sync') {
        return <SyncBadge color='success' label='In sync' onOpen={onOpen} />;
    }

    if (status === 'no_config') {
        return <SyncBadge color='neutral' label='No config' onOpen={onOpen} />;
    }

    return <SyncBadge color='warning' label='Out of sync' onOpen={onOpen} />;
};
