import { useEffect, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    FormControlLabel,
    Switch,
    Typography,
} from '@mui/material';
import { SidebarModal } from 'component/common/SidebarModal/SidebarModal';
import Input from 'component/common/Input/Input';
import { AutocompleteField } from 'component/common/AutocompleteField/AutocompleteField';
import { useEnvironments } from 'hooks/api/getters/useEnvironments/useEnvironments';
import { useEnvironmentSyncApi } from 'hooks/api/actions/useEnvironmentSyncApi/useEnvironmentSyncApi';
import useToast from 'hooks/useToast';
import { formatUnknownError } from 'utils/formatUnknownError';
import type {
    EnvironmentSyncTarget,
    EnvironmentSyncTargetInput,
    EnvironmentSyncTestResult,
} from 'interfaces/environmentSync';

interface EnvironmentSyncTargetFormProps {
    target?: EnvironmentSyncTarget;
    open: boolean;
    onClose: () => void;
    onSaved: () => void;
}

export const EnvironmentSyncTargetForm = ({
    target,
    open,
    onClose,
    onSaved,
}: EnvironmentSyncTargetFormProps) => {
    const { environments } = useEnvironments();
    const { createTarget, updateTarget, testTarget, testTargetById } =
        useEnvironmentSyncApi();
    const { setToastData, setToastApiError } = useToast();

    const [name, setName] = useState(target?.name ?? '');
    const [url, setUrl] = useState(target?.url ?? '');
    const [token, setToken] = useState('');
    const [project, setProject] = useState(target?.project ?? '');
    const [sourceEnvironment, setSourceEnvironment] = useState(
        target?.sourceEnvironment ?? '',
    );
    const [targetEnvironment, setTargetEnvironment] = useState(
        target?.targetEnvironment ?? '',
    );
    const [enabled, setEnabled] = useState(target?.enabled ?? true);
    const [targetEnvironmentTouched, setTargetEnvironmentTouched] =
        useState(false);
    const [remoteEnvironments, setRemoteEnvironments] = useState<string[]>([]);
    const [loadingEnvironments, setLoadingEnvironments] = useState(false);
    const [testResult, setTestResult] =
        useState<EnvironmentSyncTestResult | null>(null);
    const [testing, setTesting] = useState(false);
    const [saving, setSaving] = useState(false);

    const loadEnvironments = async () => {
        if (!target && (!url.trim() || !token.trim())) {
            setTestResult({
                ok: false,
                environments: [],
                error: 'Enter the instance URL and access token first',
            });
            return;
        }

        setLoadingEnvironments(true);
        try {
            const result = token.trim()
                ? await testTarget({
                      url,
                      token,
                      project: project || null,
                  })
                : target
                  ? await testTargetById(target.id)
                  : {
                        ok: false,
                        environments: [],
                        error: 'Enter the instance URL and access token first',
                    };

            setRemoteEnvironments(result.environments);
            setTestResult(result);
            if (result.ok) {
                setToastData({
                    type: 'success',
                    text: `Loaded ${result.environments.length} environment${
                        result.environments.length === 1 ? '' : 's'
                    } from the target`,
                });
            }
        } catch (error) {
            setTestResult({
                ok: false,
                environments: [],
                error: formatUnknownError(error),
            });
        } finally {
            setLoadingEnvironments(false);
        }
    };

    useEffect(() => {
        if (open) {
            setName(target?.name ?? '');
            setUrl(target?.url ?? '');
            setToken('');
            setProject(target?.project ?? '');
            setSourceEnvironment(target?.sourceEnvironment ?? '');
            setTargetEnvironment(target?.targetEnvironment ?? '');
            setTargetEnvironmentTouched(false);
            setEnabled(target?.enabled ?? true);
            setRemoteEnvironments([]);
            setTestResult(null);
        }
    }, [open, target]);

    useEffect(() => {
        if (!sourceEnvironment && environments.length > 0) {
            const firstEnvironment = environments[0].name;
            setSourceEnvironment(firstEnvironment);
            if (!targetEnvironmentTouched) {
                setTargetEnvironment(firstEnvironment);
            }
        }
    }, [environments, sourceEnvironment, targetEnvironmentTouched]);

    const runTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const result =
                target && !token
                    ? await testTargetById(target.id)
                    : await testTarget({
                          url,
                          token,
                          project: project || null,
                          targetEnvironment,
                      });
            setTestResult(result);
            setRemoteEnvironments(result.environments);
            if (result.ok) {
                setToastData({
                    type: 'success',
                    text: 'Connected to the target instance',
                });
            }
        } catch (error) {
            setTestResult({
                ok: false,
                environments: [],
                error: formatUnknownError(error),
            });
        } finally {
            setTesting(false);
        }
    };

    const save = async () => {
        if (
            !name.trim() ||
            !url.trim() ||
            !sourceEnvironment ||
            !targetEnvironment
        ) {
            setTestResult({
                ok: false,
                environments: remoteEnvironments,
                error: 'Name, URL, source environment and target environment are required',
            });
            return;
        }
        if (!target && !token.trim()) {
            setTestResult({
                ok: false,
                environments: remoteEnvironments,
                error: 'An access token is required',
            });
            return;
        }

        setSaving(true);
        try {
            const input: EnvironmentSyncTargetInput = {
                name: name.trim(),
                url: url.trim(),
                ...(token.trim() ? { token: token.trim() } : {}),
                project: project.trim() || null,
                sourceEnvironment,
                targetEnvironment: targetEnvironment.trim(),
                enabled,
            };
            if (target) {
                await updateTarget(target.id, input);
            } else {
                await createTarget(input);
            }
            setToastData({
                type: 'success',
                text: target ? 'Environment updated' : 'Environment connected',
            });
            onSaved();
            onClose();
        } catch (error) {
            setToastApiError(formatUnknownError(error));
        } finally {
            setSaving(false);
        }
    };

    return (
        <SidebarModal
            open={open}
            onClose={onClose}
            label={target ? 'Edit environment' : 'Connect environment'}
        >
            <Box
                sx={{
                    p: 4,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    width: '100%',
                    maxWidth: 720,
                }}
            >
                <Typography variant='h2'>
                    {target ? 'Edit environment' : 'Connect environment'}
                </Typography>
                <Typography color='text.secondary'>
                    Strategy and variant configuration is copied from the source
                    environment to the target environment. Everything else on
                    the target — its enabled state, metadata, tags, links,
                    dependencies, release plans and safeguards — stays exactly
                    as it is.
                </Typography>

                <Input
                    label='Environment name'
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder='QA'
                    fullWidth
                />
                <Input
                    label='Instance URL'
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder='https://unleash.qa.example.com'
                    fullWidth
                />
                <Input
                    label='Access token'
                    type='password'
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder={
                        target
                            ? 'Leave blank to keep the current token'
                            : 'Admin API token for the target instance'
                    }
                    description={
                        target
                            ? 'The token is stored encrypted and never returned.'
                            : 'Create an admin token in the target instance.'
                    }
                    fullWidth
                />
                <Input
                    label='Target project (optional)'
                    value={project}
                    onChange={(event) => setProject(event.target.value)}
                    placeholder='Same project as the source'
                    description='Leave blank to use the project id from the source instance.'
                    fullWidth
                />

                <AutocompleteField
                    label='Source environment (this instance)'
                    options={environments.map(
                        (environment) => environment.name,
                    )}
                    value={sourceEnvironment || null}
                    onChange={(_event, value) => {
                        const next = value ?? '';
                        setSourceEnvironment(next);
                        if (!targetEnvironmentTouched) {
                            setTargetEnvironment(next);
                        }
                    }}
                />

                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        alignItems: 'flex-start',
                    }}
                >
                    <Box sx={{ flex: 1 }}>
                        <AutocompleteField
                            freeSolo
                            forcePopupIcon
                            label='Target environment (other instance)'
                            description='Load the environments from the target, then pick one or type it.'
                            options={remoteEnvironments}
                            value={targetEnvironment}
                            onChange={(_event, value) => {
                                setTargetEnvironmentTouched(true);
                                setTargetEnvironment(value ?? '');
                            }}
                            onInputChange={(_event, value) => {
                                setTargetEnvironmentTouched(true);
                                setTargetEnvironment(value);
                            }}
                        />
                    </Box>
                    <Button
                        variant='outlined'
                        onClick={() => loadEnvironments()}
                        disabled={
                            loadingEnvironments ||
                            (!target && (!url.trim() || !token.trim()))
                        }
                        sx={{ whiteSpace: 'nowrap', mt: 0.5 }}
                    >
                        {loadingEnvironments ? 'Loading…' : 'Load environments'}
                    </Button>
                </Box>

                <FormControlLabel
                    control={
                        <Switch
                            checked={enabled}
                            onChange={(event) =>
                                setEnabled(event.target.checked)
                            }
                        />
                    }
                    label='Enabled'
                />

                {testResult && (
                    <Alert severity={testResult.ok ? 'success' : 'error'}>
                        {testResult.ok
                            ? `Connected. Environments on the target: ${
                                  testResult.environments.join(', ') || 'none'
                              }`
                            : testResult.error}
                    </Alert>
                )}
                {testResult?.ok && testResult.projectExists === false && (
                    <Alert severity='warning'>
                        The target project does not exist on the other instance
                        yet.
                    </Alert>
                )}

                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        justifyContent: 'flex-end',
                    }}
                >
                    <Button
                        variant='outlined'
                        onClick={runTest}
                        disabled={testing || !url || (!target && !token)}
                    >
                        {testing ? 'Testing…' : 'Test connection'}
                    </Button>
                    <Button
                        variant='contained'
                        onClick={save}
                        disabled={saving}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </Button>
                </Box>
            </Box>
        </SidebarModal>
    );
};
