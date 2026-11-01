import type { IUnleashConfig } from '../../types/option.js';
import { validateUrl } from '../../addons/validate-url.js';
import { fetchPinned } from '../../addons/addon.js';
import type {
    EnvironmentSyncConfig,
    EnvironmentSyncStrategy,
    EnvironmentSyncVariant,
} from './environment-sync-config.js';

export interface EnvironmentSyncRemoteTarget {
    name: string;
    url: string;
    project: string | null;
    targetEnvironment: string;
    token: string;
}

export interface EnvironmentSyncFingerprint {
    name: string;
    exists: boolean;
    archived: boolean;
    fingerprint: string | null;
    strategyCount: number;
    variantCount: number;
}

export interface EnvironmentSyncFingerprints {
    version: number;
    environmentAvailable: boolean;
    features: EnvironmentSyncFingerprint[];
}

export interface EnvironmentSyncRemoteConfig extends EnvironmentSyncConfig {
    version: number;
    environmentAvailable: boolean;
    exists: boolean;
    archived: boolean;
}

export type EnvironmentSyncApplyStatus = 'synced' | 'skipped' | 'error';

export interface EnvironmentSyncApplyResult {
    featureName: string;
    status: EnvironmentSyncApplyStatus;
    created?: boolean;
    error?: string;
}

export interface EnvironmentSyncApplyResponse {
    results: EnvironmentSyncApplyResult[];
}

export interface EnvironmentSyncConnectionResult {
    ok: boolean;
    environments: string[];
    projectExists?: boolean;
    error?: string;
}

export interface EnvironmentSyncApplyConfigInput {
    featureName: string;
    strategies: EnvironmentSyncStrategy[];
    variants: EnvironmentSyncVariant[];
}

export interface IEnvironmentSyncClient {
    testConnection(input: {
        url: string;
        token: string;
        project?: string | null;
    }): Promise<EnvironmentSyncConnectionResult>;
    fingerprints(
        target: EnvironmentSyncRemoteTarget,
        input: {
            projectId: string;
            environment: string;
            featureNames?: string[];
        },
    ): Promise<EnvironmentSyncFingerprints>;
    config(
        target: EnvironmentSyncRemoteTarget,
        input: { projectId: string; environment: string; featureName: string },
    ): Promise<EnvironmentSyncRemoteConfig>;
    applyConfigs(
        target: EnvironmentSyncRemoteTarget,
        input: {
            projectId: string;
            environment: string;
            configs: EnvironmentSyncApplyConfigInput[];
        },
    ): Promise<EnvironmentSyncApplyResponse>;
}

export class EnvironmentSyncRemoteError extends Error {
    readonly status?: number;

    constructor(message: string, status?: number) {
        super(message);
        this.name = 'EnvironmentSyncRemoteError';
        this.status = status;
    }
}

const TIMEOUTS = {
    test: 10_000,
    fingerprints: 10_000,
    config: 10_000,
    apply: 60_000,
} as const;

export class EnvironmentSyncClient implements IEnvironmentSyncClient {
    private readonly allowPrivateUrls: boolean;

    private readonly allowList: string[];

    constructor(
        config: Pick<
            IUnleashConfig,
            'allowPrivateUrlInIntegration' | 'allowListIntegration'
        >,
    ) {
        this.allowPrivateUrls = config.allowPrivateUrlInIntegration ?? false;
        this.allowList = config.allowListIntegration ?? [];
    }

    private async request<T>(
        rawUrl: string,
        token: string,
        options: {
            method: 'GET' | 'POST';
            body?: unknown;
            timeout: number;
        },
    ): Promise<T> {
        const validated = await validateUrl(rawUrl, {
            allowPrivateNetworkUrls: this.allowPrivateUrls,
            allowList: { hosts: this.allowList, suffixes: [] },
        });

        let response: Response;
        try {
            response = await fetchPinned(validated, {
                method: options.method,
                timeout: options.timeout,
                headers: {
                    Authorization: token,
                    'Content-Type': 'application/json',
                },
                ...(options.body !== undefined && { json: options.body }),
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            throw new EnvironmentSyncRemoteError(
                `Could not reach the target instance: ${message}`,
            );
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new EnvironmentSyncRemoteError(
                remoteErrorMessage(response.status, text),
                response.status,
            );
        }

        try {
            return (await response.json()) as T;
        } catch {
            throw new EnvironmentSyncRemoteError(
                'The target instance returned an unexpected response',
            );
        }
    }

    async testConnection(input: {
        url: string;
        token: string;
        project?: string | null;
    }): Promise<EnvironmentSyncConnectionResult> {
        try {
            const environments = await this.request<{
                environments?: { name: string }[];
            }>(
                `${normalizeUrl(input.url)}/api/admin/environments`,
                input.token,
                { method: 'GET', timeout: TIMEOUTS.test },
            );

            let projectExists: boolean | undefined;
            if (input.project) {
                try {
                    await this.request(
                        `${normalizeUrl(input.url)}/api/admin/projects/${encodeURIComponent(
                            input.project,
                        )}/overview`,
                        input.token,
                        { method: 'GET', timeout: TIMEOUTS.test },
                    );
                    projectExists = true;
                } catch (error) {
                    if (
                        error instanceof EnvironmentSyncRemoteError &&
                        error.status === 404
                    ) {
                        projectExists = false;
                    } else {
                        throw error;
                    }
                }
            }

            return {
                ok: true,
                environments: (environments.environments ?? []).map(
                    (environment) => environment.name,
                ),
                projectExists,
            };
        } catch (error) {
            return {
                ok: false,
                environments: [],
                error: errorMessage(error),
            };
        }
    }

    async fingerprints(
        target: EnvironmentSyncRemoteTarget,
        input: {
            projectId: string;
            environment: string;
            featureNames?: string[];
        },
    ): Promise<EnvironmentSyncFingerprints> {
        return this.request<EnvironmentSyncFingerprints>(
            `${normalizeUrl(target.url)}/api/admin/environment-sync/fingerprints`,
            target.token,
            {
                method: 'POST',
                timeout: TIMEOUTS.fingerprints,
                body: input,
            },
        );
    }

    async config(
        target: EnvironmentSyncRemoteTarget,
        input: { projectId: string; environment: string; featureName: string },
    ): Promise<EnvironmentSyncRemoteConfig> {
        return this.request<EnvironmentSyncRemoteConfig>(
            `${normalizeUrl(target.url)}/api/admin/environment-sync/config`,
            target.token,
            {
                method: 'POST',
                timeout: TIMEOUTS.config,
                body: input,
            },
        );
    }

    async applyConfigs(
        target: EnvironmentSyncRemoteTarget,
        input: {
            projectId: string;
            environment: string;
            configs: EnvironmentSyncApplyConfigInput[];
        },
    ): Promise<EnvironmentSyncApplyResponse> {
        return this.request<EnvironmentSyncApplyResponse>(
            `${normalizeUrl(target.url)}/api/admin/environment-sync/apply-configs`,
            target.token,
            {
                method: 'POST',
                timeout: TIMEOUTS.apply,
                body: input,
            },
        );
    }
}

export const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const remoteErrorMessage = (status: number, body: string): string => {
    if (status === 401 || status === 403) {
        return 'The target rejected the token. Use an admin token with access to the project.';
    }
    if (status === 404) {
        return 'The target does not expose environment sync, or the project/environment does not exist there.';
    }
    const shortBody = body.trim().slice(0, 200);
    return `The target returned ${status}${shortBody ? `: ${shortBody}` : ''}`;
};
