'use strict';

exports.up = function (db, cb) {
    db.runSql(
        `
        ALTER TABLE environment_sync_targets
        ADD COLUMN IF NOT EXISTS ignored_config JSONB NOT NULL DEFAULT '{"parameters": [], "variantPayloads": [], "ignoredFeatures": []}'::jsonb;
        `,
        cb,
    );
};

exports.down = function (db, cb) {
    db.runSql(
        `
        ALTER TABLE environment_sync_targets DROP COLUMN IF EXISTS ignored_config;
        `,
        cb,
    );
};
