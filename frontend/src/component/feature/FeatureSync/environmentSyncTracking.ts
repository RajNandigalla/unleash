import type { Tracking } from 'utils/trackingEvents';

export const syncConfigurationTracking: Tracking = {
    event: 'environment-sync',
    type: 'apply-sync',
};

export const addEnvironmentTracking: Tracking = {
    event: 'environment-sync',
    type: 'add-environment',
};
