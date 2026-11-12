import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
    IFeatureEnvironmentStore,
    IFeatureStrategiesStore,
    IFeatureTagStore,
    IFeatureToggleStore,
    IAuditUser,
} from '../../types/index.js';
import type EnvironmentService from '../project-environments/environment-service.js';
import type EventService from '../events/event-service.js';
import type { ISegmentReadModel } from '../segment/segment-read-model-type.js';
import { FakeEnvironmentSyncTargetStore } from './fakes/fake-environment-sync-target-store.js';
import { FakeEnvironmentSyncClient } from './fakes/fake-environment-sync-client.js';
import { EnvironmentSyncService } from './environment-sync-service.js';
import {
    canonicalConfig,
    fingerprintConfig,
    SYNC_PROTOCOL_VERSION,
} from './environment-sync-config.js';
import { collectEnvironmentSyncCatalog } from './environment-sync-catalog.js';
import { BadDataError } from '../../error/index.js';

const auditUser: IAuditUser = {
    id: 1,
    username: 'admin',
    ip: '127.0.0.1',
};

const encryptionKey = Buffer.alloc(32, 7).toString('base64');

const setup = () => {
    const targetStore = new FakeEnvironmentSyncTargetStore();
    const client = new FakeEnvironmentSyncClient();

    const featureToggleStore = {
        getAll: vi.fn().mockResolvedValue([
            { name: 'flag-a', project: 'project', archivedAt: null },
            { name: 'flag-b', project: 'project', archivedAt: null },
        ]),
        getAllByNames: vi.fn().mockResolvedValue([
            { name: 'flag-a', project: 'project', archivedAt: null },
            { name: 'flag-b', project: 'project', archivedAt: null },
        ]),
    } as unknown as IFeatureToggleStore;

    const featureStrategiesStore = {
        getAllByFeatures: vi.fn().mockResolvedValue([
            {
                id: 'strategy-1',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'development',
                strategyName: 'flexibleRollout',
                parameters: {
                    rollout: '50',
                    stickiness: 'default',
                    groupId: 'flag-a',
                },
                constraints: [],
                variants: [],
                disabled: false,
            },
        ]),
        getStrategiesForFeatureEnv: vi.fn().mockResolvedValue([]),
    } as unknown as IFeatureStrategiesStore;

    const featureEnvironmentStore = {
        getAllByFeatures: vi.fn().mockResolvedValue([
            {
                featureName: 'flag-a',
                environment: 'development',
                enabled: true,
                variants: [],
            },
            {
                featureName: 'flag-b',
                environment: 'development',
                enabled: false,
                variants: [],
            },
        ]),
        get: vi.fn().mockResolvedValue(undefined),
    } as unknown as IFeatureEnvironmentStore;

    const segmentReadModel = {
        getAll: vi.fn().mockResolvedValue([]),
        getAllFeatureStrategySegments: vi.fn().mockResolvedValue([]),
    } as unknown as ISegmentReadModel;

    const environmentService = {
        exists: vi.fn().mockResolvedValue(true),
        getProjectEnvironments: vi.fn().mockResolvedValue([
            { name: 'development', visible: true },
            { name: 'production', visible: true },
        ]),
    } as unknown as EnvironmentService;

    const eventService = {
        storeEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as EventService;

    const featureTagStore = {
        getAllByFeatures: vi.fn().mockResolvedValue([]),
    } as unknown as IFeatureTagStore;

    const service = new EnvironmentSyncService(
        {
            environmentSyncTargetStore: targetStore,
            featureToggleStore,
            featureStrategiesStore,
            featureEnvironmentStore,
            featureTagStore,
            segmentReadModel,
        },
        {
            getLogger: {
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                fatal: vi.fn(),
            } as never,
            environmentSyncEncryptionKey: encryptionKey,
            allowPrivateUrlInIntegration: true,
            allowListIntegration: [],
        },
        { environmentService, eventService },
        client as never,
    );

    return {
        service,
        targetStore,
        client,
        featureToggleStore,
        featureStrategiesStore,
        featureEnvironmentStore,
        featureTagStore,
        segmentReadModel,
        environmentService,
        eventService,
    };
};

const createTarget = async (
    service: EnvironmentSyncService,
    overrides: Partial<
        Parameters<EnvironmentSyncService['createTarget']>[0]
    > = {},
) =>
    service.createTarget(
        {
            name: 'QA',
            url: 'https://qa.example.com',
            token: 'secret-token',
            sourceEnvironment: 'development',
            targetEnvironment: 'production',
            ...overrides,
        },
        auditUser,
    );

describe('EnvironmentSyncService targets', () => {
    test('encrypts the token and never exposes it', async () => {
        const { service, targetStore } = setup();
        const view = await createTarget(service);

        expect(view).not.toHaveProperty('tokenEnc');
        expect(view.hasToken).toBe(true);

        const stored = await targetStore.get(1);
        expect(stored.tokenEnc).not.toEqual(Buffer.from('secret-token'));
        expect(stored.tokenEnc.toString('utf8')).not.toContain('secret-token');
    });

    test('rejects token storage when no encryption key is configured', async () => {
        const { service } = setup();
        const targetStore = new FakeEnvironmentSyncTargetStore();
        const noKeyService = new EnvironmentSyncService(
            {
                environmentSyncTargetStore: targetStore,
                featureToggleStore: {} as never,
                featureStrategiesStore: {} as never,
                featureEnvironmentStore: {} as never,
                featureTagStore: {} as never,
                segmentReadModel: {} as never,
            },
            {
                getLogger: {} as never,
                environmentSyncEncryptionKey: undefined,
                allowPrivateUrlInIntegration: true,
                allowListIntegration: [],
            },
            { environmentService: {} as never, eventService: {} as never },
            new FakeEnvironmentSyncClient() as never,
        );

        await expect(
            noKeyService.createTarget(
                {
                    name: 'QA',
                    url: 'https://qa.example.com',
                    token: 'secret-token',
                    sourceEnvironment: 'development',
                    targetEnvironment: 'production',
                },
                auditUser,
            ),
        ).rejects.toBeInstanceOf(BadDataError);

        expect(service).toBeDefined();
    });

    test('records target lifecycle audit events', async () => {
        const { service, eventService } = setup();
        await createTarget(service);
        await service.updateTarget(
            1,
            {
                name: 'QA renamed',
                url: 'https://qa.example.com',
                sourceEnvironment: 'development',
                targetEnvironment: 'production',
            },
            auditUser,
        );
        await service.deleteTarget(1, auditUser);

        const events = vi
            .mocked(eventService.storeEvent)
            .mock.calls.map(([event]) => event as { type: string; data: any });

        expect(events.map((event) => event.type)).toEqual([
            'environment-sync-target-changed',
            'environment-sync-target-changed',
            'environment-sync-target-changed',
        ]);
        expect(events.map((event) => event.data.action)).toEqual([
            'created',
            'updated',
            'deleted',
        ]);
    });

    test('validates the source environment', async () => {
        const { service, environmentService } = setup();
        vi.mocked(environmentService.exists).mockResolvedValueOnce(false);

        await expect(
            createTarget(service, { sourceEnvironment: 'nope' }),
        ).rejects.toBeInstanceOf(BadDataError);
    });

    test('returns a bad request error for a malformed target', async () => {
        const { service } = setup();

        await expect(
            service.createTarget({ token: 'secret-token' } as never, auditUser),
        ).rejects.toBeInstanceOf(BadDataError);
        await expect(
            service.createTarget(
                { name: 'QA', token: 'secret-token' } as never,
                auditUser,
            ),
        ).rejects.toBeInstanceOf(BadDataError);
        await expect(
            service.createTarget(
                {
                    name: 'QA',
                    url: 'https://qa.example.com',
                    token: 'secret-token',
                    sourceEnvironment: 'development',
                    targetEnvironment: undefined,
                } as never,
                auditUser,
            ),
        ).rejects.toBeInstanceOf(BadDataError);
    });

    test('returns a bad request error when testing without a URL', async () => {
        const { service } = setup();

        await expect(service.testTarget({} as never)).rejects.toBeInstanceOf(
            BadDataError,
        );
    });
});

describe('EnvironmentSyncService status', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('compares fingerprints in one call per target', async () => {
        const { service, client, featureStrategiesStore } = setup();
        await createTarget(service);

        const localConfig = canonicalConfig({
            strategies: [
                {
                    id: 'strategy-1',
                    strategyName: 'flexibleRollout',
                    parameters: {
                        rollout: '50',
                        stickiness: 'default',
                        groupId: 'flag-a',
                    },
                    constraints: [],
                },
            ],
            variants: [],
            strategySegments: [],
            segmentNamesById: new Map(),
        });
        const localFingerprint = fingerprintConfig(localConfig);
        const emptyFingerprint = fingerprintConfig(
            canonicalConfig({
                strategies: [],
                variants: [],
                strategySegments: [],
                segmentNamesById: new Map(),
            }),
        );

        client.fingerprints = vi.fn().mockResolvedValue({
            version: SYNC_PROTOCOL_VERSION,
            environmentAvailable: true,
            features: [
                {
                    name: 'flag-a',
                    exists: true,
                    archived: false,
                    fingerprint: 'drifted',
                    strategyCount: 1,
                    variantCount: 0,
                },
                {
                    name: 'flag-b',
                    exists: true,
                    archived: false,
                    fingerprint: emptyFingerprint,
                    strategyCount: 0,
                    variantCount: 0,
                },
            ],
        });

        const status = await service.getProjectStatus('project');

        expect(client.fingerprints).toHaveBeenCalledTimes(1);
        expect(featureStrategiesStore.getAllByFeatures).toHaveBeenCalledWith(
            ['flag-a', 'flag-b'],
            'development',
        );
        expect(status.summary).toEqual({
            total: 2,
            inSync: 1,
            outOfSync: 1,
            missing: 0,
            excluded: 0,
            errors: 0,
        });
        expect(
            status.features.find((feature) => feature.featureName === 'flag-a')
                ?.status,
        ).toBe('out_of_sync');
        expect(
            status.features.find((feature) => feature.featureName === 'flag-a')
                ?.targets[0],
        ).toMatchObject({ status: 'drift' });
        expect(localFingerprint).toHaveLength(64);

        // Cached for the next call.
        await service.getProjectStatus('project');
        expect(client.fingerprints).toHaveBeenCalledTimes(1);
    });

    test('reports a missing remote flag', async () => {
        const { service, client } = setup();
        await createTarget(service);
        client.fingerprints = vi.fn().mockResolvedValue({
            version: SYNC_PROTOCOL_VERSION,
            environmentAvailable: true,
            features: [
                {
                    name: 'flag-a',
                    exists: false,
                    archived: false,
                    fingerprint: null,
                    strategyCount: 0,
                    variantCount: 0,
                },
                {
                    name: 'flag-b',
                    exists: true,
                    archived: false,
                    fingerprint: 'different',
                    strategyCount: 0,
                    variantCount: 0,
                },
            ],
        });

        const status = await service.getProjectStatus('project');
        const flagA = status.features.find(
            (feature) => feature.featureName === 'flag-a',
        );
        expect(flagA?.targets[0].status).toBe('missing_remote');
        expect(status.summary.missing).toBe(1);
    });

    test('reports the considered targets when there is nothing to compare', async () => {
        const { service, featureToggleStore } = setup();
        await createTarget(service);
        vi.mocked(featureToggleStore.getAll).mockResolvedValueOnce([]);

        const status = await service.getProjectStatus('project');

        expect(status.summary.total).toBe(0);
        expect(status.targets).toEqual([{ targetId: 1, targetName: 'QA' }]);
    });

    test('reports no targets when every target is disabled', async () => {
        const { service } = setup();
        await createTarget(service, { enabled: false });

        const status = await service.getProjectStatus('project');

        expect(status.targets).toEqual([]);
        expect(status.features).toEqual([]);
    });
});

