import {
    type IUnleashTest,
    setupAppWithCustomConfig,
} from '../../../test/e2e/helpers/test-helper.js';
import dbInit, {
    type ITestDb,
} from '../../../test/e2e/helpers/database-init.js';
import getLogger from '../../../test/fixtures/no-logger.js';
import { SYNC_PROTOCOL_VERSION } from './environment-sync-config.js';

let app: IUnleashTest;
let db: ITestDb;

const encryptionKey = Buffer.alloc(32, 3).toString('base64');

beforeAll(async () => {
    db = await dbInit('environment_sync_api', getLogger);
    app = await setupAppWithCustomConfig(
        db.stores,
        {
            environmentSyncEncryptionKey: encryptionKey,
            experimental: {
                flags: {
                    environmentSync: true,
                },
            },
        },
        db.rawDatabase,
    );
});

afterAll(async () => {
    await app.destroy();
    await db.destroy();
});

test('target CRUD never returns the token', async () => {
    const created = await app.request
        .post('/api/admin/environment-sync/targets')
        .send({
            name: 'QA',
            url: 'https://qa.example.com',
            token: 'super-secret-token',
            sourceEnvironment: 'development',
            targetEnvironment: 'production',
        })
        .expect(201);

    expect(created.body).toMatchObject({
        name: 'QA',
        hasToken: true,
    });
    expect(JSON.stringify(created.body)).not.toContain('super-secret-token');
    expect(created.body).not.toHaveProperty('tokenEnc');

    const listed = await app.request
        .get('/api/admin/environment-sync/targets')
        .expect(200);

    expect(listed.body.tokenStorageConfigured).toBe(true);
    expect(listed.body.targets).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain('super-secret-token');

    await app.request
        .delete(`/api/admin/environment-sync/targets/${created.body.id}`)
        .expect(204);
});

test('apply-configs replaces strategies and variants without touching enabled or metadata', async () => {
    const featureName = 'config-only-sync';

    const firstApply = await app.request
        .post('/api/admin/environment-sync/apply-configs')
        .send({
            projectId: 'default',
            environment: 'production',
            version: SYNC_PROTOCOL_VERSION,
            configs: [
                {
                    featureName,
                    strategies: [
                        {
                            name: 'flexibleRollout',
                            parameters: {
                                rollout: '50',
                                stickiness: 'default',
                                groupId: featureName,
                            },
                            constraints: [],
                            segments: [],
                            variants: [],
                        },
                    ],
                    variants: [
                        {
                            name: 'a',
                            weight: 1000,
                            weightType: 'variable',
                            stickiness: 'default',
                        },
                    ],
                },
            ],
        })
        .expect(200);

    expect(firstApply.body.results[0]).toMatchObject({
        featureName,
        status: 'synced',
        created: true,
    });

    const created = await app.request
        .get(
            `/api/admin/projects/default/features/${featureName}?variantEnvironments=true`,
        )
        .expect(200);

    expect(created.body.description).toBeNull();
    const production = created.body.environments.find(
        (environment: { name: string }) => environment.name === 'production',
    );
    expect(production.enabled).toBe(false);
    expect(production.strategies).toHaveLength(1);
    expect(production.variants).toHaveLength(1);

    // Make changes that sync must not overwrite.
    await app.request
        .put(`/api/admin/projects/default/features/${featureName}`)
        .send({ description: 'keep this description' })
        .expect(200);
    await app.request
        .post(
            `/api/admin/projects/default/features/${featureName}/environments/production/on`,
        )
        .expect(200);

    const secondApply = await app.request
        .post('/api/admin/environment-sync/apply-configs')
        .send({
            projectId: 'default',
            environment: 'production',
            version: SYNC_PROTOCOL_VERSION,
            configs: [
                {
                    featureName,
                    strategies: [
                        {
                            name: 'flexibleRollout',
                            parameters: {
                                rollout: '10',
                                stickiness: 'default',
                                groupId: featureName,
                            },
                            constraints: [],
                            segments: [],
                            variants: [],
                        },
                    ],
                    variants: [],
                },
            ],
        })
        .expect(200);

    expect(secondApply.body.results[0]).toMatchObject({
        featureName,
        status: 'synced',
        created: false,
    });

    const updated = await app.request
        .get(
            `/api/admin/projects/default/features/${featureName}?variantEnvironments=true`,
        )
        .expect(200);

    expect(updated.body.description).toBe('keep this description');
    const updatedProduction = updated.body.environments.find(
        (environment: { name: string }) => environment.name === 'production',
    );
    expect(updatedProduction.enabled).toBe(true);
    expect(updatedProduction.strategies).toHaveLength(1);
    expect(updatedProduction.strategies[0].parameters.rollout).toBe('10');
    expect(updatedProduction.variants).toHaveLength(0);
});

