import dbInit, {
    type ITestDb,
} from '../../../test/e2e/helpers/database-init.js';
import {
    createUserWithRootRole,
    type IUnleashTest,
    setupAppWithAuth,
} from '../../../test/e2e/helpers/test-helper.js';
import getLogger from '../../../test/fixtures/no-logger.js';
import {
    RoleName,
    SYSTEM_USER_AUDIT,
    SYSTEM_USER_ID,
} from '../../types/index.js';
import {
    CREATE_FEATURE,
    CREATE_FEATURE_STRATEGY,
    UPDATE_FEATURE_ENVIRONMENT,
} from '../../types/permissions.js';
import type { PermissionRef } from '../../services/access-service.js';

const encryptionKey = Buffer.alloc(32, 5).toString('base64');
const adminEmail = 'environment-sync-admin@example.com';

const configPayload = (featureName: string) => ({
    projectId: 'default',
    environment: 'production',
    configs: [{ featureName, strategies: [], variants: [] }],
});

describe('environment sync API permissions', () => {
    let app: IUnleashTest;
    let db: ITestDb;
    let roleIndex = 0;

    beforeAll(async () => {
        db = await dbInit('environment_sync_permissions', getLogger);
        app = await setupAppWithAuth(
            db.stores,
            {
                environmentSyncEncryptionKey: encryptionKey,
                experimental: { flags: { environmentSync: true } },
            },
            db.rawDatabase,
        );
        await createUserWithRootRole({
            app,
            stores: db.stores,
            email: adminEmail,
            roleName: RoleName.ADMIN,
        });
        await app.login({ email: adminEmail });
        await app.createFeature('existing-sync-flag');
    });

    afterAll(async () => {
        await app.destroy();
        await db.destroy();
    });

    const loginWithPermissions = async (
        email: string,
        permissions: PermissionRef[],
    ) => {
        const { accessService, userService } = app.services;
        const viewerRole = (await accessService.getPredefinedRole(
            RoleName.VIEWER,
        ))!;
        const user = await userService.createUser(
            { email, rootRole: viewerRole.id },
            SYSTEM_USER_AUDIT,
        );
        const role = await accessService.createRole(
            {
                name: `environment_sync_role_${roleIndex++}`,
                description: `role for ${email}`,
                permissions,
                type: 'root-custom',
                createdByUserId: SYSTEM_USER_ID,
            },
            SYSTEM_USER_AUDIT,
        );
        await accessService.addUserToRole(user.id, role.id, 'default');
        await app.login({ email });
    };

    test('apply-configs requires CREATE_FEATURE_STRATEGY', async () => {
        await loginWithPermissions('sync-env-only@example.com', [
            { name: UPDATE_FEATURE_ENVIRONMENT },
        ]);

        await app.request
            .post('/api/admin/environment-sync/apply-configs')
            .send(configPayload('flag-created-by-sync'))
            .expect(403);
    });

    test('apply-configs requires CREATE_FEATURE when the flag does not exist', async () => {
        await loginWithPermissions('sync-strategy-only@example.com', [
            { name: UPDATE_FEATURE_ENVIRONMENT },
            { name: CREATE_FEATURE_STRATEGY },
        ]);

        await app.request
            .post('/api/admin/environment-sync/apply-configs')
            .send(configPayload('flag-without-create'))
            .expect(403);

        await app.request
            .get(
                '/api/admin/projects/default/features/flag-without-create?variantEnvironments=true',
            )
            .expect(404);
    });

    test('apply-configs updates an existing flag with the strategy permission', async () => {
        await loginWithPermissions('sync-strategy-update@example.com', [
            { name: UPDATE_FEATURE_ENVIRONMENT },
            { name: CREATE_FEATURE_STRATEGY },
        ]);

        const response = await app.request
            .post('/api/admin/environment-sync/apply-configs')
            .send(configPayload('existing-sync-flag'))
            .expect(200);

        expect(response.body.results[0]).toMatchObject({
            featureName: 'existing-sync-flag',
            status: 'synced',
            created: false,
        });
    });

    test('apply-configs creates a flag with CREATE_FEATURE and CREATE_FEATURE_STRATEGY', async () => {
        await loginWithPermissions('sync-create@example.com', [
            { name: UPDATE_FEATURE_ENVIRONMENT },
            { name: CREATE_FEATURE_STRATEGY },
            { name: CREATE_FEATURE },
        ]);

        const response = await app.request
            .post('/api/admin/environment-sync/apply-configs')
            .send(configPayload('flag-created-by-sync'))
            .expect(200);

        expect(response.body.results[0]).toMatchObject({
            featureName: 'flag-created-by-sync',
            status: 'synced',
            created: true,
        });
    });
});

describe('environment sync API when the flag is disabled', () => {
    let app: IUnleashTest;
    let db: ITestDb;

    beforeAll(async () => {
        db = await dbInit('environment_sync_disabled', getLogger);
        app = await setupAppWithAuth(
            db.stores,
            {
                environmentSyncEncryptionKey: encryptionKey,
                experimental: { flags: { environmentSync: false } },
            },
            db.rawDatabase,
        );
        await createUserWithRootRole({
            app,
            stores: db.stores,
            email: 'sync-disabled-admin@example.com',
            roleName: RoleName.ADMIN,
        });
        await app.login({ email: 'sync-disabled-admin@example.com' });
    });

    afterAll(async () => {
        await app.destroy();
        await db.destroy();
    });

    test('does not mount any environment sync route', async () => {
        await app.request
            .get('/api/admin/environment-sync/targets')
            .expect(404);
        await app.request
            .post('/api/admin/environment-sync/apply-configs')
            .send(configPayload('flag-created-by-sync'))
            .expect(404);
    });
});
