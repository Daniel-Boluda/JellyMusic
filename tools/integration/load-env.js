// Simple .env loader: reads key=value lines and sets process.env if not already set
const fs = require('fs');
const path = require('path');

module.exports = function loadEnv(envFile = '.env') {
    const envPath = path.resolve(process.cwd(), envFile);
    if (!fs.existsSync(envPath)) return;

    try {
        const data = fs.readFileSync(envPath, 'utf8');
        data.split('\n').forEach(line => {
            const trimmed = String(line).trim();
            if (!trimmed || trimmed.startsWith('#')) return;

            const eq = trimmed.indexOf('=');
            if (eq === -1) return;

            const key = trimmed.slice(0, eq).trim();
            let val = trimmed.slice(eq + 1).trim();

            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }

            if (process.env[key] === undefined || process.env[key] === '') process.env[key] = val;
        });
    } catch (e) {
        // Best effort: do not crash if .env is malformed
        console.error('load-env error:', e && (e.message || e));
    }
};