test('apply-configs preserves strategy order, variant payloads and overrides', async () => {
    const featureName = 'multi-user-config';
    const userStrategy = (userId: string, value: string) => ({
        name: 'flexibleRollout',
        parameters: {
            rollout: '100',
            stickiness: 'default',
            groupId: 'multi-user',
        },
        constraints: [
            { contextName: 'userId', operator: 'IN', values: [userId] },
        ],
        segments: [],
        variants: [
            {
                name: `user-${userId}`,
                weight: 1000,
                weightType: 'variable',
                stickiness: 'default',
                payload: { type: 'json', value },
            },
        ],
    });
    const fallback = {
        name: 'flexibleRollout',
        parameters: {
            rollout: '100',
            stickiness: 'default',
            groupId: 'multi-user',
        },
        constraints: [],
        segments: [],
        variants: [
            {
                name: 'default',
                weight: 1000,
                weightType: 'variable',
                stickiness: 'default',
                payload: { type: 'json', value: '{"tier":"free"}' },
            },
        ],
    };

    await app.request
        .post('/api/admin/environment-sync/apply-configs')
        .send({
            projectId: 'default',
            environment: 'production',
            version: SYNC_PROTOCOL_VERSION,
            configs: [
                {
                    featureName,
                    strategies: [
                        userStrategy('1', '{"tier":"gold"}'),
                        userStrategy('2', '{"tier":"silver"}'),
                        fallback,
                    ],
                    variants: [],
                },
            ],
        })
        .expect(200);

    const created = await app.request
        .get(
            `/api/admin/projects/default/features/${featureName}?variantEnvironments=true`,
        )
        .expect(200);
    const production = created.body.environments.find(
        (environment: { name: string }) => environment.name === 'production',
    );

    expect(production.strategies).toHaveLength(3);
    expect(
        production.strategies.map(
            (strategy: { constraints: { values?: string[] }[] }) =>
                strategy.constraints[0]?.values?.[0] ?? 'fallback',
        ),
    ).toEqual(['1', '2', 'fallback']);
    expect(
        production.strategies.map(
            (strategy: { variants: { name: string }[] }) =>
                strategy.variants[0]?.name,
        ),
    ).toEqual(['user-1', 'user-2', 'default']);
    expect(
        production.strategies.map(
            (strategy: { variants: { payload?: { value: string } }[] }) =>
                strategy.variants[0]?.payload?.value,
        ),
    ).toEqual(['{"tier":"gold"}', '{"tier":"silver"}', '{"tier":"free"}']);

    const envFeatureName = 'env-override-config';
    const envVariant = (userId: string, value: string) => ({
        name: `user-${userId}`,
        weight: 1000,
        weightType: 'variable',
        stickiness: 'default',
        payload: { type: 'json', value },
        overrides: [{ contextName: 'userId', values: [userId] }],
    });

    await app.request
        .post('/api/admin/environment-sync/apply-configs')
        .send({
            projectId: 'default',
            environment: 'production',
            version: SYNC_PROTOCOL_VERSION,
            configs: [
                {
                    featureName: envFeatureName,
                    strategies: [
                        {
                            name: 'flexibleRollout',
                            parameters: {
                                rollout: '100',
                                stickiness: 'default',
                                groupId: 'env-override',
                            },
                            constraints: [],
                            segments: [],
                            variants: [],
                        },
                    ],
                    variants: [
                        envVariant('1', '{"tier":"gold"}'),
                        envVariant('2', '{"tier":"silver"}'),
                    ],
                },
            ],
        })
        .expect(200);

    const envCreated = await app.request
        .get(
            `/api/admin/projects/default/features/${envFeatureName}?variantEnvironments=true`,
        )
        .expect(200);
    const envProduction = envCreated.body.environments.find(
        (environment: { name: string }) => environment.name === 'production',
    );

    expect(envProduction.variants).toHaveLength(2);
    expect(envProduction.variants[0]).toMatchObject({
        name: 'user-1',
        payload: { type: 'json', value: '{"tier":"gold"}' },
        overrides: [{ contextName: 'userId', values: ['1'] }],
    });
    expect(envProduction.variants[1]).toMatchObject({
        name: 'user-2',
        payload: { type: 'json', value: '{"tier":"silver"}' },
        overrides: [{ contextName: 'userId', values: ['2'] }],
    });
});

