import { useContext, useState } from 'react';
import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    Typography,
} from '@mui/material';
import { useEnvironmentSyncApi } from 'hooks/api/actions/useEnvironmentSyncApi/useEnvironmentSyncApi';
import useToast from 'hooks/useToast';
import { formatUnknownError } from 'utils/formatUnknownError';
import AccessContext from 'contexts/AccessContext';
import { ADMIN } from 'component/providers/AccessProvider/permissions';
import type { EnvironmentSyncProjectStatus } from 'interfaces/environmentSync';

type ExcludedFlagsDialogProps = {
    open: boolean;
    onClose: () => void;
    status?: EnvironmentSyncProjectStatus;
    onChanged?: () => Promise<void> | void;
};

const excludedTargetIds = (
    feature: EnvironmentSyncProjectStatus['features'][number],
): number[] =>
    feature.targets
        .filter((target) => target.status === 'excluded')
        .map((target) => target.targetId);

export const ExcludedFlagsDialog = ({
    open,
    onClose,
    status,
    onChanged,
}: ExcludedFlagsDialogProps) => {
    const { setFeatureExclusion } = useEnvironmentSyncApi();
    const { hasAccess } = useContext(AccessContext);
    // Including a flag mutates the target-wide exclusion list, and the
    // feature-exclusion endpoint requires ADMIN. Do not offer the action to
    // users the API rejects.
    const canEdit = hasAccess(ADMIN);
    const { setToastData, setToastApiError } = useToast();
    const [busy, setBusy] = useState<string | undefined>();

    const targetNames = new Map(
        (status?.targets ?? []).map((target) => [
            target.targetId,
            target.targetName,
        ]),
    );
    const rows = (status?.features ?? []).filter(
        (feature) => feature.status === 'excluded',
    );

    const include = async (
        feature: EnvironmentSyncProjectStatus['features'][number],
    ) => {
        setBusy(feature.featureName);
        try {
            let reason: string | undefined;
            for (const targetId of excludedTargetIds(feature)) {
                const result = await setFeatureExclusion(
                    targetId,
                    feature.featureName,
                    false,
                );
                if (result.reason) {
                    reason = result.reason;
                }
            }
            if (reason) {
                setToastApiError(reason);
            } else {
                setToastData({
                    type: 'success',
                    text: `${feature.featureName} included in sync`,
                });
            }
            await onChanged?.();
        } catch (error) {
            setToastApiError(formatUnknownError(error));
        } finally {
            setBusy(undefined);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth='md' fullWidth>
            <DialogTitle>Excluded flags ({rows.length})</DialogTitle>
            <DialogContent dividers>
                <Typography
                    variant='body2'
                    color='text.secondary'
                    sx={{ mb: 2 }}
                >
                    These flags are excluded from every connected environment.
                    They are never compared or synced. Including a flag that a
                    glob or tag rule excludes is not possible here; change that
                    rule on the environment configuration page.
                </Typography>
                {rows.length === 0 ? (
                    <Typography>No flags are excluded.</Typography>
                ) : (
                    <Table size='small'>
                        <TableHead>
                            <TableRow>
                                <TableCell>Flag</TableCell>
                                <TableCell>Excluded on</TableCell>
                                {canEdit && (
                                    <TableCell align='right'>Edit</TableCell>
                                )}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {rows.map((row) => (
                                <TableRow key={row.featureName}>
                                    <TableCell>{row.featureName}</TableCell>
                                    <TableCell>
                                        {excludedTargetIds(row)
                                            .map(
                                                (targetId) =>
                                                    targetNames.get(targetId) ??
                                                    `Target ${targetId}`,
                                            )
                                            .join(', ')}
                                    </TableCell>
                                    {canEdit && (
                                        <TableCell align='right'>
                                            <Button
                                                size='small'
                                                disabled={
                                                    busy === row.featureName
                                                }
                                                onClick={() => include(row)}
                                            >
                                                Include
                                            </Button>
                                        </TableCell>
                                    )}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
};