describe('EnvironmentSyncService segments', () => {
    const strategy = (segments: string[]) => ({
        name: 'flexibleRollout',
        parameters: {},
        constraints: [],
        segments,
        variants: [],
    });

    test('resolves global and project segments by name', async () => {
        const { service, segmentReadModel } = setup();
        vi.mocked(segmentReadModel.getAll).mockResolvedValue([
            { id: 1, name: 'beta-users', project: undefined },
            { id: 2, name: 'beta-users', project: 'other-project' },
            { id: 3, name: 'paid-users', project: 'project' },
        ] as never);

        const [resolved] = await service.resolveSegmentIds('project', [
            strategy(['beta-users', 'paid-users']),
        ]);

        expect(resolved.segmentIds).toEqual([1, 3]);
    });

    test('rejects a name that matches more than one segment', async () => {
        const { service, segmentReadModel } = setup();
        vi.mocked(segmentReadModel.getAll).mockResolvedValue([
            { id: 1, name: 'beta-users', project: undefined },
            { id: 2, name: 'beta-users', project: 'project' },
        ] as never);

        await expect(
            service.resolveSegmentIds('project', [strategy(['beta-users'])]),
        ).rejects.toThrow(/more than one segment/);
    });

    test('does not reject duplicate names no strategy references', async () => {
        const { service, segmentReadModel } = setup();
        vi.mocked(segmentReadModel.getAll).mockResolvedValue([
            { id: 1, name: 'beta-users', project: undefined },
            { id: 2, name: 'beta-users', project: 'project' },
            { id: 3, name: 'paid-users', project: 'project' },
        ] as never);

        const [resolved] = await service.resolveSegmentIds('project', [
            strategy(['paid-users']),
        ]);

        expect(resolved.segmentIds).toEqual([3]);
    });

    test('rejects segments that do not exist', async () => {
        const { service } = setup();

        await expect(
            service.resolveSegmentIds('project', [strategy(['nope'])]),
        ).rejects.toBeInstanceOf(BadDataError);
    });
});