test('fingerprints and config return the canonical configuration', async () => {
    const featureName = 'config-only-sync';

    const fingerprints = await app.request
        .post('/api/admin/environment-sync/fingerprints')
        .send({
            projectId: 'default',
            environment: 'production',
            featureNames: [featureName],
        })
        .expect(200);

    expect(fingerprints.body.version).toBe(SYNC_PROTOCOL_VERSION);
    expect(fingerprints.body.environmentAvailable).toBe(true);
    expect(fingerprints.body.features[0]).toMatchObject({
        name: featureName,
        exists: true,
        archived: false,
        strategyCount: 1,
        variantCount: 0,
    });
    expect(fingerprints.body.features[0].fingerprint).toHaveLength(64);

    const config = await app.request
        .post('/api/admin/environment-sync/config')
        .send({
            projectId: 'default',
            environment: 'production',
            featureName,
        })
        .expect(200);

    expect(config.body.exists).toBe(true);
    expect(config.body.strategies).toHaveLength(1);
    expect(config.body.strategies[0].name).toBe('flexibleRollout');
    expect(config.body.strategies[0].parameters.rollout).toBe('10');
    expect(config.body).not.toHaveProperty('enabled');
    expect(config.body).not.toHaveProperty('description');
});

test('apply-configs preserves environment-specific values on the target', async () => {
    const featureName = 'env-specific-sync';
    const ignoredConfig = {
        parameters: ['loginUrl', 'config::/sso/loginUrl'],
        variantPayloads: ['*::/redirectUrl'],
        ignoredFeatures: [],
    };

    // Seed the target environment with its own values.
    await app.request
        .post('/api/admin/environment-sync/apply-configs')
        .send({
            projectId: 'default',
            environment: 'production',
            version: SYNC_PROTOCOL_VERSION,
            configs: [
                {
                    featureName,
                    strategies: [
                        {
                            name: 'flexibleRollout',
                            parameters: {
                                rollout: '50',
                                stickiness: 'default',
                                groupId: featureName,
                                loginUrl: 'https://test.com',
                                config: JSON.stringify({
                                    sso: {
                                        loginUrl: 'https://test.com',
                                        timeout: 5,
                                    },
                                }),
                            },
                            constraints: [],
                            segments: [],
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
                                value: '{"redirectUrl":"https://test.com","n":1}',
                            },
                        },
                    ],
                },
            ],
        })
        .expect(200);

    // The source instance sends its configuration with the environment
    // specific fields already removed.
    const response = await app.request
        .post('/api/admin/environment-sync/apply-configs')
        .send({
            projectId: 'default',
            environment: 'production',
            version: SYNC_PROTOCOL_VERSION,
            ignoredConfig,
            configs: [
                {
                    featureName,
                    strategies: [
                        {
                            name: 'flexibleRollout',
                            parameters: {
                                rollout: '10',
                                stickiness: 'default',
                                groupId: featureName,
                                config: JSON.stringify({
                                    sso: { timeout: 10 },
                                }),
                            },
                            constraints: [],
                            segments: [],
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
                                value: '{"n":2}',
                            },
                        },
                    ],
                },
            ],
        })
        .expect(200);

    expect(response.body.results[0]).toMatchObject({
        featureName,
        status: 'synced',
    });

    const updated = await app.request
        .get(
            `/api/admin/projects/default/features/${featureName}?variantEnvironments=true`,
        )
        .expect(200);

    const production = updated.body.environments.find(
        (environment: { name: string }) => environment.name === 'production',
    );
    const parameters = production.strategies[0].parameters;

    expect(parameters.rollout).toBe('10');
    expect(parameters.loginUrl).toBe('https://test.com');
    expect(JSON.parse(parameters.config)).toEqual({
        sso: { loginUrl: 'https://test.com', timeout: 10 },
    });
    expect(JSON.parse(production.variants[0].payload.value)).toEqual({
        redirectUrl: 'https://test.com',
        n: 2,
    });
});

