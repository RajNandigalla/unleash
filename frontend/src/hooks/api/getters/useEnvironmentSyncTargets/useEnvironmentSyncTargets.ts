import useSWR from 'swr';
import { formatApiPath } from 'utils/formatPath';
import handleErrorResponses from '../httpErrorResponseHandler.js';
import type { EnvironmentSyncTargetsResponse } from 'interfaces/environmentSync';

const path = formatApiPath('api/admin/environment-sync/targets');

export const useEnvironmentSyncTargets = (enabled = true) => {
    const { data, error, mutate, isLoading } =
        useSWR<EnvironmentSyncTargetsResponse>(enabled ? path : null, fetcher);

    return {
        data,
        targets: data?.targets ?? [],
        tokenStorageConfigured: data?.tokenStorageConfigured ?? false,
        loading: isLoading,
        error,
        refetch: mutate,
    };
};

const fetcher = async (
    url: string,
): Promise<EnvironmentSyncTargetsResponse> => {
    const response = await fetch(url).then(
        handleErrorResponses('Environment sync'),
    );
    return response.json();
};