describe('EnvironmentSyncService compare', () => {
    test('returns both configs and the drift status for one flag', async () => {
        const { service, client } = setup();
        await createTarget(service);

        client.config = vi.fn().mockResolvedValue({
            version: SYNC_PROTOCOL_VERSION,
            environmentAvailable: true,
            exists: true,
            archived: false,
            strategies: [
                {
                    name: 'flexibleRollout',
                    parameters: {
                        rollout: '10',
                        stickiness: 'default',
                        groupId: 'flag-a',
                    },
                    constraints: [],
                    segments: [],
                    variants: [],
                },
            ],
            variants: [],
        });

        const compare = await service.compareFeature('project', 'flag-a');

        expect(compare.targets).toHaveLength(1);
        expect(compare.targets[0].status).toBe('drift');
        expect(compare.targets[0].local?.strategies[0].parameters.rollout).toBe(
            '50',
        );
        expect(
            compare.targets[0].remote?.strategies[0].parameters.rollout,
        ).toBe('10');
        expect(compare.targets[0].differences).toEqual([
            { field: 'strategies', local: 1, remote: 1 },
        ]);
        expect(compare.targets[0].diff?.strategies).toHaveLength(1);
        expect(compare.targets[0].diff?.strategies[0].status).toBe('modified');
        expect(compare.targets[0].diff?.strategies[0].changes).toContain(
            'parameters',
        );
        expect(compare.targets[0].diff?.summary).toEqual({
            total: 1,
            inSync: 0,
            outOfSync: 1,
        });
    });
});

