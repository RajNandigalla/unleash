import { describe, expect, test } from 'vitest';
import {
    deletePointer,
    getPointer,
    hasPointer,
    matchesFeaturePattern,
    mergeWildcardFields,
    parseIgnoredEntry,
    parseJsonPointer,
    setPointer,
} from './environment-sync-paths.js';

describe('parseIgnoredEntry', () => {
    test('parses a whole value', () => {
        expect(parseIgnoredEntry('loginUrl')).toEqual({
            name: 'loginUrl',
            pointer: null,
        });
    });

    test('parses a nested path', () => {
        expect(parseIgnoredEntry('config::/sso/loginUrl')).toEqual({
            name: 'config',
            pointer: ['sso', 'loginUrl'],
        });
    });

    test('parses a nested path for every variant', () => {
        expect(parseIgnoredEntry('*::/redirectUrl')).toEqual({
            name: '*',
            pointer: ['redirectUrl'],
        });
    });

    test('keeps dots in the name unambiguous', () => {
        expect(parseIgnoredEntry('v1.2')).toEqual({
            name: 'v1.2',
            pointer: null,
        });
        expect(parseIgnoredEntry('v1.2::/settings/theme')).toEqual({
            name: 'v1.2',
            pointer: ['settings', 'theme'],
        });
    });

    test('rejects a path without a leading slash', () => {
        expect(() => parseIgnoredEntry('config::sso/loginUrl')).toThrow(
            'must start with "/"',
        );
    });

    test('rejects prototype pollution segments', () => {
        expect(() => parseIgnoredEntry('config::/__proto__/polluted')).toThrow(
            'not allowed',
        );
        expect(() => parseIgnoredEntry('config::/constructor')).toThrow(
            'not allowed',
        );
    });

    test('rejects an empty entry', () => {
        expect(() => parseIgnoredEntry('   ')).toThrow('needs a');
    });
});

describe('parseJsonPointer', () => {
    test('unescapes ~0 and ~1', () => {
        expect(parseJsonPointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    });

    test('supports array indices', () => {
        expect(parseJsonPointer('/items/0/url')).toEqual(['items', '0', 'url']);
    });
});

describe('matchesFeaturePattern', () => {
    test('matches exact names', () => {
        expect(matchesFeaturePattern('login-url', 'login-url')).toBe(true);
        expect(matchesFeaturePattern('login-url', 'login')).toBe(false);
    });

    test('matches globs', () => {
        expect(matchesFeaturePattern('legacy-login', 'legacy-*')).toBe(true);
        expect(matchesFeaturePattern('legacy-login', 'legacy-?ogin')).toBe(
            true,
        );
        expect(matchesFeaturePattern('new-login', 'legacy-*')).toBe(false);
    });

    test('treats regex characters literally', () => {
        expect(matchesFeaturePattern('v1.2', 'v1.2')).toBe(true);
        expect(matchesFeaturePattern('v1x2', 'v1.2')).toBe(false);
    });
});

describe('pointers', () => {
    const value = {
        sso: { loginUrl: 'https://ab-test.com', timeout: 5 },
        items: [{ url: 'a' }, { url: 'b' }],
    };

    test('reads nested values', () => {
        expect(getPointer(value, ['sso', 'loginUrl'])).toEqual({
            found: true,
            value: 'https://ab-test.com',
        });
        expect(getPointer(value, ['items', '1', 'url'])).toEqual({
            found: true,
            value: 'b',
        });
        expect(hasPointer(value, ['sso', 'missing'])).toBe(false);
    });

    test('sets nested values, creating containers', () => {
        const target: Record<string, unknown> = {};
        expect(setPointer(target, ['sso', 'loginUrl'], 'x')).toBe(true);
        expect(target).toEqual({ sso: { loginUrl: 'x' } });

        expect(setPointer(target, ['items', '0', 'url'], 'y')).toBe(true);
        expect(target).toEqual({
            sso: { loginUrl: 'x' },
            items: [{ url: 'y' }],
        });
    });

    test('deletes nested values', () => {
        const target = structuredClone(value);
        expect(deletePointer(target, ['sso', 'loginUrl'])).toBe(true);
        expect(target.sso).toEqual({ timeout: 5 });

        expect(deletePointer(target, ['items', '0'])).toBe(true);
        expect(target.items).toEqual([{ url: 'b' }]);

        expect(deletePointer(target, ['sso', 'missing'])).toBe(false);
    });
});

describe('wildcard paths', () => {
    test('parses a wildcard segment', () => {
        expect(parseIgnoredEntry('*::/items/*/url')).toEqual({
            name: '*',
            pointer: ['items', '*', 'url'],
        });
    });

    test('rejects a trailing wildcard', () => {
        expect(() => parseIgnoredEntry('config::/items/*')).toThrow(
            'must be followed',
        );
    });

    test('deletes the field from every array element', () => {
        const value = {
            items: [
                { url: 'a', id: 1 },
                { url: 'b', id: 2 },
            ],
        };

        expect(deletePointer(value, ['items', '*', 'url'])).toBe(true);
        expect(value).toEqual({ items: [{ id: 1 }, { id: 2 }] });
    });

    test('merges the field across array elements by index', () => {
        const incoming = {
            items: [
                { url: 'in-1', id: 1 },
                { url: 'in-2', id: 2 },
            ],
        };
        const existing = {
            items: [
                { url: 'keep-1', id: 9 },
                { url: 'keep-2', id: 8 },
            ],
        };

        expect(
            mergeWildcardFields(incoming, existing, ['items', '*', 'url']),
        ).toEqual([]);
        expect(incoming).toEqual({
            items: [
                { url: 'keep-1', id: 1 },
                { url: 'keep-2', id: 2 },
            ],
        });
    });

    test('merges nested wildcards', () => {
        const incoming = { items: [{ options: [{ v: 'in' }, { v: 'in2' }] }] };
        const existing = {
            items: [{ options: [{ v: 'keep' }, { v: 'keep2' }] }],
        };

        expect(
            mergeWildcardFields(incoming, existing, [
                'items',
                '*',
                'options',
                '*',
                'v',
            ]),
        ).toEqual([]);
        expect(incoming.items[0].options).toEqual([
            { v: 'keep' },
            { v: 'keep2' },
        ]);
    });

    test('reports a wildcard it cannot restore', () => {
        const incoming = { items: [{ url: 'in-1' }] };
        const existing = { items: [{ url: 'keep-1' }, { url: 'keep-2' }] };

        expect(
            mergeWildcardFields(incoming, existing, ['items', '*', 'url']),
        ).toEqual(['/items/*/url']);
    });
});