test('targets persist environment-specific values and exclusions', async () => {
    const ignoredConfig = {
        parameters: ['loginUrl', 'config::/sso/loginUrl'],
        variantPayloads: ['*::/redirectUrl'],
        ignoredFeatures: ['legacy-*'],
    };

    const created = await app.request
        .post('/api/admin/environment-sync/targets')
        .send({
            name: 'Env-specific',
            url: 'https://qa.example.com',
            token: 'super-secret-token',
            sourceEnvironment: 'development',
            targetEnvironment: 'production',
            ignoredConfig,
        })
        .expect(201);

    expect(created.body.ignoredConfig).toEqual(ignoredConfig);

    const updated = await app.request
        .put(`/api/admin/environment-sync/targets/${created.body.id}`)
        .send({
            name: 'Env-specific',
            url: 'https://qa.example.com',
            sourceEnvironment: 'development',
            targetEnvironment: 'production',
            ignoredConfig: {
                parameters: ['loginUrl'],
                variantPayloads: [],
                ignoredFeatures: [],
                featureFields: [],
            },
        })
        .expect(200);

    expect(updated.body.ignoredConfig).toEqual({
        parameters: ['loginUrl'],
        variantPayloads: [],
        ignoredFeatures: [],
    });

    const listed = await app.request
        .get('/api/admin/environment-sync/targets')
        .expect(200);

    expect(
        listed.body.targets.find(
            (target: { id: number }) => target.id === created.body.id,
        ).ignoredConfig,
    ).toEqual({
        parameters: ['loginUrl'],
        variantPayloads: [],
        ignoredFeatures: [],
    });

    await app.request
        .delete(`/api/admin/environment-sync/targets/${created.body.id}`)
        .expect(204);
});

test('catalog lists environment-specific candidates for an environment', async () => {
    const featureName = 'catalog-sync-flag';

    await app.request
        .post('/api/admin/environment-sync/apply-configs')
        .send({
            projectId: 'default',
            environment: 'production',
            version: SYNC_PROTOCOL_VERSION,
            configs: [
                {
                    featureName,
                    strategies: [
                        {
                            name: 'flexibleRollout',
                            parameters: {
                                rollout: '50',
                                stickiness: 'default',
                                groupId: featureName,
                                loginUrl: 'https://test.com',
                                config: JSON.stringify({
                                    sso: { loginUrl: 'https://test.com' },
                                }),
                            },
                            constraints: [],
                            segments: [],
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
                                value: '{"redirectUrl":"https://test.com"}',
                            },
                        },
                    ],
                },
            ],
        })
        .expect(200);

    const peer = await app.request
        .post('/api/admin/environment-sync/catalog')
        .send({ environment: 'production' })
        .expect(200);

    expect(peer.body.version).toBe(SYNC_PROTOCOL_VERSION);
    expect(peer.body.entries).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ entry: 'loginUrl', kind: 'parameter' }),
            expect.objectContaining({
                entry: 'config::/sso/loginUrl',
                kind: 'parameter',
            }),
            expect.objectContaining({
                entry: '*::/redirectUrl',
                kind: 'variantPayload',
            }),
        ]),
    );

    const local = await app.request
        .post('/api/admin/environment-sync/projects/catalog')
        .send({ sourceEnvironment: 'production' })
        .expect(200);

    expect(local.body.comparedWithTarget).toBe(false);
    expect(local.body.sourceEnvironment).toBe('production');
    expect(local.body.flags).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ name: featureName }),
        ]),
    );
    expect(
        local.body.entries.find(
            (entry: { entry: string }) => entry.entry === 'loginUrl',
        ),
    ).toMatchObject({
        local: { samples: ['https://test.com'] },
        differs: true,
    });
});

