import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import useSWR from 'swr';
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Switch,
    FormControlLabel,
    Tab,
    Tabs,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TablePagination,
    TableRow,
    Tooltip,
    Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DownloadIcon from '@mui/icons-material/Download';
import UploadIcon from '@mui/icons-material/Upload';
import { PageContent } from 'component/common/PageContent/PageContent';
import { PageHeader } from 'component/common/PageHeader/PageHeader';
import { Badge } from 'component/common/Badge/Badge';
import Input from 'component/common/Input/Input';
import { AutocompleteField } from 'component/common/AutocompleteField/AutocompleteField';
import { EnvironmentSyncCatalogPicker } from './EnvironmentSyncCatalogPicker';
import { QuietLink } from 'component/common/QuietLink';
import { matchesIgnoreRule } from './ignoreRuleMatches';
import { useEnvironmentSyncTargets } from 'hooks/api/getters/useEnvironmentSyncTargets/useEnvironmentSyncTargets';
import { useEnvironmentSyncFlags } from 'hooks/api/getters/useEnvironmentSyncFlags/useEnvironmentSyncFlags';
import { useEnvironmentSyncApi } from 'hooks/api/actions/useEnvironmentSyncApi/useEnvironmentSyncApi';
import { formatUnknownError } from 'utils/formatUnknownError';
import useToast from 'hooks/useToast';
import type {
    EnvironmentSyncCatalogFlag,
    EnvironmentSyncFeatureFields,
    EnvironmentSyncIgnoredConfig,
} from 'interfaces/environmentSync';

type FlagRow = {
    flag: EnvironmentSyncCatalogFlag;
    rules: string[];
    ignored: string[];
    status: 'excluded' | 'partial' | 'none';
};