describe('EnvironmentSyncService sync', () => {
    test('sends only strategies and variants', async () => {
        const { service, client, eventService } = setup();
        await createTarget(service);
        vi.mocked(eventService.storeEvent).mockClear();

        const result = await service.sync(
            'project',
            ['flag-a'],
            [1],
            false,
            auditUser,
        );

        expect(client.calls.applyConfigs).toHaveLength(1);
        const call = client.calls.applyConfigs[0] as {
            input: {
                configs: {
                    featureName: string;
                    strategies: unknown[];
                    variants: unknown[];
                }[];
            };
        };
        expect(call.input.configs).toEqual([
            {
                featureName: 'flag-a',
                strategies: [
                    {
                        name: 'flexibleRollout',
                        parameters: {
                            rollout: '50',
                            stickiness: 'default',
                            groupId: 'flag-a',
                        },
                        constraints: [],
                        segments: [],
                        variants: [],
                    },
                ],
                variants: [],
            },
        ]);
        expect(call.input).not.toHaveProperty('enabled');
        expect(call.input.configs[0]).not.toHaveProperty('enabled');
        expect(call.input.configs[0]).not.toHaveProperty('metadata');
        expect(result.results[0].features[0].status).toBe('synced');
        expect(eventService.storeEvent).toHaveBeenCalledTimes(1);
        expect(
            (
                vi.mocked(eventService.storeEvent).mock.calls[0][0] as {
                    type: string;
                }
            ).type,
        ).toBe('feature-configs-synced');
    });

    test('sends strategies in sort order with variant payloads', async () => {
        const { service, client, featureStrategiesStore } = setup();
        await createTarget(service);

        vi.mocked(
            featureStrategiesStore.getAllByFeatures,
        ).mockResolvedValueOnce([
            {
                id: 'strategy-3',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'development',
                strategyName: 'flexibleRollout',
                sortOrder: 3,
                createdAt: new Date('2026-01-03T00:00:00.000Z'),
                parameters: {
                    rollout: '100',
                    stickiness: 'default',
                    groupId: 'multi',
                },
                constraints: [
                    {
                        contextName: 'userId',
                        operator: 'IN',
                        values: ['2'],
                    },
                ],
                variants: [
                    {
                        name: 'user-2',
                        weight: 1000,
                        weightType: 'variable',
                        stickiness: 'default',
                        payload: { type: 'json', value: '{"tier":"silver"}' },
                    },
                ],
                segments: [],
            },
            {
                id: 'strategy-1',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'development',
                strategyName: 'flexibleRollout',
                sortOrder: 1,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                parameters: {
                    rollout: '100',
                    stickiness: 'default',
                    groupId: 'multi',
                },
                constraints: [
                    {
                        contextName: 'userId',
                        operator: 'IN',
                        values: ['1'],
                    },
                ],
                variants: [
                    {
                        name: 'user-1',
                        weight: 1000,
                        weightType: 'variable',
                        stickiness: 'default',
                        payload: { type: 'json', value: '{"tier":"gold"}' },
                    },
                ],
                segments: [],
            },
            {
                id: 'strategy-2',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'development',
                strategyName: 'flexibleRollout',
                sortOrder: 2,
                createdAt: new Date('2026-01-02T00:00:00.000Z'),
                parameters: {
                    rollout: '100',
                    stickiness: 'default',
                    groupId: 'multi',
                },
                constraints: [],
                variants: [
                    {
                        name: 'default',
                        weight: 1000,
                        weightType: 'variable',
                        stickiness: 'default',
                        payload: { type: 'json', value: '{"tier":"free"}' },
                    },
                ],
                segments: [],
            },
        ] as never);

        await service.sync('project', ['flag-a'], [1], false, auditUser);

        const call = client.calls.applyConfigs[0] as {
            input: {
                configs: {
                    strategies: {
                        constraints: { values?: string[] }[];
                        variants: {
                            name: string;
                            payload?: { value: string };
                        }[];
                    }[];
                }[];
            };
        };
        const strategies = call.input.configs[0].strategies;
        expect(
            strategies.map((strategy) => strategy.constraints[0]?.values?.[0]),
        ).toEqual(['1', undefined, '2']);
        expect(
            strategies.map((strategy) => strategy.variants[0]?.name),
        ).toEqual(['user-1', 'default', 'user-2']);
        expect(
            strategies.map((strategy) => strategy.variants[0]?.payload?.value),
        ).toEqual(['{"tier":"gold"}', '{"tier":"free"}', '{"tier":"silver"}']);
    });

    test('skips flags already in sync when requested', async () => {
        const { service, client } = setup();
        await createTarget(service);

        const emptyFingerprint = fingerprintConfig(
            canonicalConfig({
                strategies: [],
                variants: [],
                strategySegments: [],
                segmentNamesById: new Map(),
            }),
        );
        client.fingerprints = vi.fn().mockResolvedValue({
            version: SYNC_PROTOCOL_VERSION,
            environmentAvailable: true,
            features: [
                {
                    name: 'flag-a',
                    exists: true,
                    archived: false,
                    fingerprint: 'drifted',
                    strategyCount: 1,
                    variantCount: 0,
                },
                {
                    name: 'flag-b',
                    exists: true,
                    archived: false,
                    fingerprint: emptyFingerprint,
                    strategyCount: 0,
                    variantCount: 0,
                },
            ],
        });

        await service.sync(
            'project',
            ['flag-a', 'flag-b'],
            [1],
            true,
            auditUser,
        );

        const call = client.calls.applyConfigs[0] as {
            input: { configs: { featureName: string }[] };
        };
        expect(call.input.configs.map((config) => config.featureName)).toEqual([
            'flag-a',
        ]);
    });

    test('does not treat the same flag name in another project as a running sync', async () => {
        const { service, client, featureToggleStore } = setup();
        await createTarget(service);
        vi.mocked(featureToggleStore.getAllByNames).mockResolvedValue([
            { name: 'flag-a', project: 'project-a', archivedAt: null },
            { name: 'flag-a', project: 'project-b', archivedAt: null },
        ] as never);

        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const remoteProjects: string[] = [];
        const applyConfigs = vi.fn(
            async (
                _target: unknown,
                input: {
                    projectId: string;
                    configs: { featureName: string }[];
                },
            ) => {
                remoteProjects.push(input.projectId);
                await gate;
                return {
                    results: input.configs.map((config) => ({
                        featureName: config.featureName,
                        status: 'synced' as const,
                        created: false,
                    })),
                };
            },
        );
        client.applyConfigs = applyConfigs as never;

        const first = service.sync(
            'project-a',
            ['flag-a'],
            [1],
            false,
            auditUser,
        );
        const second = service.sync(
            'project-b',
            ['flag-a'],
            [1],
            false,
            auditUser,
        );
        release();
        const [a, b] = await Promise.all([first, second]);

        expect(applyConfigs).toHaveBeenCalledTimes(2);
        expect(remoteProjects.sort()).toEqual(['project-a', 'project-b']);
        expect(a.results[0].features[0].status).toBe('synced');
        expect(b.results[0].features[0].status).toBe('synced');
    });
});

describe('EnvironmentSyncService ignored config', () => {
    test('updates only the environment-specific values', async () => {
        const { service } = setup();
        await createTarget(service);

        const updated = await service.updateTargetIgnoredConfig(
            1,
            {
                parameters: ['loginUrl'],
                variantPayloads: ['*::/redirectUrl'],
                ignoredFeatures: ['legacy-*', 'tag:no-env-sync'],
                featureFields: [],
            },
            auditUser,
        );

        expect(updated.ignoredConfig).toEqual({
            parameters: ['loginUrl'],
            variantPayloads: ['*::/redirectUrl'],
            ignoredFeatures: ['legacy-*', 'tag:no-env-sync'],
        });
        expect(updated.name).toBe('QA');
        expect(updated.url).toBe('https://qa.example.com');
    });

    test('rejects malformed environment-specific values', async () => {
        const { service } = setup();
        await createTarget(service);

        await expect(
            service.updateTargetIgnoredConfig(
                1,
                {
                    parameters: 'loginUrl',
                    variantPayloads: [],
                    ignoredFeatures: [],
                    featureFields: [],
                },
                auditUser,
            ),
        ).rejects.toThrow('must be an array');
    });

    test('rejects a partial replacement instead of clearing the missing lists', async () => {
        const { service } = setup();
        const created = await createTarget(service, {
            ignoredConfig: {
                parameters: ['loginUrl'],
                variantPayloads: ['*'],
                ignoredFeatures: ['legacy-*'],
            },
        });

        await expect(
            service.updateTargetIgnoredConfig(1, undefined, auditUser),
        ).rejects.toBeInstanceOf(BadDataError);
        await expect(
            service.updateTargetIgnoredConfig(
                1,
                { parameters: ['other'] },
                auditUser,
            ),
        ).rejects.toThrow(
            /missing variantPayloads, ignoredFeatures, featureFields/,
        );

        const { targets } = await service.getTargets();
        expect(targets[0].ignoredConfig).toEqual(created.ignoredConfig);
    });

    test('rejects a replacement that omits field exclusions', async () => {
        const { service } = setup();
        const created = await createTarget(service, {
            ignoredConfig: {
                parameters: [],
                variantPayloads: [],
                ignoredFeatures: [],
                featureFields: [
                    {
                        feature: 'flag-a',
                        parameters: ['loginUrl'],
                        variantPayloads: [],
                    },
                ],
            },
        });

        await expect(
            service.updateTargetIgnoredConfig(
                1,
                {
                    parameters: ['loginUrl'],
                    variantPayloads: [],
                    ignoredFeatures: [],
                },
                auditUser,
            ),
        ).rejects.toThrow(/missing featureFields/);

        const { targets } = await service.getTargets();
        expect(targets[0].ignoredConfig).toEqual(created.ignoredConfig);
    });

    test('records an audit event when the config changes', async () => {
        const { service, eventService } = setup();
        await createTarget(service);
        vi.mocked(eventService.storeEvent).mockClear();

        await service.updateTargetIgnoredConfig(
            1,
            {
                parameters: ['loginUrl'],
                variantPayloads: [],
                ignoredFeatures: ['legacy-*'],
                featureFields: [],
            },
            auditUser,
        );

        expect(eventService.storeEvent).toHaveBeenCalledTimes(1);
        expect(eventService.storeEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'environment-sync-target-config-updated',
                targetId: 1,
                targetName: 'QA',
                data: expect.objectContaining({
                    parameters: 1,
                    ignoredFeatures: 1,
                }),
            }),
        );
    });

    test('rejects a partial replacement through the target update', async () => {
        const { service } = setup();
        const created = await createTarget(service);

        await expect(
            service.updateTarget(
                1,
                {
                    name: 'QA',
                    url: 'https://qa.example.com',
                    sourceEnvironment: 'development',
                    targetEnvironment: 'production',
                    ignoredConfig: { parameters: ['only'] },
                } as never,
                auditUser,
            ),
        ).rejects.toBeInstanceOf(BadDataError);

        const { targets } = await service.getTargets();
        expect(targets[0].ignoredConfig).toEqual(created.ignoredConfig);
    });
});

