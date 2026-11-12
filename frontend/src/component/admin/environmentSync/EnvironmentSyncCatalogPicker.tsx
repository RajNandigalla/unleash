import { useCallback, useMemo, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    FormControl,
    FormControlLabel,
    FormLabel,
    Radio,
    RadioGroup,
    Switch,
    Typography,
} from '@mui/material';
import { AutocompleteField } from 'component/common/AutocompleteField/AutocompleteField';
import { Badge } from 'component/common/Badge/Badge';
import type {
    EnvironmentSyncCatalogEntryView,
    EnvironmentSyncCatalogKind,
    EnvironmentSyncCatalogView,
    EnvironmentSyncFeatureFields,
} from 'interfaces/environmentSync';

type EnvironmentSyncCatalogPickerProps = {
    catalog?: EnvironmentSyncCatalogView;
    loading: boolean;
    error?: string;
    parameters: string[];
    variantPayloads: string[];
    sourceEnvironment?: string;
    targetEnvironment?: string;
    featureFilter?: string;
    onClearFeatureFilter?: () => void;
    featureFields?: EnvironmentSyncFeatureFields[];
    onFeatureFieldsChange?: (next: EnvironmentSyncFeatureFields[]) => void;
    initialFlag?: string;
    onChange: (parameters: string[], variantPayloads: string[]) => void;
};

interface PathOption {
    entry: string;
    kind: EnvironmentSyncCatalogKind;
    base: string;
    path: string | null;
    label: string;
    differs: boolean;
}

interface FlagOption {
    name: string;
    selectedCount: number;
}

const splitEntry = (entry: string): { base: string; path: string | null } => {
    const separator = entry.indexOf('::');
    if (separator === -1) {
        return { base: entry, path: null };
    }
    return {
        base: entry.slice(0, separator),
        path: entry.slice(separator + 2),
    };
};

const baseLabel = (base: string): string =>
    base === '*' ? 'All variant payloads' : base;

const displayPath = (pointer: string): string =>
    pointer
        .split('/')
        .filter(Boolean)
        .reduce((label, segment) => {
            if (segment === '*') {
                return label ? `${label}[]` : '[]';
            }
            return label ? `${label}.${segment}` : segment;
        }, '');

const pathLabel = (base: string, path: string): string =>
    base === '*' ? displayPath(path) : `${base} › ${displayPath(path)}`;

const isDescendant = (entry: string, ancestor: string): boolean => {
    if (ancestor.includes('::')) {
        return entry.startsWith(`${ancestor}/`);
    }
    return entry.startsWith(`${ancestor}::`);
};

const normalize = (entries: string[]): string[] => {
    const unique = [...new Set(entries)];
    return unique.filter(
        (entry) =>
            !unique.some(
                (other) => other !== entry && isDescendant(entry, other),
            ),
    );
};

const flagValues = (
    entry: EnvironmentSyncCatalogEntryView,
    flag: string,
): { local?: string; remote?: string } => ({
    local: entry.local?.valuesByFlag?.[flag],
    remote: entry.remote?.valuesByFlag?.[flag],
});

const hasFlagValue = (
    entry: EnvironmentSyncCatalogEntryView,
    flag: string,
): boolean => {
    const { local, remote } = flagValues(entry, flag);
    return local !== undefined || remote !== undefined;
};

