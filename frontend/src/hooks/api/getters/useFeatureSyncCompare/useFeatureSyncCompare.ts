import useSWR from 'swr';
import { formatApiPath } from 'utils/formatPath';
import handleErrorResponses from '../httpErrorResponseHandler.js';
import type { EnvironmentSyncFeatureCompare } from 'interfaces/environmentSync';

const fetchCompare = async (
    projectId: string,
    featureName: string,
): Promise<EnvironmentSyncFeatureCompare> => {
    const url = formatApiPath(
        `api/admin/environment-sync/projects/${projectId}/features/${featureName}/compare`,
    );
    const response = await fetch(url).then(
        handleErrorResponses('Environment sync compare'),
    );
    return response.json();
};

export const useFeatureSyncCompare = (
    projectId: string,
    featureName: string,
    enabled = true,
) => {
    const key = enabled
        ? formatApiPath(
              `api/admin/environment-sync/projects/${projectId}/features/${featureName}/compare`,
          )
        : null;

    const { data, error, mutate, isLoading } =
        useSWR<EnvironmentSyncFeatureCompare>(key, () =>
            fetchCompare(projectId, featureName),
        );

    return {
        compare: data,
        loading: isLoading,
        error,
        refetch: mutate,
    };
};
