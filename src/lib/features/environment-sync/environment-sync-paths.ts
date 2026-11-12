import { BadDataError } from '../../error/index.js';

export const MAX_IGNORE_ENTRIES = 200;
export const MAX_IGNORE_ENTRY_LENGTH = 300;
export const MAX_POINTER_DEPTH = 20;

/**
 * Entries look like `loginUrl` (the whole value) or
 * `config::/sso/loginUrl` (one field inside a JSON value).
 *
 * `::` is used instead of a dot separator because strategy parameter names are
 * unconstrained and feature/variant names are URL friendly, which means they
 * can contain dots (e.g. `v1.2`). Splitting on the first `::` keeps the
 * top-level name unambiguous.
 */
export const IGNORE_ENTRY_SEPARATOR = '::';

export const WILDCARD_SEGMENT = '*';

export const hasWildcard = (path: string[]): boolean =>
    path.includes(WILDCARD_SEGMENT);

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Path segments the pointer parser refuses, so they must not be offered. */
export const isForbiddenSegment = (segment: string): boolean =>
    FORBIDDEN_SEGMENTS.has(segment);

export interface IgnoredEntry {
    name: string;
    /** `null` means the whole value is environment specific. */
    pointer: string[] | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isArrayIndex = (segment: string): boolean =>
    /^(0|[1-9]\d*)$/.test(segment);

export const formatJsonPointer = (segments: string[]): string =>
    `/${segments
        .map((segment) => segment.replace(/~/g, '~0').replace(/\//g, '~1'))
        .join('/')}`;

export const parseJsonPointer = (raw: string): string[] => {
    if (!raw.startsWith('/')) {
        throw new BadDataError(
            `A nested path must start with "/" (got "${raw}")`,
        );
    }
    const segments = raw
        .slice(1)
        .split('/')
        .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

    if (segments.length > MAX_POINTER_DEPTH) {
        throw new BadDataError(
            `A nested path can be at most ${MAX_POINTER_DEPTH} levels deep`,
        );
    }
    for (const segment of segments) {
        if (FORBIDDEN_SEGMENTS.has(segment)) {
            throw new BadDataError(
                `"${segment}" is not allowed in a nested path`,
            );
        }
    }
    if (segments[segments.length - 1] === WILDCARD_SEGMENT) {
        throw new BadDataError(
            'A wildcard ("[]") must be followed by a field name',
        );
    }
    return segments;
};

export const parseIgnoredEntry = (raw: string): IgnoredEntry => {
    const trimmed = raw.trim();
    const separator = trimmed.indexOf(IGNORE_ENTRY_SEPARATOR);
    const name =
        separator === -1 ? trimmed : trimmed.slice(0, separator).trim();

    if (!name) {
        throw new BadDataError(
            'An environment-specific entry needs a parameter, variant or flag name',
        );
    }
    if (separator === -1) {
        return { name, pointer: null };
    }

    const pointer = trimmed
        .slice(separator + IGNORE_ENTRY_SEPARATOR.length)
        .trim();
    return { name, pointer: parseJsonPointer(pointer) };
};

/**
 * `*` matches any run of characters, `?` matches a single character. This is
 * deliberately small: no dependency, no brace expansion, no path semantics.
 */
export const matchesFeaturePattern = (
    name: string,
    pattern: string,
): boolean => {
    if (pattern === '*') {
        return true;
    }
    let source = '^';
    for (const character of pattern) {
        if (character === '*') {
            source += '.*';
        } else if (character === '?') {
            source += '.';
        } else {
            source += character.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
        }
    }
    source += '$';
    return new RegExp(source).test(name);
};

export const getPointer = (
    value: unknown,
    path: string[],
): { found: boolean; value?: unknown } => {
    let current: unknown = value;
    for (const segment of path) {
        if (Array.isArray(current)) {
            const index = Number(segment);
            if (
                !Number.isInteger(index) ||
                index < 0 ||
                index >= current.length
            ) {
                return { found: false };
            }
            current = current[index];
        } else if (isPlainObject(current)) {
            if (!Object.prototype.hasOwnProperty.call(current, segment)) {
                return { found: false };
            }
            current = current[segment];
        } else {
            return { found: false };
        }
    }
    return { found: true, value: current };
};

export const hasPointer = (value: unknown, path: string[]): boolean =>
    getPointer(value, path).found;

const containerFor = (segment: string): unknown[] | Record<string, unknown> =>
    isArrayIndex(segment) ? [] : {};

/**
 * Sets `value` at `path`, creating missing containers on the way. Returns
 * `false` when the existing structure cannot hold the path (e.g. a scalar in
 * the middle of the path).
 */
export const setPointer = (
    target: unknown,
    path: string[],
    value: unknown,
): boolean => {
    if (path.length === 0) {
        return false;
    }

    let current: unknown = target;
    for (let index = 0; index < path.length - 1; index += 1) {
        const segment = path[index];
        const next = path[index + 1];

        if (Array.isArray(current)) {
            const arrayIndex = Number(segment);
            if (
                !Number.isInteger(arrayIndex) ||
                arrayIndex < 0 ||
                arrayIndex > current.length
            ) {
                return false;
            }
            if (current[arrayIndex] === undefined) {
                current[arrayIndex] = containerFor(next);
            }
            current = current[arrayIndex];
        } else if (isPlainObject(current)) {
            if (current[segment] === undefined) {
                current[segment] = containerFor(next);
            }
            current = current[segment];
        } else {
            return false;
        }
    }

    const last = path[path.length - 1];
    if (Array.isArray(current)) {
        const arrayIndex = Number(last);
        if (
            !Number.isInteger(arrayIndex) ||
            arrayIndex < 0 ||
            arrayIndex > current.length
        ) {
            return false;
        }
        current[arrayIndex] = value;
        return true;
    }
    if (isPlainObject(current)) {
        current[last] = value;
        return true;
    }
    return false;
};

const readChild = (container: unknown, segment: string): unknown => {
    if (Array.isArray(container)) {
        const index = Number(segment);
        return Number.isInteger(index) && index >= 0 && index < container.length
            ? container[index]
            : undefined;
    }
    if (isPlainObject(container)) {
        return Object.prototype.hasOwnProperty.call(container, segment)
            ? container[segment]
            : undefined;
    }
    return undefined;
};

const writeChild = (
    container: unknown,
    segment: string,
    value: unknown,
): boolean => {
    if (Array.isArray(container)) {
        const index = Number(segment);
        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= container.length
        ) {
            return false;
        }
        container[index] = value;
        return true;
    }
    if (isPlainObject(container)) {
        container[segment] = value;
        return true;
    }
    return false;
};

