import { useState } from 'react';
import {
    Alert,
    Box,
    Button,
    IconButton,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import SyncIcon from '@mui/icons-material/Sync';
import { ADMIN } from 'component/providers/AccessProvider/permissions';
import { PermissionGuard } from 'component/common/PermissionGuard/PermissionGuard';
import { PageContent } from 'component/common/PageContent/PageContent';
import { PageHeader } from 'component/common/PageHeader/PageHeader';
import { Dialogue } from 'component/common/Dialogue/Dialogue';
import { Badge } from 'component/common/Badge/Badge';
import { useEnvironmentSyncTargets } from 'hooks/api/getters/useEnvironmentSyncTargets/useEnvironmentSyncTargets';
import { useEnvironmentSyncApi } from 'hooks/api/actions/useEnvironmentSyncApi/useEnvironmentSyncApi';
import useToast from 'hooks/useToast';
import { formatUnknownError } from 'utils/formatUnknownError';
import { EnvironmentSyncTargetForm } from './EnvironmentSyncTargetForm';
import type { EnvironmentSyncTarget } from 'interfaces/environmentSync';

export const EnvironmentSyncAdmin = () => (
    <PermissionGuard permissions={[ADMIN]}>
        <EnvironmentSyncPage />
    </PermissionGuard>
);

const EnvironmentSyncPage = () => {
    const { targets, tokenStorageConfigured, loading, refetch } =
        useEnvironmentSyncTargets();
    const { deleteTarget, testTargetById } = useEnvironmentSyncApi();
    const { setToastData, setToastApiError } = useToast();

    const [formOpen, setFormOpen] = useState(false);
    const [editing, setEditing] = useState<EnvironmentSyncTarget | undefined>();
    const [deleting, setDeleting] = useState<
        EnvironmentSyncTarget | undefined
    >();
    const [testingId, setTestingId] = useState<number | null>(null);

    const openCreate = () => {
        setEditing(undefined);
        setFormOpen(true);
    };

    const openEdit = (target: EnvironmentSyncTarget) => {
        setEditing(target);
        setFormOpen(true);
    };

    const onTest = async (target: EnvironmentSyncTarget) => {
        setTestingId(target.id);
        try {
            const result = await testTargetById(target.id);
            if (result.ok) {
                setToastData({
                    type: 'success',
                    text: `Connected to ${target.name}`,
                });
            } else {
                setToastApiError(result.error ?? 'Connection failed');
            }
        } catch (error) {
            setToastApiError(formatUnknownError(error));
        } finally {
            setTestingId(null);
            await refetch();
        }
    };

    const onDelete = async () => {
        if (!deleting) {
            return;
        }
        try {
            await deleteTarget(deleting.id);
            setToastData({
                type: 'success',
                text: `Removed ${deleting.name}`,
            });
            setDeleting(undefined);
            await refetch();
        } catch (error) {
            setToastApiError(formatUnknownError(error));
        }
    };

    return (
        <PageContent
            header={
                <PageHeader
                    title='Environment sync'
                    subtitle='Keep strategy and variant configuration aligned across Unleash instances.'
                    actions={
                        <Button
                            variant='contained'
                            onClick={openCreate}
                            disabled={!tokenStorageConfigured}
                        >
                            Add environment
                        </Button>
                    }
                />
            }
        >
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {!loading && !tokenStorageConfigured && (
                    <Alert severity='error'>
                        Token storage is not configured. Set{' '}
                        <code>UNLEASH_SYNC_ENCRYPTION_KEY</code> to a
                        base64-encoded 32-byte key (for example{' '}
                        <code>openssl rand -base64 32</code>) and restart
                        Unleash before connecting environments.
                    </Alert>
                )}

                <Alert severity='info'>
                    Sync replaces <strong>strategies and variants</strong> only,
                    including variant payloads and <code>userId</code>{' '}
                    overrides. Strategy order is preserved because it determines
                    which strategy variant applies. Everything else on the
                    target — enabled state, metadata, tags, links, dependencies,
                    release plans and safeguards — stays untouched. If the flag
                    doesn't exist on the target, it's created disabled with
                    default metadata.
                </Alert>

                {!loading && targets.length === 0 ? (
                    <Box sx={{ py: 6, textAlign: 'center' }}>
                        <Typography variant='h3' sx={{ mb: 1 }}>
                            No environments connected yet
                        </Typography>
                        <Typography color='text.secondary'>
                            Connect a target instance to start checking and
                            syncing configuration.
                        </Typography>
                    </Box>
                ) : (
                    <Table>
                        <TableHead>
                            <TableRow>
                                <TableCell>Environment</TableCell>
                                <TableCell>Project</TableCell>
                                <TableCell>Sync from → to</TableCell>
                                <TableCell>Last synced</TableCell>
                                <TableCell>Status</TableCell>
                                <TableCell align='right'>Actions</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {targets.map((target) => (
                                <TableRow key={target.id}>
                                    <TableCell>
                                        <Typography sx={{ fontWeight: 'bold' }}>
                                            {target.name}
                                        </Typography>
                                        <Typography
                                            variant='body2'
                                            color='text.secondary'
                                        >
                                            {target.url}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        {target.project || 'Same project'}
                                    </TableCell>
                                    <TableCell>
                                        {target.sourceEnvironment} →{' '}
                                        {target.targetEnvironment}
                                    </TableCell>
                                    <TableCell>
                                        {target.lastSyncedAt
                                            ? new Date(
                                                  target.lastSyncedAt,
                                              ).toLocaleString()
                                            : 'Never'}
                                    </TableCell>
                                    <TableCell>
                                        {target.lastTestStatus === 'error' ||
                                        target.lastSyncStatus === 'error' ? (
                                            <Badge color='error'>Error</Badge>
                                        ) : target.lastSyncedAt ? (
                                            <Badge color='success'>
                                                Synced
                                            </Badge>
                                        ) : (
                                            <Badge color='neutral'>
                                                Not synced
                                            </Badge>
                                        )}
                                    </TableCell>
                                    <TableCell align='right'>
                                        <IconButton
                                            title='Test connection'
                                            onClick={() => onTest(target)}
                                            disabled={testingId === target.id}
                                        >
                                            <SyncIcon />
                                        </IconButton>
                                        <IconButton
                                            title='Edit'
                                            onClick={() => openEdit(target)}
                                        >
                                            <EditIcon />
                                        </IconButton>
                                        <IconButton
                                            title='Delete'
                                            onClick={() => setDeleting(target)}
                                        >
                                            <DeleteIcon />
                                        </IconButton>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </Box>

            <EnvironmentSyncTargetForm
                open={formOpen}
                target={editing}
                onClose={() => setFormOpen(false)}
                onSaved={refetch}
            />

            <Dialogue
                open={Boolean(deleting)}
                title='Remove environment?'
                primaryButtonText='Remove'
                secondaryButtonText='Cancel'
                onClick={onDelete}
                onClose={() => setDeleting(undefined)}
            >
                <p>
                    Remove <strong>{deleting?.name}</strong>? Synced flags are
                    not affected.
                </p>
            </Dialogue>
        </PageContent>
    );
};
