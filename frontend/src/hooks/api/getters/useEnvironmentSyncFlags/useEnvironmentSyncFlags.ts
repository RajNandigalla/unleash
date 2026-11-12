import useSWR from 'swr';
import { formatApiPath } from 'utils/formatPath';
import handleErrorResponses from '../httpErrorResponseHandler.js';
import type { EnvironmentSyncFlagsResponse } from 'interfaces/environmentSync';

const path = formatApiPath('api/admin/environment-sync/flags');

export const useEnvironmentSyncFlags = (enabled = true) => {
    const { data, error, mutate, isLoading } =
        useSWR<EnvironmentSyncFlagsResponse>(enabled ? path : null, fetcher);

    return {
        flags: data?.flags ?? [],
        loading: isLoading,
        error,
        refetch: mutate,
    };
};

const fetcher = async (url: string): Promise<EnvironmentSyncFlagsResponse> => {
    const response = await fetch(url).then(
        handleErrorResponses('Environment sync flags'),
    );
    return response.json();
};
