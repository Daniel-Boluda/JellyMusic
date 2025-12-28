const loadEnv = require('./load-env');

module.exports = function bootstrapJellyfin() {
    loadEnv();

    const host = process.env.JELLYFIN_HOST;
    const key = process.env.JELLYFIN_KEY;

    if (!host || !key) {
        console.error('Missing Jellyfin credentials. Set JELLYFIN_HOST and JELLYFIN_KEY in .env (repo root) or environment.');
        process.exit(2);
    }

    if (typeof fetch !== 'function') {
        console.error('This project expects Node 18+ (global fetch).');
        process.exit(2);
    }

    global.CONFIG = global.CONFIG || {};
    global.CONFIG.jellyfin = global.CONFIG.jellyfin || {};
    global.CONFIG.skill = global.CONFIG.skill || {};

    globalThis.CONFIG = global.CONFIG;
    CONFIG = global.CONFIG;

    global.CONFIG.jellyfin.host = host;
    global.CONFIG.jellyfin.key = key;
    global.CONFIG.jellyfin.limit = Number(process.env.JELLYFIN_LIMIT || global.CONFIG.jellyfin.limit || 10);

    global.CONFIG.skill.name = process.env.SKILL_NAME || global.CONFIG.skill.name || 'Jelly Music';
    // Skill id is not required by these integration scripts, but some code expects it present.
    global.CONFIG.skill.id = process.env.SKILL_ID || global.CONFIG.skill.id || 'integration-test-skill';

    return { host, limit: global.CONFIG.jellyfin.limit };
};
