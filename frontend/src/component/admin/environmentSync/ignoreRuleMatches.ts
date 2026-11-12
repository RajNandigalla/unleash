const PATTERN_SPECIAL = /[|\\{}()[\]^$+*?.-]/g;

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
            source += character.replace(PATTERN_SPECIAL, '\\$&');
        }
    }
    return new RegExp(`${source}$`).test(name);
};

export const matchesIgnoreRule = (
    flag: { name: string; tags: string[] },
    rule: string,
): boolean => {
    if (rule.startsWith('tag:')) {
        const pattern = rule.slice('tag:'.length).trim();
        return (
            Boolean(pattern) &&
            flag.tags.some((tag) => matchesFeaturePattern(tag, pattern))
        );
    }
    return matchesFeaturePattern(flag.name, rule);
};

export const countMatchingFlags = (
    flags: { name: string; tags: string[] }[],
    rules: string[],
): number =>
    flags.filter((flag) => rules.some((rule) => matchesIgnoreRule(flag, rule)))
        .length;
