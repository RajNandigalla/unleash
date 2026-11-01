import { useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { formatApiPath } from 'utils/formatPath';
import handleErrorResponses from '../httpErrorResponseHandler.js';
import type { EnvironmentSyncProjectStatus } from 'interfaces/environmentSync';

const fetchStatus = async (
    projectId: string,
    refresh = false,
): Promise<EnvironmentSyncProjectStatus> => {
    const url = formatApiPath(
        `api/admin/environment-sync/projects/${projectId}/status${
            refresh ? '?refresh=true' : ''
        }`,
    );
    const response = await fetch(url).then(
        handleErrorResponses('Environment sync status'),
    );
    return response.json();
};

export const useProjectSyncStatus = (projectId: string, enabled = true) => {
    const key = enabled
        ? formatApiPath(
              `api/admin/environment-sync/projects/${projectId}/status`,
          )
        : null;

    const { data, error, mutate, isLoading } =
        useSWR<EnvironmentSyncProjectStatus>(
            key,
            () => fetchStatus(projectId),
            {
                refreshInterval: 60_000,
                keepPreviousData: true,
            },
        );

    const refresh = useCallback(async () => {
        if (!enabled) {
            return undefined;
        }
        const fresh = await fetchStatus(projectId, true);
        await mutate(fresh, { revalidate: false });
        return fresh;
    }, [enabled, mutate, projectId]);

    const statuses = useMemo(
        () =>
            new Map(
                (data?.features ?? []).map((feature) => [
                    feature.featureName,
                    feature,
                ]),
            ),
        [data],
    );

    return {
        status: data,
        statuses,
        summary: data?.summary,
        loading: isLoading,
        error,
        refresh,
        refetch: mutate,
    };
};