test('ignored config can be updated independently of the connection', async () => {
    const created = await app.request
        .post('/api/admin/environment-sync/targets')
        .send({
            name: 'Ignored config target',
            url: 'https://qa.example.com',
            token: 'super-secret-token',
            sourceEnvironment: 'development',
            targetEnvironment: 'production',
        })
        .expect(201);

    const updated = await app.request
        .put(
            `/api/admin/environment-sync/targets/${created.body.id}/ignored-config`,
        )
        .send({
            ignoredConfig: {
                parameters: ['loginUrl', 'config::/sso/loginUrl'],
                variantPayloads: ['*::/redirectUrl'],
                ignoredFeatures: ['legacy-*', 'tag:no-env-sync'],
                featureFields: [],
            },
        })
        .expect(200);

    expect(updated.body.ignoredConfig).toEqual({
        parameters: ['loginUrl', 'config::/sso/loginUrl'],
        variantPayloads: ['*::/redirectUrl'],
        ignoredFeatures: ['legacy-*', 'tag:no-env-sync'],
    });
    expect(updated.body.name).toBe('Ignored config target');
    expect(updated.body.url).toBe('https://qa.example.com');

    await app.request
        .put(
            `/api/admin/environment-sync/targets/${created.body.id}/ignored-config`,
        )
        .send({ ignoredConfig: { parameters: 'loginUrl' } })
        .expect(400);

    // A missing or partial body must not clear the stored exclusions.
    await app.request
        .put(
            `/api/admin/environment-sync/targets/${created.body.id}/ignored-config`,
        )
        .send({})
        .expect(400);
    await app.request
        .put(
            `/api/admin/environment-sync/targets/${created.body.id}/ignored-config`,
        )
        .send({ ignoredConfig: { parameters: ['loginUrl'] } })
        .expect(400);
    // Omitting featureFields would delete every per-flag field exclusion.
    await app.request
        .put(
            `/api/admin/environment-sync/targets/${created.body.id}/ignored-config`,
        )
        .send({
            ignoredConfig: {
                parameters: ['loginUrl'],
                variantPayloads: [],
                ignoredFeatures: [],
            },
        })
        .expect(400);

    const unchanged = await app.request
        .get('/api/admin/environment-sync/targets')
        .expect(200);
    expect(
        unchanged.body.targets.find(
            (target: { id: number }) => target.id === created.body.id,
        ).ignoredConfig,
    ).toEqual({
        parameters: ['loginUrl', 'config::/sso/loginUrl'],
        variantPayloads: ['*::/redirectUrl'],
        ignoredFeatures: ['legacy-*', 'tag:no-env-sync'],
    });

    await app.request
        .delete(`/api/admin/environment-sync/targets/${created.body.id}`)
        .expect(204);
});

test('malformed target bodies return 400 instead of 500', async () => {
    await app.request
        .post('/api/admin/environment-sync/targets')
        .send({ token: 'super-secret-token' })
        .expect(400);

    await app.request
        .post('/api/admin/environment-sync/targets')
        .send({
            name: 'QA',
            url: 'https://qa.example.com',
            token: 'super-secret-token',
            sourceEnvironment: 'development',
        })
        .expect(400);

    await app.request
        .post('/api/admin/environment-sync/targets/test')
        .send({})
        .expect(400);
});

test('flags expose their tags for exclusion rules', async () => {
    const featureName = 'catalog-sync-flag';

    await app.request
        .post(`/api/admin/features/${featureName}/tags`)
        .send({ type: 'simple', value: 'no-env-sync' })
        .expect(201);

    const response = await app.request
        .get('/api/admin/environment-sync/flags')
        .expect(200);

    expect(response.body.flags).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                name: featureName,
                tags: expect.arrayContaining(['no-env-sync']),
            }),
        ]),
    );
});

test('a single flag can be excluded and included without touching the rest', async () => {
    const created = await app.request
        .post('/api/admin/environment-sync/targets')
        .send({
            name: 'Per flag target',
            url: 'https://qa.example.com',
            token: 'super-secret-token',
            sourceEnvironment: 'development',
            targetEnvironment: 'production',
        })
        .expect(201);

    const added = await app.request
        .put(
            `/api/admin/environment-sync/targets/${created.body.id}/feature-exclusion`,
        )
        .send({ featureName: 'config-only-sync', excluded: true })
        .expect(200);

    expect(added.body).toEqual({ excluded: true, changed: true });

    const listed = await app.request
        .get('/api/admin/environment-sync/targets')
        .expect(200);

    expect(
        listed.body.targets.find(
            (target: { id: number }) => target.id === created.body.id,
        ).ignoredConfig.ignoredFeatures,
    ).toEqual(['config-only-sync']);

    const removed = await app.request
        .put(
            `/api/admin/environment-sync/targets/${created.body.id}/feature-exclusion`,
        )
        .send({ featureName: 'config-only-sync', excluded: false })
        .expect(200);

    expect(removed.body).toEqual({ excluded: false, changed: true });

    await app.request
        .delete(`/api/admin/environment-sync/targets/${created.body.id}`)
        .expect(204);
});
