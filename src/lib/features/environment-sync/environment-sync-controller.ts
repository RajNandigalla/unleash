import type { Request, Response } from 'express';
import Controller from '../../routes/controller.js';
import type { IAuthRequest } from '../../routes/unleash-types.js';
import type {
    IConstraint,
    IStrategyConfig,
    IUnleashConfig,
    IVariant,
    Unsaved,
} from '../../types/index.js';
import type { IUnleashServices } from '../../services/index.js';
import type { WithTransactional } from '../../db/transaction.js';
import {
    ADMIN,
    CREATE_FEATURE,
    CREATE_FEATURE_STRATEGY,
    UPDATE_FEATURE_ENVIRONMENT,
} from '../../types/permissions.js';
import { BadDataError, PermissionError } from '../../error/index.js';
import type { FeatureToggleService } from '../feature-toggle/feature-toggle-service.js';
import type {
    EnvironmentSyncService,
    EnvironmentSyncTargetInput,
} from './environment-sync-service.js';
import type {
    EnvironmentSyncStrategy,
    EnvironmentSyncVariant,
} from './environment-sync-config.js';
import type { EnvironmentSyncApplyResult } from './environment-sync-client.js';

interface TargetParams {
    id: string;
}

interface ProjectParams {
    projectId: string;
}

interface FeatureParams extends ProjectParams {
    featureName: string;
}

type EnvironmentSyncServices = Pick<
    IUnleashServices,
    'environmentSyncService' | 'transactionalFeatureToggleService'
>;

export class EnvironmentSyncController extends Controller {
    private readonly environmentSyncService: EnvironmentSyncService;

    private readonly transactionalFeatureToggleService: WithTransactional<FeatureToggleService>;

    constructor(config: IUnleashConfig, services: EnvironmentSyncServices) {
        super(config);
        this.environmentSyncService = services.environmentSyncService;
        this.transactionalFeatureToggleService =
            services.transactionalFeatureToggleService;

        // The whole feature is an experiment: do not expose any of these
        // routes (including the peer endpoints) while the flag is off.
        if (!config.flagResolver.isEnabled('environmentSync')) {
            return;
        }

        this.route({
            method: 'get',
            path: '/targets',
            handler: this.getTargets,
            permission: ADMIN,
        });
        this.route({
            method: 'post',
            path: '/targets',
            handler: this.createTarget,
            permission: ADMIN,
        });
        this.route({
            method: 'post',
            path: '/targets/test',
            handler: this.testTarget,
            permission: ADMIN,
        });
        this.route({
            method: 'post',
            path: '/targets/:id/test',
            handler: this.testTargetById,
            permission: ADMIN,
        });
        this.route({
            method: 'put',
            path: '/targets/:id',
            handler: this.updateTarget,
            permission: ADMIN,
        });
        this.route({
            method: 'delete',
            path: '/targets/:id',
            handler: this.deleteTarget,
            permission: ADMIN,
            acceptAnyContentType: true,
        });
        this.route({
            method: 'get',
            path: '/projects/:projectId/status',
            handler: this.getProjectStatus,
            permission: UPDATE_FEATURE_ENVIRONMENT,
        });
        this.route({
            method: 'get',
            path: '/projects/:projectId/features/:featureName/compare',
            handler: this.compareFeature,
            permission: UPDATE_FEATURE_ENVIRONMENT,
        });
        this.route({
            method: 'post',
            path: '/projects/:projectId/sync',
            handler: this.sync,
            permission: UPDATE_FEATURE_ENVIRONMENT,
        });
        this.route({
            method: 'post',
            path: '/fingerprints',
            handler: this.getFingerprints,
            permission: UPDATE_FEATURE_ENVIRONMENT,
        });
        this.route({
            method: 'post',
            path: '/config',
            handler: this.getConfig,
            permission: UPDATE_FEATURE_ENVIRONMENT,
        });
        this.route({
            method: 'post',
            path: '/apply-configs',
            handler: this.applyConfigs,
            // apply-configs also creates flags and strategies; those extra
            // permissions are checked explicitly in the handler because route
            // permission arrays are an OR, not an AND.
            permission: UPDATE_FEATURE_ENVIRONMENT,
        });
    }

    private async getTargets(_req: Request, res: Response): Promise<void> {
        res.json(await this.environmentSyncService.getTargets());
    }

    private async createTarget(
        req: IAuthRequest<unknown, unknown, EnvironmentSyncTargetInput>,
        res: Response,
    ): Promise<void> {
        const target = await this.environmentSyncService.createTarget(
            req.body,
            req.audit,
        );
        res.status(201).json(target);
    }

    private async updateTarget(
        req: IAuthRequest<TargetParams, unknown, EnvironmentSyncTargetInput>,
        res: Response,
    ): Promise<void> {
        const target = await this.environmentSyncService.updateTarget(
            Number(req.params.id),
            req.body,
            req.audit,
        );
        res.json(target);
    }

    private async deleteTarget(
        req: IAuthRequest<TargetParams>,
        res: Response,
    ): Promise<void> {
        await this.environmentSyncService.deleteTarget(Number(req.params.id));
        res.status(204).end();
    }

    private async testTarget(
        req: IAuthRequest<
            unknown,
            unknown,
            {
                url: string;
                token: string;
                project?: string | null;
                targetEnvironment?: string;
            }
        >,
        res: Response,
    ): Promise<void> {
        res.json(await this.environmentSyncService.testTarget(req.body));
    }