describe('EnvironmentSyncService feature exclusion', () => {
    const baseIgnored = {
        parameters: [],
        variantPayloads: [],
        ignoredFeatures: [],
    };

    test('adds and removes an exact exclusion', async () => {
        const { service } = setup();
        await createTarget(service, { ignoredConfig: baseIgnored });

        await expect(
            service.setFeatureExclusion(
                1,
                { featureName: 'flag-a', excluded: true },
                auditUser,
            ),
        ).resolves.toEqual({ excluded: true, changed: true });

        await expect(
            service.setFeatureExclusion(
                1,
                { featureName: 'flag-a', excluded: false },
                auditUser,
            ),
        ).resolves.toEqual({ excluded: false, changed: true });
    });

    test('cannot include a flag that a glob rule excludes', async () => {
        const { service } = setup();
        await createTarget(service, {
            ignoredConfig: { ...baseIgnored, ignoredFeatures: ['legacy-*'] },
        });

        const result = await service.setFeatureExclusion(
            1,
            { featureName: 'legacy-checkout', excluded: false },
            auditUser,
        );

        expect(result).toMatchObject({ excluded: true, changed: false });
        expect(result.reason).toContain('legacy-*');
    });

    test('cannot include a flag that a tag rule excludes', async () => {
        const { service, featureTagStore } = setup();
        await createTarget(service, {
            ignoredConfig: {
                ...baseIgnored,
                ignoredFeatures: ['tag:no-env-sync'],
            },
        });
        vi.mocked(featureTagStore.getAllByFeatures).mockResolvedValueOnce([
            {
                featureName: 'flag-a',
                tagType: 'simple',
                tagValue: 'no-env-sync',
            },
        ] as never);

        const result = await service.setFeatureExclusion(
            1,
            { featureName: 'flag-a', excluded: false },
            auditUser,
        );

        expect(result).toMatchObject({ excluded: true, changed: false });
        expect(result.reason).toContain('tag:no-env-sync');
    });

    test('records an audit event only when the exclusion changes', async () => {
        const { service, eventService } = setup();
        await createTarget(service, {
            ignoredConfig: { ...baseIgnored, ignoredFeatures: ['legacy-*'] },
        });
        vi.mocked(eventService.storeEvent).mockClear();

        await service.setFeatureExclusion(
            1,
            { featureName: 'flag-a', excluded: true },
            auditUser,
        );

        expect(eventService.storeEvent).toHaveBeenCalledTimes(1);
        expect(eventService.storeEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'environment-sync-feature-exclusion-changed',
                targetId: 1,
                targetName: 'QA',
                data: expect.objectContaining({
                    featureName: 'flag-a',
                    excluded: true,
                }),
            }),
        );

        await service.setFeatureExclusion(
            1,
            { featureName: 'legacy-checkout', excluded: false },
            auditUser,
        );
        expect(eventService.storeEvent).toHaveBeenCalledTimes(1);
    });

    test('rejects an invalid payload', async () => {
        const { service } = setup();
        await createTarget(service);

        await expect(
            service.setFeatureExclusion(1, {}, auditUser),
        ).rejects.toThrow('featureName is required');
    });
});

