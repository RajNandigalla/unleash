import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
    IFeatureEnvironmentStore,
    IFeatureStrategiesStore,
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
} from './environment-sync-config.js';
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

    const service = new EnvironmentSyncService(
        {
            environmentSyncTargetStore: targetStore,
            featureToggleStore,
            featureStrategiesStore,
            featureEnvironmentStore,
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

    test('validates the source environment', async () => {
        const { service, environmentService } = setup();
        vi.mocked(environmentService.exists).mockResolvedValueOnce(false);

        await expect(
            createTarget(service, { sourceEnvironment: 'nope' }),
        ).rejects.toBeInstanceOf(BadDataError);
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
            version: 2,
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
            version: 2,
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
            version: 2,
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
            version: 2,
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