const normalizeEntries = (values: string[]): string[] => [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

const parseImportedConfig = (raw: unknown): EnvironmentSyncIgnoredConfig => {
    if (!raw || typeof raw !== 'object') {
        throw new Error('The file must contain a JSON object');
    }
    const record = raw as Record<string, unknown>;
    const listFrom = (
        source: Record<string, unknown>,
        key: string,
    ): string[] => {
        const value = source[key];
        if (value === undefined) {
            return [];
        }
        if (
            !Array.isArray(value) ||
            value.some((item) => typeof item !== 'string')
        ) {
            throw new Error(`"${key}" must be an array of strings`);
        }
        return normalizeEntries(value as string[]);
    };
    const list = (key: string): string[] => listFrom(record, key);

    const featureFields: EnvironmentSyncFeatureFields[] = [];
    if (record.featureFields !== undefined) {
        if (!Array.isArray(record.featureFields)) {
            throw new Error('"featureFields" must be an array');
        }
        for (const item of record.featureFields) {
            if (!item || typeof item !== 'object') {
                throw new Error('Each "featureFields" item must be an object');
            }
            const entry = item as Record<string, unknown>;
            const feature =
                typeof entry.feature === 'string' ? entry.feature.trim() : '';
            if (!feature) {
                throw new Error(
                    'Each "featureFields" item needs a feature name',
                );
            }
            featureFields.push({
                feature,
                parameters: listFrom(entry, 'parameters'),
                variantPayloads: listFrom(entry, 'variantPayloads'),
            });
        }
    }

    // Always emit featureFields, even when empty: the API rejects an
    // incomplete replacement so an omission cannot delete field exclusions.
    return {
        parameters: list('parameters'),
        variantPayloads: list('variantPayloads'),
        ignoredFeatures: list('ignoredFeatures'),
        featureFields,
    };
};

const flagRuleLabel = (row: FlagRow): string => {
    if (row.rules.length === 0) {
        return row.ignored.length > 0
            ? `${row.ignored.length} environment-specific ${
                  row.ignored.length === 1 ? 'field' : 'fields'
              }`
            : '—';
    }
    const rule = row.rules[0];
    if (rule.startsWith('tag:')) {
        return `Tag rule ${rule}`;
    }
    if (rule === row.flag.name) {
        return 'Excluded by name';
    }
    return `Rule ${rule}`;
};

type EnvironmentSyncTargetConfigPageProps = {
    targetId?: number;
    onClose?: () => void;
    autoEdit?: boolean;
    featureFilter?: string;
    onClearFeatureFilter?: () => void;
};

export const EnvironmentSyncTargetConfigPage = ({
    targetId: targetIdProp,
    onClose,
    autoEdit = false,
    featureFilter,
    onClearFeatureFilter,
}: EnvironmentSyncTargetConfigPageProps = {}) => {
    const { targetId: routeTargetId } = useParams();
    const targetId = targetIdProp ?? routeTargetId;
    const panel = Boolean(onClose);
    const navigate = useNavigate();
    const { setToastData, setToastApiError } = useToast();
    const {
        targets,
        loading: targetsLoading,
        error: targetsError,
        refetch: refetchTargets,
    } = useEnvironmentSyncTargets();
    const { flags } = useEnvironmentSyncFlags();
    const { getCatalog, updateTargetIgnoredConfig } = useEnvironmentSyncApi();

    const target = targets.find(
        (candidate) => String(candidate.id) === String(targetId),
    );

    const catalogKey = target
        ? `environment-sync-catalog:${target.id}:${target.sourceEnvironment}`
        : null;
    const {
        data: catalog,
        isLoading: catalogLoading,
        error: catalogError,
    } = useSWR(catalogKey, () =>
        getCatalog({
            targetId: target!.id,
            sourceEnvironment: target!.sourceEnvironment,
        }),
    );

    const [editing, setEditing] = useState(autoEdit);
    const [editTab, setEditTab] = useState(0);
    const [saving, setSaving] = useState(false);
    const [draftParameters, setDraftParameters] = useState<string[]>([]);
    const [draftPayloads, setDraftPayloads] = useState<string[]>([]);
    const [draftFeatures, setDraftFeatures] = useState<string[]>([]);
    const [draftFeatureFields, setDraftFeatureFields] = useState<
        EnvironmentSyncFeatureFields[]
    >([]);
    const [flagToEdit, setFlagToEdit] = useState<string | undefined>();
    const [showAllValues, setShowAllValues] = useState(false);
    const [search, setSearch] = useState('');
    const [onlyConfigured, setOnlyConfigured] = useState(false);
    const [page, setPage] = useState(0);
    const [rowsPerPage, setRowsPerPage] = useState(25);

    // SWR hands back a new `target` object on every revalidation, so keying
    // the draft reset on the object identity would throw away edits when the
    // tab regains focus. Read the latest target from a ref and reset only
    // when editing starts (or the target/scope changes).
    const targetRef = useRef(target);
    useEffect(() => {
        targetRef.current = target;
    }, [target]);

    useEffect(() => {
        const current = targetRef.current;
        // Reading the id here also keeps the reference in sync with the
        // dependency: drafts are per target, not per fetched object.
        const targetId = target?.id;
        if (!editing || !current || targetId === undefined) {
            return;
        }
        if (current.id !== targetId) {
            return;
        }
        const scoped = featureFilter
            ? current.ignoredConfig.featureFields?.find(
                  (entry) => entry.feature === featureFilter,
              )
            : undefined;
        setDraftParameters(
            featureFilter
                ? (scoped?.parameters ?? [])
                : current.ignoredConfig.parameters,
        );
        setDraftPayloads(
            featureFilter
                ? (scoped?.variantPayloads ?? [])
                : current.ignoredConfig.variantPayloads,
        );
        setDraftFeatures(current.ignoredConfig.ignoredFeatures);
        setDraftFeatureFields(current.ignoredConfig.featureFields ?? []);
        // Reset drafts when editing starts or the target/scope changes, not
        // on every revalidation that returns a new target object.
    }, [editing, featureFilter, target?.id]);

    const entryMap = useMemo(
        () =>
            new Map(
                (catalog?.entries ?? []).map((entry) => [entry.entry, entry]),
            ),
        [catalog],
    );

    const flagRows = useMemo<FlagRow[]>(() => {
        if (!target) {
            return [];
        }
        const { parameters, variantPayloads, ignoredFeatures } =
            target.ignoredConfig;

        return flags.map((flag) => {
            const rules = ignoredFeatures.filter((rule) =>
                matchesIgnoreRule(flag, rule),
            );
            const scoped = (target.ignoredConfig.featureFields ?? []).find(
                (entry) => entry.feature === flag.name,
            );
            const ignored = [
                ...new Set([
                    ...parameters,
                    ...variantPayloads,
                    ...(scoped?.parameters ?? []),
                    ...(scoped?.variantPayloads ?? []),
                ]),
            ].filter(
                (entry) =>
                    entryMap.get(entry)?.local?.valuesByFlag?.[flag.name] !==
                    undefined,
            );
            const status: FlagRow['status'] =
                rules.length > 0
                    ? 'excluded'
                    : ignored.length > 0
                      ? 'partial'
                      : 'none';
            return { flag, rules, ignored, status };
        });
    }, [target, flags, entryMap]);

    const jsonFlags = useMemo(() => {
        const set = new Set<string>();
        for (const entry of catalog?.entries ?? []) {
            if (!entry.entry.includes('::')) {
                continue;
            }
            for (const flag of [
                ...Object.keys(entry.local?.valuesByFlag ?? {}),
                ...Object.keys(entry.remote?.valuesByFlag ?? {}),
            ]) {
                set.add(flag);
            }
        }
        for (const field of target?.ignoredConfig.featureFields ?? []) {
            set.add(field.feature);
        }
        return set;
    }, [catalog, target]);

    const excludedRows = flagRows.filter((row) => row.status === 'excluded');
    const partialRows = flagRows.filter((row) => row.status === 'partial');

    const visibleRows = useMemo(() => {
        const term = search.trim().toLowerCase();
        return flagRows.filter((row) => {
            if (onlyConfigured && row.status === 'none') {
                return false;
            }
            if (!term) {
                return true;
            }
            return (
                row.flag.name.toLowerCase().includes(term) ||
                row.flag.tags.some((tag) => tag.toLowerCase().includes(term))
            );
        });
    }, [flagRows, onlyConfigured, search]);

    // A filter can shrink the list below the current page. Clamp instead of
    // slicing an empty window, which would show "no flags match" even though
    // the filter matched rows on earlier pages.
    const pageCount = Math.max(1, Math.ceil(visibleRows.length / rowsPerPage));
    const currentPage = Math.min(page, pageCount - 1);
    const pagedRows = visibleRows.slice(
        currentPage * rowsPerPage,
        currentPage * rowsPerPage + rowsPerPage,
    );

    const configuredEntries = target
        ? [
              ...target.ignoredConfig.parameters,
              ...target.ignoredConfig.variantPayloads,
          ]
        : [];

    const displayEntry = (entry: string): string => {
        const separator = entry.indexOf('::');
        if (separator === -1) {
            return entry === '*' ? 'All variant payloads' : entry;
        }
        const base = entry.slice(0, separator);
        const path = entry.slice(separator + 2);
        const readable = path
            .split('/')
            .filter(Boolean)
            .reduce((label, segment) => {
                if (segment === '*') {
                    return label ? `${label}[]` : '[]';
                }
                return label ? `${label}.${segment}` : segment;
            }, '');
        return base === '*' ? readable : `${base} › ${readable}`;
    };

    const valueGroups = [
        ...(configuredEntries.length > 0
            ? [
                  {
                      key: 'global',
                      label: 'All flags',
                      feature: undefined as string | undefined,
                      entries: configuredEntries,
                  },
              ]
            : []),
        ...(target?.ignoredConfig.featureFields ?? [])
            .map((field) => ({
                key: field.feature,
                label: field.feature,
                feature: field.feature as string | undefined,
                entries: [...field.parameters, ...field.variantPayloads],
            }))
            .filter((group) => group.entries.length > 0),
    ];
    const totalValueEntries = valueGroups.reduce(
        (total, group) => total + group.entries.length,
        0,
    );
    const canToggleValues = totalValueEntries > 10 || valueGroups.length > 5;

    const saveIgnored = async (ignoredConfig: EnvironmentSyncIgnoredConfig) => {
        if (!target) {
            return;
        }
        setSaving(true);
        try {
            // The API replaces the whole config, so every list must be sent
            // even when it is empty; otherwise the omission deletes entries.
            await updateTargetIgnoredConfig(target.id, {
                ...ignoredConfig,
                featureFields: ignoredConfig.featureFields ?? [],
            });
            await refetchTargets();
            setToastData({ type: 'success', text: 'Configuration saved' });
        } catch (error) {
            setToastApiError(formatUnknownError(error));
        } finally {
            setSaving(false);
        }
    };

    const saveDraft = async () => {
        if (!target) {
            return;
        }
        if (featureFilter) {
            const featureFields = (
                target.ignoredConfig.featureFields ?? []
            ).filter((entry) => entry.feature !== featureFilter);
            if (draftParameters.length > 0 || draftPayloads.length > 0) {
                featureFields.push({
                    feature: featureFilter,
                    parameters: draftParameters,
                    variantPayloads: draftPayloads,
                });
            }
            featureFields.sort((a, b) => a.feature.localeCompare(b.feature));
            await saveIgnored({
                ...target.ignoredConfig,
                featureFields,
            });
        } else {
            await saveIgnored({
                ...target.ignoredConfig,
                parameters: draftParameters,
                variantPayloads: draftPayloads,
                ignoredFeatures: draftFeatures,
                featureFields: draftFeatureFields,
            });
        }
        setEditing(false);
    };

    const toggleFlag = async (row: FlagRow) => {
        if (!target) {
            return;
        }
        if (row.rules.some((rule) => rule !== row.flag.name)) {
            return;
        }
        const next = row.rules.includes(row.flag.name)
            ? target.ignoredConfig.ignoredFeatures.filter(
                  (rule) => rule !== row.flag.name,
              )
            : [...target.ignoredConfig.ignoredFeatures, row.flag.name];
        await saveIgnored({
            ...target.ignoredConfig,
            ignoredFeatures: next,
            featureFields: target.ignoredConfig.featureFields ?? [],
        });
    };

    const exportConfig = () => {
        if (!target) {
            return;
        }
        const payload = {
            version: 1,
            ...target.ignoredConfig,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `environment-sync-${target.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const importConfig = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) {
            return;
        }
        try {
            const parsed = parseImportedConfig(JSON.parse(await file.text()));
            await saveIgnored(parsed);
        } catch (error) {
            setToastApiError(
                `Could not import the file: ${formatUnknownError(error)}`,
            );
        }
    };

    const close = () => {
        if (onClose) {
            onClose();
        } else {
            navigate('/admin/environment-sync');
        }
    };

    const shell = (content: ReactNode) =>
        panel ? (
            <Box sx={{ p: 3 }}>{content}</Box>
        ) : (
            <PageContent header={<PageHeader title='Environment sync' />}>
                {content}
            </PageContent>
        );

    if (targetsError) {
        return shell(
            <Alert severity='error'>{formatUnknownError(targetsError)}</Alert>,
        );
    }

    if (targetsLoading) {
        return shell(<CircularProgress size={24} />);
    }

    if (!target) {
        return shell(
            <Alert severity='warning'>
                This environment does not exist.{' '}
                <Button size='small' onClick={close}>
                    Back to environment sync
                </Button>
            </Alert>,
        );
    }

    const dataActions = (
        <>
            <Button
                size='small'
                variant='outlined'
                startIcon={<DownloadIcon />}
                onClick={exportConfig}
            >
                Export
            </Button>
            <Button
                size='small'
                variant='outlined'
                component='label'
                startIcon={<UploadIcon />}
            >
                Import
                <input
                    type='file'
                    accept='application/json,.json'
                    hidden
                    onChange={importConfig}
                />
            </Button>
        </>
    );

    const editActions = editing ? (
        <>
            <Button
                size='small'
                variant='outlined'
                onClick={() => setEditing(false)}
                disabled={saving}
            >
                Cancel
            </Button>
            <Button
                size='small'
                variant='contained'
                onClick={saveDraft}
                disabled={saving}
            >
                {saving ? 'Saving…' : 'Save'}
            </Button>
        </>
    ) : (
        <Button
            size='small'
            variant='contained'
            onClick={() => setEditing(true)}
        >
            Edit configuration
        </Button>
    );

    const actions = (
        <Box
            sx={{
                display: 'flex',
                gap: 1,
                flexWrap: 'wrap',
                alignItems: 'center',
            }}
        >
            {!panel && (
                <Button
                    size='small'
                    startIcon={<ArrowBackIcon />}
                    onClick={close}
                >
                    Back
                </Button>
            )}
            {dataActions}
            {editActions}
        </Box>
    );

    const body = (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {!catalogLoading && catalogError && (
                <Alert severity='warning'>
                    Could not load the field catalog:{' '}
                    {formatUnknownError(catalogError)}
                </Alert>
            )}

            {editing ? (
                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                    }}
                >
                    <Tabs
                        value={editTab}
                        onChange={(_event, value) => setEditTab(value)}
                        sx={{
                            borderBottom: (theme) =>
                                `1px solid ${theme.palette.divider}`,
                        }}
                    >
                        <Tab label='Values that may differ' />
                        <Tab
                            label={`Excluded flags${
                                draftFeatures.length > 0
                                    ? ` (${draftFeatures.length})`
                                    : ''
                            }`}
                        />
                    </Tabs>

                    {editTab === 0 ? (
                        <EnvironmentSyncCatalogPicker
                            catalog={catalog}
                            loading={catalogLoading}
                            error={
                                catalogError
                                    ? formatUnknownError(catalogError)
                                    : undefined
                            }
                            parameters={draftParameters}
                            variantPayloads={draftPayloads}
                            sourceEnvironment={target.sourceEnvironment}
                            targetEnvironment={target.targetEnvironment}
                            featureFilter={featureFilter}
                            featureFields={draftFeatureFields}
                            onFeatureFieldsChange={setDraftFeatureFields}
                            initialFlag={flagToEdit}
                            onClearFeatureFilter={onClearFeatureFilter}
                            onChange={(parameters, variantPayloads) => {
                                setDraftParameters(parameters);
                                setDraftPayloads(variantPayloads);
                            }}
                        />
                    ) : (
                        <Box
                            sx={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 2,
                            }}
                        >
                            <Typography variant='body2' color='text.secondary'>
                                Excluded flags are never compared or synced. Add
                                exact names, globs (<code>legacy-*</code>) or
                                tag rules (<code>tag:no-env-sync</code>).
                            </Typography>
                            <AutocompleteField
                                multiple
                                freeSolo
                                options={flags.map((flag) => flag.name)}
                                label='Excluded flags and rules'
                                placeholder='Search a flag or type a rule'
                                value={draftFeatures}
                                onChange={(_event, value) =>
                                    setDraftFeatures(
                                        normalizeEntries(value as string[]),
                                    )
                                }
                            />
                            {draftFeatures.length === 0 ? (
                                <Typography
                                    variant='body2'
                                    color='text.secondary'
                                >
                                    No flags are excluded.
                                </Typography>
                            ) : (
                                <Box
                                    sx={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 1,
                                    }}
                                >
                                    <Typography
                                        variant='caption'
                                        color='text.secondary'
                                    >
                                        {
                                            flags.filter((flag) =>
                                                draftFeatures.some((rule) =>
                                                    matchesIgnoreRule(
                                                        flag,
                                                        rule,
                                                    ),
                                                ),
                                            ).length
                                        }{' '}
                                        of {flags.length} flags match these
                                        rules
                                    </Typography>
                                    <Box
                                        sx={{
                                            display: 'flex',
                                            gap: 1,
                                            flexWrap: 'wrap',
                                        }}
                                    >
                                        {flags
                                            .filter((flag) =>
                                                draftFeatures.some((rule) =>
                                                    matchesIgnoreRule(
                                                        flag,
                                                        rule,
                                                    ),
                                                ),
                                            )
                                            .slice(0, 50)
                                            .map((flag) => (
                                                <Chip
                                                    key={flag.name}
                                                    size='small'
                                                    label={flag.name}
                                                />
                                            ))}
                                    </Box>
                                </Box>
                            )}
                        </Box>
                    )}
                </Box>
            ) : (
                <>
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: {
                                xs: '1fr',
                                md: '1fr 1fr',
                            },
                            gap: 3,
                        }}
                    >
                        <Box
                            sx={{
                                border: (theme) =>
                                    `1px solid ${theme.palette.divider}`,
                                borderRadius: 1,
                                p: 2,
                            }}
                        >
                            <Box
                                sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 1,
                                    mb: 1,
                                }}
                            >
                                <Typography sx={{ fontWeight: 600 }}>
                                    Environment-specific values
                                </Typography>
                                {canToggleValues && (
                                    <Button
                                        size='small'
                                        onClick={() =>
                                            setShowAllValues(!showAllValues)
                                        }
                                    >
                                        {showAllValues
                                            ? 'Show less'
                                            : `Show all (${totalValueEntries})`}
                                    </Button>
                                )}
                            </Box>
                            {valueGroups.length === 0 ? (
                                <Typography
                                    variant='body2'
                                    color='text.secondary'
                                >
                                    No values configured. Everything is compared
                                    and synced.
                                </Typography>
                            ) : (
                                <Box
                                    sx={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 1,
                                        maxHeight: showAllValues
                                            ? 340
                                            : undefined,
                                        overflowY: showAllValues
                                            ? 'auto'
                                            : 'visible',
                                        pr: showAllValues ? 1 : 0,
                                    }}
                                >
                                    {valueGroups.map((group) => {
                                        const project = group.feature
                                            ? flags.find(
                                                  (flag) =>
                                                      flag.name ===
                                                      group.feature,
                                              )?.project
                                            : undefined;
                                        return (
                                            <Box
                                                key={group.key}
                                                sx={{
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    gap: 0.75,
                                                }}
                                            >
                                                <Box
                                                    sx={{
                                                        display: 'flex',
                                                        gap: 1,
                                                        alignItems: 'baseline',
                                                    }}
                                                >
                                                    {group.feature &&
                                                    project ? (
                                                        <QuietLink
                                                            to={`/projects/${project}/features/${group.feature}`}
                                                        >
                                                            {group.label}
                                                        </QuietLink>
                                                    ) : (
                                                        <Typography
                                                            variant='body2'
                                                            sx={{
                                                                fontWeight: 600,
                                                            }}
                                                        >
                                                            {group.label}
                                                        </Typography>
                                                    )}
                                                    <Typography
                                                        variant='caption'
                                                        color='text.secondary'
                                                    >
                                                        {group.entries.length}{' '}
                                                        {group.entries
                                                            .length === 1
                                                            ? 'field'
                                                            : 'fields'}
                                                    </Typography>
                                                </Box>
                                                <Box
                                                    sx={{
                                                        display: 'flex',
                                                        gap: 1,
                                                        flexWrap: 'wrap',
                                                        pl: 1,
                                                    }}
                                                >
                                                    {(showAllValues
                                                        ? group.entries
                                                        : group.entries.slice(
                                                              0,
                                                              5,
                                                          )
                                                    ).map((entry) => (
                                                        <Chip
                                                            key={entry}
                                                            size='small'
                                                            label={displayEntry(
                                                                entry,
                                                            )}
                                                        />
                                                    ))}
                                                    {!showAllValues &&
                                                        group.entries.length >
                                                            5 && (
                                                            <Typography
                                                                variant='caption'
                                                                color='text.secondary'
                                                            >
                                                                +
                                                                {group.entries
                                                                    .length -
                                                                    5}{' '}
                                                                more
                                                            </Typography>
                                                        )}
                                                </Box>
                                            </Box>
                                        );
                                    })}
                                </Box>
                            )}
                        </Box>

                        <Box
                            sx={{
                                border: (theme) =>
                                    `1px solid ${theme.palette.divider}`,
                                borderRadius: 1,
                                p: 2,
                            }}
                        >
                            <Typography sx={{ fontWeight: 600, mb: 1 }}>
                                Excluded flags
                            </Typography>
                            <Typography
                                variant='body2'
                                color='text.secondary'
                                sx={{ mb: 1 }}
                            >
                                {excludedRows.length} of {flagRows.length} flags
                                are excluded entirely from this sync.
                            </Typography>
                            <Box
                                sx={{
                                    display: 'flex',
                                    gap: 1,
                                    flexWrap: 'wrap',
                                    maxHeight: 160,
                                    overflow: 'auto',
                                }}
                            >
                                {excludedRows.length === 0 ? (
                                    <Typography
                                        variant='body2'
                                        color='text.secondary'
                                    >
                                        No flags are excluded.
                                    </Typography>
                                ) : (
                                    excludedRows.map((row) => (
                                        <Chip
                                            key={row.flag.name}
                                            size='small'
                                            label={row.flag.name}
                                            title={flagRuleLabel(row)}
                                        />
                                    ))
                                )}
                            </Box>
                        </Box>
                    </Box>

                    <Box
                        sx={{
                            display: 'flex',
                            gap: 2,
                            alignItems: 'center',
                            flexWrap: 'wrap',
                        }}
                    >
                        <Box sx={{ flex: 1, minWidth: 240 }}>
                            <Input
                                label='Search flags'
                                placeholder='name or tag'
                                value={search}
                                onChange={(event) => {
                                    setSearch(event.target.value);
                                    setPage(0);
                                }}
                                fullWidth
                            />
                        </Box>
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={onlyConfigured}
                                    onChange={(event) => {
                                        setOnlyConfigured(event.target.checked);
                                        setPage(0);
                                    }}
                                />
                            }
                            label='Only excluded or partially excluded'
                        />
                        {!catalogLoading && !catalogError && (
                            <Badge color='neutral'>
                                {partialRows.length} partially excluded
                            </Badge>
                        )}
                    </Box>

                    <Table size='small'>
                        <TableHead>
                            <TableRow>
                                <TableCell>Flag</TableCell>
                                <TableCell>Project</TableCell>
                                <TableCell>State</TableCell>
                                <TableCell>Reason</TableCell>
                                <TableCell>Ignored fields</TableCell>
                                <TableCell align='right'>Edit</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {pagedRows.map((row) => {
                                const ruleBound = row.rules.some(
                                    (rule) => rule !== row.flag.name,
                                );
                                const exact = row.rules.includes(row.flag.name);
                                return (
                                    <TableRow key={row.flag.name} hover>
                                        <TableCell
                                            sx={{ whiteSpace: 'nowrap' }}
                                        >
                                            <QuietLink
                                                to={`/projects/${
                                                    row.flag.project ??
                                                    'default'
                                                }/features/${row.flag.name}`}
                                            >
                                                {row.flag.name}
                                            </QuietLink>
                                        </TableCell>
                                        <TableCell
                                            sx={{ whiteSpace: 'nowrap' }}
                                        >
                                            {row.flag.project ?? '—'}
                                        </TableCell>
                                        <TableCell
                                            sx={{ whiteSpace: 'nowrap' }}
                                        >
                                            {row.status === 'excluded' ? (
                                                <Badge color='neutral'>
                                                    Entire flag
                                                </Badge>
                                            ) : row.status === 'partial' ? (
                                                <Badge color='warning'>
                                                    Partial
                                                </Badge>
                                            ) : (
                                                <Badge color='success'>
                                                    Synced
                                                </Badge>
                                            )}
                                        </TableCell>
                                        <TableCell
                                            sx={{ whiteSpace: 'nowrap' }}
                                        >
                                            {flagRuleLabel(row)}
                                        </TableCell>
                                        <TableCell>
                                            {row.ignored.length === 0 ? (
                                                '—'
                                            ) : (
                                                <Tooltip
                                                    title={row.ignored.join(
                                                        ', ',
                                                    )}
                                                >
                                                    <span>
                                                        {row.ignored.length}{' '}
                                                        {row.ignored.length ===
                                                        1
                                                            ? 'field'
                                                            : 'fields'}
                                                    </span>
                                                </Tooltip>
                                            )}
                                        </TableCell>
                                        <TableCell align='right'>
                                            <Box
                                                sx={{
                                                    display: 'flex',
                                                    justifyContent: 'flex-end',
                                                    alignItems: 'center',
                                                    gap: 1,
                                                }}
                                            >
                                                {row.status !== 'excluded' &&
                                                    jsonFlags.has(
                                                        row.flag.name,
                                                    ) && (
                                                        <Button
                                                            size='small'
                                                            variant='outlined'
                                                            onClick={() => {
                                                                setFlagToEdit(
                                                                    row.flag
                                                                        .name,
                                                                );
                                                                setEditTab(0);
                                                                setEditing(
                                                                    true,
                                                                );
                                                            }}
                                                        >
                                                            Fields
                                                        </Button>
                                                    )}
                                                <Tooltip
                                                    title={
                                                        ruleBound
                                                            ? `Excluded by rule ${row.rules[0]}. Edit the rules above.`
                                                            : exact
                                                              ? 'Include this flag in sync'
                                                              : 'Exclude this flag from sync'
                                                    }
                                                >
                                                    <span>
                                                        <Button
                                                            size='small'
                                                            disabled={
                                                                ruleBound ||
                                                                saving
                                                            }
                                                            onClick={() =>
                                                                toggleFlag(row)
                                                            }
                                                        >
                                                            {exact
                                                                ? 'Include'
                                                                : 'Exclude'}
                                                        </Button>
                                                    </span>
                                                </Tooltip>
                                            </Box>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                            {pagedRows.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={6}>
                                        <Typography
                                            variant='body2'
                                            color='text.secondary'
                                        >
                                            No flags match the current filter.
                                        </Typography>
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                    <TablePagination
                        component='div'
                        count={visibleRows.length}
                        page={currentPage}
                        onPageChange={(_event, nextPage) => setPage(nextPage)}
                        rowsPerPage={rowsPerPage}
                        onRowsPerPageChange={(event) => {
                            setRowsPerPage(Number(event.target.value));
                            setPage(0);
                        }}
                        rowsPerPageOptions={[25, 50, 100]}
                    />
                </>
            )}
        </Box>
    );

    if (panel) {
        return (
            <Box
                sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: '100%',
                }}
            >
                <Box
                    sx={{
                        position: 'sticky',
                        top: 0,
                        zIndex: 2,
                        backgroundColor: 'background.paper',
                        px: 3,
                        py: 2,
                        pr: 7,
                        borderBottom: (theme) =>
                            `1px solid ${theme.palette.divider}`,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1,
                    }}
                >
                    <Typography variant='h3'>
                        {target.name} · configuration
                    </Typography>
                    <Typography variant='body2' color='text.secondary'>
                        {target.url} · {target.sourceEnvironment} →{' '}
                        {target.targetEnvironment}
                    </Typography>
                    <Box
                        sx={{
                            display: 'flex',
                            gap: 1,
                            flexWrap: 'wrap',
                            alignItems: 'center',
                            mt: 1,
                        }}
                    >
                        {dataActions}
                        <Box sx={{ flex: 1 }} />
                        {editActions}
                    </Box>
                </Box>
                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        p: 3,
                    }}
                >
                    {body}
                </Box>
            </Box>
        );
    }

    return (
        <PageContent
            header={
                <PageHeader
                    title={`${target.name} · configuration`}
                    subtitle={`${target.url} · ${target.sourceEnvironment} → ${target.targetEnvironment}`}
                    actions={actions}
                />
            }
        >
            {body}
        </PageContent>
    );
};