describe('EnvironmentSyncService environment-specific values', () => {
    const ignored = {
        parameters: ['loginUrl', 'config::/sso/loginUrl'],
        variantPayloads: ['*::/redirectUrl'],
        ignoredFeatures: [],
    };

    test('does not report drift when only ignored values differ', async () => {
        const { service, client, featureStrategiesStore } = setup();
        await createTarget(service, { ignoredConfig: ignored });

        vi.mocked(
            featureStrategiesStore.getAllByFeatures,
        ).mockResolvedValueOnce([
            {
                id: 'local-strategy',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'development',
                strategyName: 'flexibleRollout',
                parameters: {
                    loginUrl: 'https://ab-test.com',
                    rollout: '50',
                    stickiness: 'default',
                    groupId: 'flag-a',
                },
                constraints: [],
                variants: [],
                disabled: false,
            },
        ] as never);

        const remoteConfig = canonicalConfig(
            {
                strategies: [
                    {
                        id: 'remote-strategy',
                        strategyName: 'flexibleRollout',
                        parameters: {
                            loginUrl: 'https://test.com',
                            rollout: '50',
                            stickiness: 'default',
                            groupId: 'flag-a',
                        },
                        constraints: [],
                        variants: [],
                    },
                ],
                variants: [],
                strategySegments: [],
                segmentNamesById: new Map(),
            },
            ignored,
        );

        client.fingerprints = vi.fn().mockResolvedValue({
            version: SYNC_PROTOCOL_VERSION,
            environmentAvailable: true,
            features: [
                {
                    name: 'flag-a',
                    exists: true,
                    archived: false,
                    fingerprint: fingerprintConfig(remoteConfig),
                    strategyCount: 1,
                    variantCount: 0,
                },
            ],
        });

        const status = await service.getProjectStatus('project');

        expect(
            status.features.find((feature) => feature.featureName === 'flag-a')
                ?.status,
        ).toBe('in_sync');
        expect(status.summary.inSync).toBe(1);
        expect(status.summary.excluded).toBe(0);
    });

    test('reports ignored flags as excluded', async () => {
        const { service, client } = setup();
        await createTarget(service, {
            ignoredConfig: {
                parameters: [],
                variantPayloads: [],
                ignoredFeatures: ['flag-a'],
            },
        });

        const status = await service.getProjectStatus('project');

        expect(
            status.features.find((feature) => feature.featureName === 'flag-a')
                ?.status,
        ).toBe('excluded');
        expect(status.summary.excluded).toBe(1);
        expect(
            (
                client.calls.fingerprints[0] as {
                    input: { featureNames: string[] };
                }
            ).input.featureNames,
        ).toEqual(['flag-b']);
    });

    test('skips ignored flags when syncing', async () => {
        const { service, client } = setup();
        await createTarget(service, {
            ignoredConfig: {
                parameters: [],
                variantPayloads: [],
                ignoredFeatures: ['flag-a'],
            },
        });

        const result = await service.sync(
            'project',
            ['flag-a', 'flag-b'],
            undefined,
            false,
            auditUser,
        );

        expect(
            client.calls.applyConfigs.flatMap((call) =>
                (
                    call as {
                        input: { configs: { featureName: string }[] };
                    }
                ).input.configs.map((config) => config.featureName),
            ),
        ).toEqual(['flag-b']);
        expect(result.results[0].features).toContainEqual({
            featureName: 'flag-a',
            status: 'skipped',
            error: 'Excluded from this sync target',
        });
    });

    test('restores whole and nested target values before writing', async () => {
        const { service, featureStrategiesStore, featureEnvironmentStore } =
            setup();

        vi.mocked(
            featureStrategiesStore.getStrategiesForFeatureEnv,
        ).mockResolvedValueOnce([
            {
                id: 'existing-strategy',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'production',
                strategyName: 'flexibleRollout',
                parameters: {
                    loginUrl: 'https://test.com',
                    config: JSON.stringify({
                        sso: { loginUrl: 'https://test.com', timeout: 5 },
                    }),
                    rollout: '50',
                },
                constraints: [],
                variants: [],
                disabled: false,
            },
        ] as never);
        vi.mocked(featureEnvironmentStore.get).mockResolvedValueOnce({
            featureName: 'flag-a',
            environment: 'production',
            enabled: true,
            variants: [
                {
                    name: 'a',
                    weight: 1000,
                    weightType: 'variable',
                    stickiness: 'default',
                    payload: {
                        type: 'json',
                        value: '{"redirectUrl":"https://test.com","n":1}',
                    },
                },
            ],
        } as never);

        const incoming = canonicalConfig(
            {
                strategies: [
                    {
                        id: 'incoming',
                        strategyName: 'flexibleRollout',
                        parameters: {
                            loginUrl: 'https://ab-test.com',
                            config: JSON.stringify({
                                sso: {
                                    loginUrl: 'https://ab-test.com',
                                    timeout: 10,
                                },
                            }),
                            rollout: '10',
                        },
                        constraints: [],
                        variants: [],
                    },
                ],
                variants: [
                    {
                        name: 'a',
                        weight: 1000,
                        weightType: 'variable',
                        stickiness: 'default',
                        payload: {
                            type: 'json',
                            value: '{"redirectUrl":"https://ab-test.com","n":1}',
                        },
                    },
                ],
                strategySegments: [],
                segmentNamesById: new Map(),
            },
            ignored,
        );

        const preserved = await service.preserveEnvironmentSpecificValues(
            'project',
            'production',
            {
                featureName: 'flag-a',
                strategies: incoming.strategies,
                variants: incoming.variants,
            },
            ignored,
        );

        expect(preserved.strategies[0].parameters.loginUrl).toEqual(
            'https://test.com',
        );
        expect(preserved.strategies[0].parameters.rollout).toEqual('10');
        expect(JSON.parse(preserved.strategies[0].parameters.config)).toEqual({
            sso: { loginUrl: 'https://test.com', timeout: 10 },
        });
        expect(JSON.parse(preserved.variants[0].payload!.value)).toEqual({
            redirectUrl: 'https://test.com',
            n: 1,
        });
    });

    test('refuses to drop a target value it cannot merge', async () => {
        const { service, featureStrategiesStore } = setup();

        vi.mocked(
            featureStrategiesStore.getStrategiesForFeatureEnv,
        ).mockResolvedValueOnce([
            {
                id: 'existing-strategy',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'production',
                strategyName: 'flexibleRollout',
                parameters: {
                    config: JSON.stringify({
                        sso: { loginUrl: 'https://test.com' },
                    }),
                },
                constraints: [],
                variants: [],
                disabled: false,
            },
        ] as never);

        await expect(
            service.preserveEnvironmentSpecificValues(
                'project',
                'production',
                {
                    featureName: 'flag-a',
                    strategies: [
                        {
                            name: 'flexibleRollout',
                            parameters: { config: 'not-json' },
                            constraints: [],
                            segments: [],
                            variants: [],
                        },
                    ],
                    variants: [],
                },
                ignored,
            ),
        ).rejects.toThrow('could not be preserved');
    });

    test('leaves a new flag untouched when the target has no configuration', async () => {
        const { service, featureStrategiesStore, featureEnvironmentStore } =
            setup();
        vi.mocked(
            featureStrategiesStore.getStrategiesForFeatureEnv,
        ).mockResolvedValueOnce([]);
        vi.mocked(featureEnvironmentStore.get).mockRejectedValueOnce(
            new Error('not found'),
        );

        const config = {
            featureName: 'brand-new',
            strategies: [
                {
                    name: 'flexibleRollout',
                    parameters: { rollout: '10' },
                    constraints: [],
                    segments: [],
                    variants: [],
                },
            ],
            variants: [],
        };

        await expect(
            service.preserveEnvironmentSpecificValues(
                'project',
                'production',
                config,
                ignored,
            ),
        ).resolves.toEqual({
            strategies: config.strategies,
            variants: config.variants,
        });
    });

    test('restores a field only for the feature it is scoped to', async () => {
        const { service, featureStrategiesStore, featureEnvironmentStore } =
            setup();
        vi.mocked(
            featureStrategiesStore.getStrategiesForFeatureEnv,
        ).mockResolvedValueOnce([
            {
                id: 'existing-strategy',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'production',
                strategyName: 'flexibleRollout',
                parameters: {
                    config: JSON.stringify({
                        sso: { loginUrl: 'https://test.com', timeout: 5 },
                    }),
                },
                constraints: [],
                variants: [],
                disabled: false,
            },
        ] as never);
        vi.mocked(featureEnvironmentStore.get).mockResolvedValueOnce({
            featureName: 'flag-a',
            environment: 'production',
            enabled: true,
            variants: [],
        } as never);

        const scoped = {
            parameters: [],
            variantPayloads: [],
            ignoredFeatures: [],
            featureFields: [
                {
                    feature: 'flag-a',
                    parameters: ['config::/sso/loginUrl'],
                    variantPayloads: [],
                },
            ],
        };

        const incoming = (loginUrl: string) =>
            canonicalConfig({
                strategies: [
                    {
                        id: 'incoming',
                        strategyName: 'flexibleRollout',
                        parameters: {
                            config: JSON.stringify({
                                sso: { loginUrl, timeout: 5 },
                            }),
                        },
                        constraints: [],
                        variants: [],
                    },
                ],
                variants: [],
                strategySegments: [],
                segmentNamesById: new Map(),
            });

        const preserved = await service.preserveEnvironmentSpecificValues(
            'project',
            'production',
            {
                featureName: 'flag-a',
                strategies: incoming('https://ab-test.com').strategies,
                variants: [],
            },
            scoped,
        );

        expect(JSON.parse(preserved.strategies[0].parameters.config)).toEqual({
            sso: { loginUrl: 'https://test.com', timeout: 5 },
        });

        const untouched = await service.preserveEnvironmentSpecificValues(
            'project',
            'production',
            {
                featureName: 'other-flag',
                strategies: incoming('https://ab-test.com').strategies,
                variants: [],
            },
            scoped,
        );

        expect(JSON.parse(untouched.strategies[0].parameters.config)).toEqual({
            sso: { loginUrl: 'https://ab-test.com', timeout: 5 },
        });
    });

    test('keeps the target JSON key order when the value is unchanged', async () => {
        const { service, featureStrategiesStore, featureEnvironmentStore } =
            setup();
        vi.mocked(
            featureStrategiesStore.getStrategiesForFeatureEnv,
        ).mockResolvedValueOnce([
            {
                id: 'existing-strategy',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'production',
                strategyName: 'flexibleRollout',
                parameters: { config: '{"b":2,"a":1}' },
                constraints: [],
                variants: [],
                disabled: false,
            },
        ] as never);
        vi.mocked(featureEnvironmentStore.get).mockResolvedValueOnce({
            featureName: 'flag-a',
            environment: 'production',
            enabled: true,
            variants: [],
        } as never);

        const incoming = canonicalConfig({
            strategies: [
                {
                    id: 'incoming',
                    strategyName: 'flexibleRollout',
                    parameters: { config: '{"a":1,"b":2}' },
                    constraints: [],
                    variants: [],
                },
            ],
            variants: [],
            strategySegments: [],
            segmentNamesById: new Map(),
        });

        const preserved = await service.preserveEnvironmentSpecificValues(
            'project',
            'production',
            {
                featureName: 'flag-a',
                strategies: incoming.strategies,
                variants: [],
            },
        );

        expect(preserved.strategies[0].parameters.config).toEqual(
            '{"b":2,"a":1}',
        );
    });

    test('keeps the target key order after restoring an excluded field', async () => {
        const { service, featureStrategiesStore, featureEnvironmentStore } =
            setup();
        vi.mocked(
            featureStrategiesStore.getStrategiesForFeatureEnv,
        ).mockResolvedValueOnce([
            {
                id: 'existing-strategy',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'production',
                strategyName: 'flexibleRollout',
                parameters: {
                    config: '{"b":2,"a":{"secret":"target","keep":1}}',
                },
                constraints: [],
                variants: [],
                disabled: false,
            },
        ] as never);
        vi.mocked(featureEnvironmentStore.get).mockResolvedValueOnce({
            featureName: 'flag-a',
            environment: 'production',
            enabled: true,
            variants: [],
        } as never);

        const ignored = {
            parameters: ['config::/a/secret'],
            variantPayloads: [],
            ignoredFeatures: [],
        };
        const incoming = canonicalConfig(
            {
                strategies: [
                    {
                        id: 'incoming',
                        strategyName: 'flexibleRollout',
                        parameters: {
                            config: '{"a":{"keep":1,"secret":"source"},"b":2}',
                        },
                        constraints: [],
                        variants: [],
                    },
                ],
                variants: [],
                strategySegments: [],
                segmentNamesById: new Map(),
            },
            ignored,
        );

        const preserved = await service.preserveEnvironmentSpecificValues(
            'project',
            'production',
            {
                featureName: 'flag-a',
                strategies: incoming.strategies,
                variants: [],
            },
            ignored,
        );

        expect(preserved.strategies[0].parameters.config).toEqual(
            '{"b":2,"a":{"secret":"target","keep":1}}',
        );
    });

    test('is a no-op without configured values', async () => {
        const { service } = setup();
        const config = {
            featureName: 'flag-a',
            strategies: [],
            variants: [],
        };

        await expect(
            service.preserveEnvironmentSpecificValues(
                'project',
                'production',
                config,
            ),
        ).resolves.toEqual(config);
    });
});