export const EnvironmentSyncCatalogPicker = ({
    catalog,
    loading,
    error,
    parameters,
    variantPayloads,
    featureFilter,
    onClearFeatureFilter,
    featureFields,
    onFeatureFieldsChange,
    initialFlag,
    onChange,
}: EnvironmentSyncCatalogPickerProps) => {
    const [onlyDiffers, setOnlyDiffers] = useState(false);
    const [payloadMode, setPayloadMode] = useState<'all' | 'fields'>(
        variantPayloads.includes('*') ? 'all' : 'fields',
    );
    const [activeFlagName, setActiveFlagName] = useState<string | undefined>(
        initialFlag,
    );
    const [showAllConfigured, setShowAllConfigured] = useState(false);

    const entries = useMemo(() => {
        if (!featureFilter) {
            return catalog?.entries ?? [];
        }
        return (catalog?.entries ?? []).filter((entry) => {
            if (entry.kind !== 'variantPayload') {
                return false;
            }
            const local = entry.local?.valuesByFlag ?? {};
            const remote = entry.remote?.valuesByFlag ?? {};
            return featureFilter in local || featureFilter in remote;
        });
    }, [catalog, featureFilter]);

    const kindFor = useCallback(
        (entry: string): EnvironmentSyncCatalogKind => {
            const { base } = splitEntry(entry);
            if (base === '*') {
                return 'variantPayload';
            }
            const found = (catalog?.entries ?? []).find(
                (candidate) => splitEntry(candidate.entry).base === base,
            );
            return found?.kind ?? 'parameter';
        },
        [catalog],
    );

    const effectiveDiffers = useCallback(
        (entry: EnvironmentSyncCatalogEntryView): boolean => {
            if (!featureFilter) {
                return entry.differs;
            }
            const local = entry.local?.valuesByFlag?.[featureFilter];
            const remote = entry.remote?.valuesByFlag?.[featureFilter];
            return (local ?? null) !== (remote ?? null);
        },
        [featureFilter],
    );

    // --- Admin mode: flag names, then that flag's paths --------------------
    const flags = useMemo<FlagOption[]>(() => {
        const map = new Map<string, number>();
        for (const entry of entries) {
            if (splitEntry(entry.entry).path === null) {
                continue;
            }
            for (const flag of [
                ...Object.keys(entry.local?.valuesByFlag ?? {}),
                ...Object.keys(entry.remote?.valuesByFlag ?? {}),
            ]) {
                map.set(flag, map.get(flag) ?? 0);
            }
        }
        for (const field of featureFields ?? []) {
            map.set(field.feature, map.get(field.feature) ?? 0);
        }
        return [...map.keys()]
            .sort((a, b) => a.localeCompare(b))
            .map((name) => {
                const field = (featureFields ?? []).find(
                    (candidate) => candidate.feature === name,
                );
                return {
                    name,
                    selectedCount:
                        (field?.parameters.length ?? 0) +
                        (field?.variantPayloads.length ?? 0),
                };
            });
    }, [entries, featureFields]);

    const activeFlag =
        flags.find((flag) => flag.name === activeFlagName) ??
        flags.find((flag) => flag.selectedCount > 0) ??
        flags[0];

    const activeFlagFields = activeFlag
        ? (featureFields ?? []).find(
              (field) => field.feature === activeFlag.name,
          )
        : undefined;

    const flagEntries = useMemo(
        () =>
            activeFlag
                ? entries.filter((entry) =>
                      hasFlagValue(entry, activeFlag.name),
                  )
                : [],
        [activeFlag, entries],
    );

    const flagPathOptions = useMemo(() => {
        if (!activeFlag) {
            return [];
        }
        const map = new Map<string, PathOption>();
        for (const entry of flagEntries) {
            const { base, path } = splitEntry(entry.entry);
            if (!map.has(base)) {
                map.set(base, {
                    entry: base,
                    kind: entry.kind,
                    base,
                    path: null,
                    label: baseLabel(base),
                    differs: false,
                });
            }
            if (path !== null) {
                map.set(entry.entry, {
                    entry: entry.entry,
                    kind: entry.kind,
                    base,
                    path,
                    label: pathLabel(base, path),
                    differs:
                        flagValues(entry, activeFlag.name).local !==
                        flagValues(entry, activeFlag.name).remote,
                });
            }
        }
        const wholeEntries = flagEntries.filter(
            (entry) => splitEntry(entry.entry).path === null,
        );
        for (const option of map.values()) {
            if (option.path === null) {
                const matches = wholeEntries.filter(
                    (entry) =>
                        entry.kind === option.kind &&
                        splitEntry(entry.entry).base === option.base,
                );
                option.differs = matches.some((entry) => entry.differs);
            }
        }
        return [...map.values()];
    }, [activeFlag, flagEntries]);

    const flagSelectedEntries = useMemo(() => {
        if (!activeFlagFields) {
            return [];
        }
        return [
            ...activeFlagFields.parameters,
            ...activeFlagFields.variantPayloads,
        ];
    }, [activeFlagFields]);

    const flagSelectedOptions = flagSelectedEntries.map(
        (entry): PathOption =>
            flagPathOptions.find((option) => option.entry === entry) ?? {
                entry,
                kind: kindFor(entry),
                base: splitEntry(entry).base,
                path: splitEntry(entry).path,
                label: entry,
                differs: false,
            },
    );

    const handleFlagChange = (next: PathOption[]) => {
        if (!activeFlag || !onFeatureFieldsChange) {
            return;
        }
        const normalized = normalize(next.map((option) => option.entry));
        const nextParameters = normalized.filter(
            (entry) => kindFor(entry) === 'parameter',
        );
        const nextPayloads = normalized.filter(
            (entry) => kindFor(entry) === 'variantPayload',
        );
        const others = (featureFields ?? []).filter(
            (field) => field.feature !== activeFlag.name,
        );
        const nextFields =
            nextParameters.length > 0 || nextPayloads.length > 0
                ? [
                      ...others,
                      {
                          feature: activeFlag.name,
                          parameters: nextParameters,
                          variantPayloads: nextPayloads,
                      },
                  ]
                : others;
        onFeatureFieldsChange(
            nextFields.sort((a, b) => a.feature.localeCompare(b.feature)),
        );
    };

    // --- Flag-scoped mode: payloads of one flag ----------------------------
    const scopedOptions = useMemo(() => {
        if (!featureFilter) {
            return [];
        }
        const map = new Map<string, PathOption>();
        for (const entry of entries) {
            const { base, path } = splitEntry(entry.entry);
            if (path === null) {
                continue;
            }
            map.set(entry.entry, {
                entry: entry.entry,
                kind: entry.kind,
                base,
                path,
                label: displayPath(path),
                differs: effectiveDiffers(entry),
            });
        }
        return [...map.values()];
    }, [effectiveDiffers, entries, featureFilter]);

    const scopedSelectedOptions = variantPayloads
        .filter((entry) => entry !== '*')
        .map(
            (entry): PathOption =>
                scopedOptions.find((option) => option.entry === entry) ?? {
                    entry,
                    kind: kindFor(entry),
                    base: splitEntry(entry).base,
                    path: splitEntry(entry).path,
                    label: entry,
                    differs: false,
                },
        );

    const handleScopedChange = (next: PathOption[]) => {
        const normalized = normalize(next.map((option) => option.entry));
        onChange(parameters, normalized);
    };

    const changePayloadMode = (mode: 'all' | 'fields') => {
        setPayloadMode(mode);
        if (mode === 'all') {
            onChange(parameters, ['*']);
        } else {
            onChange(
                parameters,
                variantPayloads.filter((entry) => entry !== '*'),
            );
        }
    };

    const hasSelectedAncestor = (option: PathOption): boolean =>
        (featureFilter ? scopedSelectedOptions : flagSelectedOptions).some(
            (selected) =>
                selected.entry !== option.entry &&
                isDescendant(option.entry, selected.entry),
        );

    const parentValueSelected = (
        featureFilter ? scopedOptions : flagPathOptions
    ).some((option) => hasSelectedAncestor(option));

    const displayEntry = (entry: string): string => {
        const { base, path } = splitEntry(entry);
        return path === null ? baseLabel(base) : pathLabel(base, path);
    };

    const removeEntry = (entry: string) => {
        if (featureFilter) {
            onChange(
                parameters,
                variantPayloads.filter((item) => item !== entry),
            );
            return;
        }
        if (!activeFlag || !onFeatureFieldsChange) {
            return;
        }
        const others = (featureFields ?? []).filter(
            (field) => field.feature !== activeFlag.name,
        );
        const remaining = flagSelectedEntries.filter((item) => item !== entry);
        const nextParameters = remaining.filter(
            (item) => kindFor(item) === 'parameter',
        );
        const nextPayloads = remaining.filter(
            (item) => kindFor(item) === 'variantPayload',
        );
        onFeatureFieldsChange(
            (nextParameters.length > 0 || nextPayloads.length > 0
                ? [
                      ...others,
                      {
                          feature: activeFlag.name,
                          parameters: nextParameters,
                          variantPayloads: nextPayloads,
                      },
                  ]
                : others
            ).sort((a, b) => a.feature.localeCompare(b.feature)),
        );
    };

    const configuredFlags = flags.filter((flag) => flag.selectedCount > 0);
    const visibleConfiguredFlags = showAllConfigured
        ? configuredFlags
        : configuredFlags.slice(0, 5);
    const totalConfiguredEntries = configuredFlags.reduce(
        (total, flag) => total + flag.selectedCount,
        0,
    );
    const canToggleConfigured =
        totalConfiguredEntries > 10 || configuredFlags.length > 5;

    if (loading) {
        return (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <CircularProgress size={18} />
                <Typography variant='body2'>
                    Scanning environments for values…
                </Typography>
            </Box>
        );
    }

    if (error) {
        return <Alert severity='error'>{error}</Alert>;
    }

    if (!catalog) {
        return null;
    }

    const showFields = !featureFilter || payloadMode === 'fields';
    const pathOptions = featureFilter ? scopedOptions : flagPathOptions;
    const visibleOptions = pathOptions.filter(
        (option) => !onlyDiffers || option.differs,
    );
    const selectedOptions = featureFilter
        ? scopedSelectedOptions
        : flagSelectedOptions;
    const differing = pathOptions.filter((option) => option.differs).length;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
                <Typography sx={{ fontWeight: 600, mb: 0.5 }}>
                    Fields that may differ per environment
                </Typography>
                {featureFilter ? (
                    <Typography variant='body2' color='text.secondary'>
                        Search a field and select it — it stays as-is in the
                        target and is ignored when comparing environments.
                        <br />
                        <code>sso.loginUrl</code> — that field inside a nested
                        object.
                        <br />
                        <code>[].componentProps.name</code> — that field on
                        every item of an array; <code>[]</code> covers all items
                        with one entry.
                    </Typography>
                ) : (
                    <Typography variant='body2' color='text.secondary'>
                        Pick a flag with JSON values, then search only its
                        paths. Flags without JSON fields are not listed;
                        exclusions selected here are saved against the flag.
                    </Typography>
                )}
            </Box>

            {featureFilter && parameters.length > 0 && (
                <Alert severity='info'>
                    This flag also has {parameters.length} strategy-parameter
                    exclusion{parameters.length === 1 ? '' : 's'} configured.
                    They are saved with the flag.
                </Alert>
            )}

            {catalog.remoteError && (
                <Alert severity='warning'>
                    Could not compare with the target: {catalog.remoteError}
                </Alert>
            )}
            {!catalog.comparedWithTarget && (
                <Alert severity='info'>
                    Save this environment to compare values with the target.
                    Showing source values only.
                </Alert>
            )}
            {catalog.truncated && (
                <Alert severity='info'>
                    Some JSON values are too large to list. Exclude the whole
                    value instead, or reduce the size of the JSON.
                </Alert>
            )}

            {featureFilter && (
                <Alert
                    severity='info'
                    action={
                        <Button
                            size='small'
                            color='inherit'
                            onClick={onClearFeatureFilter}
                        >
                            Show all fields
                        </Button>
                    }
                >
                    Editing fields for <strong>{featureFilter}</strong> only.
                    The values below are this flag's.
                </Alert>
            )}

            {featureFilter && (
                <FormControl>
                    <FormLabel>
                        What should stay environment-specific?
                    </FormLabel>
                    <RadioGroup
                        row
                        value={payloadMode}
                        onChange={(event) =>
                            changePayloadMode(
                                event.target.value as 'all' | 'fields',
                            )
                        }
                    >
                        <FormControlLabel
                            value='all'
                            control={<Radio size='small' />}
                            label='All variant payloads'
                        />
                        <FormControlLabel
                            value='fields'
                            control={<Radio size='small' />}
                            label='Individual fields'
                        />
                    </RadioGroup>
                </FormControl>
            )}

            {featureFilter && payloadMode === 'all' && (
                <Alert severity='info'>
                    All variant payloads are excluded for this flag. They stay
                    as-is in the target; switch to “Individual fields” to pick
                    specific paths.
                </Alert>
            )}

            {!featureFilter && !activeFlag && (
                <Typography variant='body2' color='text.secondary'>
                    No flags with JSON fields were detected.
                </Typography>
            )}

            {!featureFilter && activeFlag && (
                <AutocompleteField
                    label='Flag'
                    size='small'
                    options={flags}
                    value={activeFlag}
                    getOptionLabel={(flag) => flag.name}
                    isOptionEqualToValue={(a, b) => a.name === b.name}
                    onChange={(_, next) => setActiveFlagName(next?.name)}
                />
            )}

            {showFields && (
                <AutocompleteField
                    multiple
                    size='small'
                    label={
                        featureFilter
                            ? 'Search paths'
                            : `Paths in ${activeFlag?.name ?? 'this flag'}`
                    }
                    placeholder='label, componentProps, requestKey…'
                    options={visibleOptions}
                    value={selectedOptions}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(a, b) => a.entry === b.entry}
                    onChange={(_, next) =>
                        featureFilter
                            ? handleScopedChange(next)
                            : handleFlagChange(next)
                    }
                    filterOptions={(available, state) => {
                        const term = state.inputValue.trim().toLowerCase();
                        if (!term) {
                            return available;
                        }
                        return available.filter((option) =>
                            option.label.toLowerCase().includes(term),
                        );
                    }}
                    noOptionsText='No matching paths'
                    getOptionDisabled={hasSelectedAncestor}
                />
            )}

            {showFields && parentValueSelected && (
                <Typography variant='caption' color='text.secondary'>
                    A parent value is excluded — clear it to pick individual
                    fields.
                </Typography>
            )}

            {showFields && visibleOptions.length === 0 && (
                <Typography variant='body2' color='text.secondary'>
                    {onlyDiffers
                        ? 'No fields differ. Turn off the filter to see every detected value.'
                        : 'No matching paths.'}
                </Typography>
            )}

            {showFields && (
                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                    }}
                >
                    <FormControlLabel
                        control={
                            <Switch
                                checked={onlyDiffers}
                                onChange={(event) =>
                                    setOnlyDiffers(event.target.checked)
                                }
                            />
                        }
                        label='Only fields that differ'
                    />
                    <Badge
                        color={
                            selectedOptions.length > 0 ? 'success' : 'neutral'
                        }
                    >
                        {selectedOptions.length} selected
                    </Badge>
                    <Button
                        size='small'
                        variant='outlined'
                        onClick={() => {
                            const differingEntries = pathOptions
                                .filter(
                                    (option) =>
                                        option.path !== null && option.differs,
                                )
                                .map((option) => option.entry);
                            featureFilter
                                ? handleScopedChange(
                                      differingEntries.map(
                                          (entry) =>
                                              scopedOptions.find(
                                                  (option) =>
                                                      option.entry === entry,
                                              )!,
                                      ),
                                  )
                                : handleFlagChange(
                                      differingEntries.map(
                                          (entry) =>
                                              flagPathOptions.find(
                                                  (option) =>
                                                      option.entry === entry,
                                              )!,
                                      ),
                                  );
                        }}
                        disabled={differing === 0}
                    >
                        Select all differing
                    </Button>
                    <Button
                        size='small'
                        onClick={() => {
                            if (featureFilter) {
                                onChange(parameters, []);
                            } else if (activeFlag && onFeatureFieldsChange) {
                                onFeatureFieldsChange(
                                    (featureFields ?? []).filter(
                                        (field) =>
                                            field.feature !== activeFlag.name,
                                    ),
                                );
                            }
                        }}
                        disabled={selectedOptions.length === 0}
                    >
                        Clear
                    </Button>
                </Box>
            )}
            {!featureFilter && configuredFlags.length > 0 && (
                <Box
                    sx={(theme) => ({
                        border: `1px solid ${theme.palette.divider}`,
                        borderRadius: 1,
                        padding: 1.5,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1,
                    })}
                >
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 1,
                        }}
                    >
                        <Typography sx={{ fontWeight: 600 }}>
                            Configured exclusions
                        </Typography>
                        {canToggleConfigured && (
                            <Button
                                size='small'
                                onClick={() =>
                                    setShowAllConfigured(!showAllConfigured)
                                }
                            >
                                {showAllConfigured
                                    ? 'Show less'
                                    : `Show all (${totalConfiguredEntries})`}
                            </Button>
                        )}
                    </Box>
                    <Box
                        sx={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 1,
                            maxHeight: showAllConfigured ? 260 : undefined,
                            overflowY: showAllConfigured ? 'auto' : 'visible',
                            pr: showAllConfigured ? 1 : 0,
                        }}
                    >
                        {visibleConfiguredFlags.map((flag) => {
                            const field = (featureFields ?? []).find(
                                (candidate) => candidate.feature === flag.name,
                            );
                            const flagSelected = [
                                ...(field?.parameters ?? []),
                                ...(field?.variantPayloads ?? []),
                            ];
                            return (
                                <Box
                                    key={flag.name}
                                    sx={{
                                        display: 'flex',
                                        gap: 1,
                                        alignItems: 'center',
                                        flexWrap: 'wrap',
                                    }}
                                >
                                    <Button
                                        size='small'
                                        variant='text'
                                        onClick={() =>
                                            setActiveFlagName(flag.name)
                                        }
                                    >
                                        {flag.name}
                                    </Button>
                                    {flagSelected.map((entry) => (
                                        <Chip
                                            key={entry}
                                            size='small'
                                            label={displayEntry(entry)}
                                            onDelete={() => removeEntry(entry)}
                                        />
                                    ))}
                                </Box>
                            );
                        })}
                    </Box>
                </Box>
            )}
        </Box>
    );
};
