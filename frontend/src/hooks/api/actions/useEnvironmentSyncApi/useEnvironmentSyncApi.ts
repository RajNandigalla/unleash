import useAPI from '../useApi/useApi.js';
import { formatApiPath } from 'utils/formatPath';
import type {
    EnvironmentSyncSyncResponse,
    EnvironmentSyncTarget,
    EnvironmentSyncTargetInput,
    EnvironmentSyncTestResult,
} from 'interfaces/environmentSync';

const ENDPOINT = formatApiPath('api/admin/environment-sync');

export const useEnvironmentSyncApi = () => {
    const { loading, makeRequest, createRequest, errors } = useAPI({
        propagateErrors: true,
    });

    const createTarget = async (
        input: EnvironmentSyncTargetInput,
    ): Promise<EnvironmentSyncTarget> => {
        const requestId = 'createEnvironmentSyncTarget';
        const request = createRequest(
            `${ENDPOINT}/targets`,
            {
                method: 'POST',
                body: JSON.stringify(input),
            },
            requestId,
        );
        const response = await makeRequest(request.caller, request.id);
        return response.json();
    };

    const updateTarget = async (
        id: number,
        input: EnvironmentSyncTargetInput,
    ): Promise<EnvironmentSyncTarget> => {
        const requestId = 'updateEnvironmentSyncTarget';
        const request = createRequest(
            `${ENDPOINT}/targets/${id}`,
            {
                method: 'PUT',
                body: JSON.stringify(input),
            },
            requestId,
        );
        const response = await makeRequest(request.caller, request.id);
        return response.json();
    };

    const deleteTarget = async (id: number): Promise<void> => {
        const requestId = 'deleteEnvironmentSyncTarget';
        const request = createRequest(
            `${ENDPOINT}/targets/${id}`,
            { method: 'DELETE' },
            requestId,
        );
        await makeRequest(request.caller, request.id);
    };

    const testTarget = async (input: {
        url: string;
        token: string;
        project?: string | null;
        targetEnvironment?: string;
    }): Promise<EnvironmentSyncTestResult> => {
        const requestId = 'testEnvironmentSyncTarget';
        const request = createRequest(
            `${ENDPOINT}/targets/test`,
            {
                method: 'POST',
                body: JSON.stringify(input),
            },
            requestId,
        );
        const response = await makeRequest(request.caller, request.id);
        return response.json();
    };

    const testTargetById = async (
        id: number,
    ): Promise<EnvironmentSyncTestResult> => {
        const requestId = 'testEnvironmentSyncTargetById';
        const request = createRequest(
            `${ENDPOINT}/targets/${id}/test`,
            { method: 'POST' },
            requestId,
        );
        const response = await makeRequest(request.caller, request.id);
        return response.json();
    };

    const sync = async (input: {
        projectId: string;
        featureNames: string[];
        targetIds?: number[];
        onlyOutOfSync?: boolean;
    }): Promise<EnvironmentSyncSyncResponse> => {
        const requestId = 'syncEnvironmentConfig';
        const request = createRequest(
            `${ENDPOINT}/projects/${input.projectId}/sync`,
            {
                method: 'POST',
                body: JSON.stringify({
                    featureNames: input.featureNames,
                    targetIds: input.targetIds,
                    onlyOutOfSync: input.onlyOutOfSync,
                }),
            },
            requestId,
        );
        const response = await makeRequest(request.caller, request.id);
        return response.json();
    };

    return {
        createTarget,
        updateTarget,
        deleteTarget,
        testTarget,
        testTargetById,
        sync,
        loading,
        errors,
    };
};