describe('EnvironmentSyncService catalog', () => {
    test('returns source and target values for each field', async () => {
        const { service, client, featureStrategiesStore } = setup();
        await createTarget(service);

        vi.mocked(
            featureStrategiesStore.getAllByFeatures,
        ).mockResolvedValueOnce([
            {
                id: 'strategy-1',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'development',
                strategyName: 'flexibleRollout',
                parameters: { loginUrl: 'https://ab-test.com' },
                constraints: [],
                variants: [],
                disabled: false,
            },
        ] as never);

        // Build the peer payload the same way the peer endpoint does, so
        // `valuesByFlag` contains digests rather than hand-written values.
        const remote = collectEnvironmentSyncCatalog(
            'production',
            [
                {
                    name: 'flag-a',
                    config: canonicalConfig({
                        strategies: [
                            {
                                id: 'strategy-1',
                                strategyName: 'flexibleRollout',
                                parameters: { loginUrl: 'https://test.com' },
                                constraints: [],
                            },
                        ],
                        variants: [],
                        strategySegments: [],
                        segmentNamesById: new Map(),
                    }),
                },
            ],
            [{ name: 'flag-a', project: 'project', tags: [] }],
        );
        client.catalog = vi.fn().mockResolvedValue({
            version: SYNC_PROTOCOL_VERSION,
            environment: remote.environment,
            entries: remote.entries,
            flags: remote.flags.map((flag) => flag.name),
            truncated: remote.truncated,
        });

        const catalog = await service.getCatalog({ targetId: 1 });
        const entry = catalog.entries.find(
            (candidate) => candidate.entry === 'loginUrl',
        );

        expect(catalog.comparedWithTarget).toBe(true);
        expect(entry).toMatchObject({
            differs: true,
            local: { samples: ['https://ab-test.com'] },
            remote: { samples: ['https://test.com'] },
        });
    });

    test('reports no difference when both sides match', async () => {
        const { service, client, featureStrategiesStore } = setup();
        await createTarget(service);

        vi.mocked(
            featureStrategiesStore.getAllByFeatures,
        ).mockResolvedValueOnce([
            {
                id: 'strategy-1',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'development',
                strategyName: 'flexibleRollout',
                parameters: { loginUrl: 'https://ab-test.com' },
                constraints: [],
                variants: [],
                disabled: false,
            },
        ] as never);

        const remote = collectEnvironmentSyncCatalog(
            'production',
            [
                {
                    name: 'flag-a',
                    config: canonicalConfig({
                        strategies: [
                            {
                                id: 'strategy-1',
                                strategyName: 'flexibleRollout',
                                parameters: { loginUrl: 'https://ab-test.com' },
                                constraints: [],
                            },
                        ],
                        variants: [],
                        strategySegments: [],
                        segmentNamesById: new Map(),
                    }),
                },
            ],
            [{ name: 'flag-a', project: 'project', tags: [] }],
        );
        client.catalog = vi.fn().mockResolvedValue({
            version: SYNC_PROTOCOL_VERSION,
            environment: remote.environment,
            entries: remote.entries,
            flags: remote.flags.map((flag) => flag.name),
            truncated: remote.truncated,
        });

        const catalog = await service.getCatalog({ targetId: 1 });
        const entry = catalog.entries.find(
            (candidate) => candidate.entry === 'loginUrl',
        );

        expect(entry?.differs).toBe(false);
        expect(entry?.local?.valuesByFlag['flag-a']).toBe(
            entry?.remote?.valuesByFlag['flag-a'],
        );
    });

    test('reports a difference past the sample truncation point', async () => {
        const { service, client, featureStrategiesStore } = setup();
        await createTarget(service);

        const prefix = 'x'.repeat(200);
        vi.mocked(
            featureStrategiesStore.getAllByFeatures,
        ).mockResolvedValueOnce([
            {
                id: 'strategy-1',
                featureName: 'flag-a',
                projectId: 'project',
                environment: 'development',
                strategyName: 'flexibleRollout',
                parameters: { loginUrl: `${prefix}A` },
                constraints: [],
                variants: [],
                disabled: false,
            },
        ] as never);

        // Build the remote catalog the same way the peer endpoint does, so
        // both sides truncate their samples for display.
        const remote = collectEnvironmentSyncCatalog(
            'production',
            [
                {
                    name: 'flag-a',
                    config: canonicalConfig({
                        strategies: [
                            {
                                id: 'strategy-1',
                                strategyName: 'flexibleRollout',
                                parameters: { loginUrl: `${prefix}B` },
                                constraints: [],
                            },
                        ],
                        variants: [],
                        strategySegments: [],
                        segmentNamesById: new Map(),
                    }),
                },
            ],
            [{ name: 'flag-a', project: 'project', tags: [] }],
        );
        client.catalog = vi.fn().mockResolvedValue({
            version: SYNC_PROTOCOL_VERSION,
            environment: remote.environment,
            entries: remote.entries,
            flags: remote.flags.map((flag) => flag.name),
            truncated: remote.truncated,
        });

        const catalog = await service.getCatalog({ targetId: 1 });
        const entry = catalog.entries.find(
            (candidate) => candidate.entry === 'loginUrl',
        );

        const truncated = `${prefix.slice(0, 160)}…`;
        expect(entry?.local?.samples).toEqual([truncated]);
        expect(entry?.remote?.samples).toEqual([truncated]);
        expect(entry?.differs).toBe(true);
    });

    test('returns the source catalog without a target', async () => {
        const { service } = setup();

        const catalog = await service.getCatalog({
            sourceEnvironment: 'development',
        });

        expect(catalog.comparedWithTarget).toBe(false);
        expect(catalog.flags.map((flag) => flag.name)).toEqual([
            'flag-a',
            'flag-b',
        ]);
    });

    test('reports a remote failure without dropping the local catalog', async () => {
        const { service, client } = setup();
        await createTarget(service);

        client.catalog = vi
            .fn()
            .mockRejectedValue(new Error('target unreachable'));

        const catalog = await service.getCatalog({ targetId: 1 });

        expect(catalog.comparedWithTarget).toBe(true);
        expect(catalog.remoteError).toBe('target unreachable');
        expect(catalog.entries.length).toBeGreaterThan(0);
    });

    test('excludes flags by tag rule', async () => {
        const { service, client, featureTagStore } = setup();
        await createTarget(service, {
            ignoredConfig: {
                parameters: [],
                variantPayloads: [],
                ignoredFeatures: ['tag:no-env-sync'],
            },
        });

        vi.mocked(featureTagStore.getAllByFeatures).mockResolvedValueOnce([
            {
                featureName: 'flag-a',
                tagType: 'simple',
                tagValue: 'no-env-sync',
            },
        ] as never);

        const status = await service.getProjectStatus('project');

        expect(
            status.features.find((feature) => feature.featureName === 'flag-a')
                ?.status,
        ).toBe('excluded');
        expect(
            (
                client.calls.fingerprints[0] as {
                    input: { featureNames: string[] };
                }
            ).input.featureNames,
        ).toEqual(['flag-b']);
    });
});