const deleteAtPath = (
    current: unknown,
    path: string[],
    index: number,
): boolean => {
    if (index >= path.length) {
        return false;
    }
    const segment = path[index];
    const last = index === path.length - 1;

    if (segment === WILDCARD_SEGMENT) {
        if (!Array.isArray(current) || last) {
            return false;
        }
        let changed = false;
        for (const item of current) {
            changed = deleteAtPath(item, path, index + 1) || changed;
        }
        return changed;
    }

    if (Array.isArray(current)) {
        const arrayIndex = Number(segment);
        if (
            !Number.isInteger(arrayIndex) ||
            arrayIndex < 0 ||
            arrayIndex >= current.length
        ) {
            return false;
        }
        if (last) {
            current.splice(arrayIndex, 1);
            return true;
        }
        return deleteAtPath(current[arrayIndex], path, index + 1);
    }

    if (isPlainObject(current)) {
        if (!Object.prototype.hasOwnProperty.call(current, segment)) {
            return false;
        }
        if (last) {
            delete current[segment];
            return true;
        }
        return deleteAtPath(current[segment], path, index + 1);
    }
    return false;
};

/**
 * Deletes the pointed value. A `*` segment selects every element of the
 * current array, so `/items/*\/url` removes `url` from every item.
 */
export const deletePointer = (target: unknown, path: string[]): boolean =>
    deleteAtPath(target, path, 0);

/**
 * Restores wildcard fields from the existing (target) value into the incoming
 * one, element by element. Returns the wildcard paths that could not be
 * restored, so the caller can refuse the write instead of losing data.
 */
export const mergeWildcardFields = (
    incoming: unknown,
    existing: unknown,
    path: string[],
): string[] => {
    const lost: string[] = [];
    const label = `/${path.join('/')}`;

    const walk = (inc: unknown, ext: unknown, index: number): void => {
        const segment = path[index];
        const last = index === path.length - 1;

        if (segment === WILDCARD_SEGMENT) {
            if (!Array.isArray(ext)) {
                return;
            }
            if (!Array.isArray(inc)) {
                lost.push(label);
                return;
            }
            const length = Math.min(inc.length, ext.length);
            for (let item = 0; item < length; item += 1) {
                walk(inc[item], ext[item], index + 1);
            }
            if (ext.length > inc.length) {
                lost.push(label);
            }
            return;
        }

        if (last) {
            const existingValue = readChild(ext, segment);
            if (existingValue === undefined) {
                return;
            }
            if (!writeChild(inc, segment, existingValue)) {
                lost.push(label);
            }
            return;
        }

        const incomingChild = readChild(inc, segment);
        const existingChild = readChild(ext, segment);
        if (incomingChild === undefined || existingChild === undefined) {
            return;
        }
        walk(incomingChild, existingChild, index + 1);
    };

    walk(incoming, existing, 0);
    return lost;
};