    private async testTargetById(
        req: IAuthRequest<TargetParams>,
        res: Response,
    ): Promise<void> {
        res.json(
            await this.environmentSyncService.testTargetById(
                Number(req.params.id),
            ),
        );
    }

    private async getProjectStatus(
        req: IAuthRequest<
            ProjectParams,
            unknown,
            unknown,
            { refresh?: string }
        >,
        res: Response,
    ): Promise<void> {
        const status = await this.environmentSyncService.getProjectStatus(
            req.params.projectId,
            { refresh: req.query.refresh === 'true' },
        );
        res.json(status);
    }

    private async compareFeature(
        req: IAuthRequest<FeatureParams>,
        res: Response,
    ): Promise<void> {
        const compare = await this.environmentSyncService.compareFeature(
            req.params.projectId,
            req.params.featureName,
        );
        res.json(compare);
    }

    private async sync(
        req: IAuthRequest<
            ProjectParams,
            unknown,
            {
                featureNames?: string[];
                targetIds?: number[];
                onlyOutOfSync?: boolean;
            }
        >,
        res: Response,
    ): Promise<void> {
        const { featureNames, targetIds, onlyOutOfSync } = req.body;
        if (!Array.isArray(featureNames) || featureNames.length === 0) {
            throw new BadDataError('At least one feature flag is required');
        }
        const results = await this.environmentSyncService.sync(
            req.params.projectId,
            featureNames,
            targetIds,
            onlyOutOfSync ?? true,
            req.audit,
        );
        res.json(results);
    }

    private async getFingerprints(
        req: IAuthRequest<
            unknown,
            unknown,
            {
                projectId?: string;
                environment?: string;
                featureNames?: string[];
            }
        >,
        res: Response,
    ): Promise<void> {
        const { projectId, environment, featureNames } = req.body;
        if (!projectId || !environment) {
            throw new BadDataError('projectId and environment are required');
        }
        res.json(
            await this.environmentSyncService.getConfigFingerprints(
                projectId,
                environment,
                featureNames,
            ),
        );
    }

    private async getConfig(
        req: IAuthRequest<
            unknown,
            unknown,
            {
                projectId?: string;
                environment?: string;
                featureName?: string;
            }
        >,
        res: Response,
    ): Promise<void> {
        const { projectId, environment, featureName } = req.body;
        if (!projectId || !environment || !featureName) {
            throw new BadDataError(
                'projectId, environment and featureName are required',
            );
        }
        res.json(
            await this.environmentSyncService.getConfigSnapshot(
                projectId,
                environment,
                featureName,
            ),
        );
    }

    private async applyConfigs(
        req: IAuthRequest<
            unknown,
            unknown,
            {
                projectId?: string;
                environment?: string;
                configs?: {
                    featureName: string;
                    strategies: EnvironmentSyncStrategy[];
                    variants: EnvironmentSyncVariant[];
                }[];
            }
        >,
        res: Response,
    ): Promise<void> {
        const { projectId, environment, configs } = req.body;
        if (!projectId || !environment || !Array.isArray(configs)) {
            throw new BadDataError(
                'projectId, environment and configs are required',
            );
        }

        // Replacing an environment configuration always deletes and recreates
        // the strategies, and creates the flag when it does not exist yet.
        // Those operations need their own permissions; the route permission
        // only covers the environment update.
        await this.requirePermissions(req, [CREATE_FEATURE_STRATEGY]);

        const existingFeatures =
            await this.environmentSyncService.getExistingFeatureNames(
                configs
                    .map((config) => config.featureName)
                    .filter((featureName) => Boolean(featureName)),
            );
        const createsFeature = configs.some(
            (config) =>
                config.featureName && !existingFeatures.has(config.featureName),
        );
        if (createsFeature) {
            await this.requirePermissions(req, [CREATE_FEATURE]);
        }

        const results: EnvironmentSyncApplyResult[] = [];

        for (const config of configs) {
            try {
                if (!config.featureName) {
                    throw new BadDataError('featureName is required');
                }
                const strategies =
                    await this.environmentSyncService.resolveSegmentIds(
                        projectId,
                        config.strategies ?? [],
                    );
                const replaceStrategies: Unsaved<IStrategyConfig>[] =
                    strategies.map((strategy) => ({
                        name: strategy.name,
                        title: strategy.title,
                        disabled: strategy.disabled,
                        parameters: strategy.parameters,
                        constraints:
                            strategy.constraints as unknown as IConstraint[],
                        segments: strategy.segmentIds,
                        variants:
                            strategy.variants as unknown as IStrategyConfig['variants'],
                    }));
                const result =
                    await this.transactionalFeatureToggleService.transactional(
                        (service) =>
                            service.replaceEnvironmentConfig(
                                projectId,
                                config.featureName,
                                environment,
                                replaceStrategies,
                                (config.variants ??
                                    []) as unknown as IVariant[],
                                req.audit,
                            ),
                    );
                results.push({
                    featureName: config.featureName,
                    status: 'synced',
                    created: result.created,
                });
            } catch (error) {
                results.push({
                    featureName: config.featureName,
                    status: 'error',
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            }
        }

        res.json({ results });
    }

    /**
     * Requires every permission in the list. Route permission arrays are an
     * OR, so they cannot express "all of these".
     */
    private async requirePermissions(
        req: IAuthRequest,
        permissions: string[],
    ): Promise<void> {
        for (const permission of permissions) {
            const allowed = req.checkRbac
                ? await req.checkRbac([permission])
                : false;
            if (!allowed) {
                throw new PermissionError([permission]);
            }
        }
    }
}
