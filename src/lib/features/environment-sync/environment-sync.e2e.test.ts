import {
    type IUnleashTest,
    setupAppWithCustomConfig,
} from '../../../test/e2e/helpers/test-helper.js';
import dbInit, {
    type ITestDb,
} from '../../../test/e2e/helpers/database-init.js';
import getLogger from '../../../test/fixtures/no-logger.js';

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

    expect(fingerprints.body.version).toBe(2);
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
