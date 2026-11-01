'use strict';

exports.up = function (db, cb) {
    db.runSql(
        `
        CREATE TABLE IF NOT EXISTS environment_sync_targets (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            url TEXT NOT NULL,
            token_enc BYTEA NOT NULL,
            project TEXT,
            source_environment TEXT NOT NULL,
            target_environment TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            created_by TEXT,
            last_tested_at TIMESTAMP WITH TIME ZONE,
            last_test_status TEXT,
            last_test_error TEXT,
            last_synced_at TIMESTAMP WITH TIME ZONE,
            last_sync_status TEXT,
            last_sync_error TEXT
        );
        `,
        cb,
    );
};

exports.down = function (db, cb) {
    db.runSql(
        `
        DROP TABLE IF EXISTS environment_sync_targets;
        `,
        cb,
    );
};
