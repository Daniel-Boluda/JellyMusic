require('./bootstrap-jellyfin')();

const JellyFin = require('../../src/jellyfin-api.js');
const { PlaySeriesIntent } = require('../../src/skill/movie-intents.js');
const { makeHandlerInput } = require('./alexa-harness');

const pickSession = async () => {
    const deviceName = process.env.TEST_DEVICE_NAME;
    const res = await JellyFin.Sessions.list();

    if (!res.status || !res.items || !res.items.length) {
        console.error('No Jellyfin sessions available. Open a Jellyfin client (TV/app) with remote control enabled.');
        process.exit(3);
    }

    if (deviceName) {
        const found = await JellyFin.Sessions.findByDeviceName(deviceName);
        if (found.status === 'ok') return found.session;
        if (found.status === 'ambiguous') {
            console.error('Device name is ambiguous. Matches:', found.matches.join(', '));
            process.exit(3);
        }
        console.error('Device not found. Available devices:', res.items.map(s => s.DeviceName || s.Name).join(', '));
        process.exit(3);
    }

    if (res.items.length === 1) return res.items[0];

    console.error('Multiple sessions found. Set TEST_DEVICE_NAME to pick one. Available:', res.items.map(s => s.DeviceName || s.Name).join(', '));
    process.exit(3);
};

const waitForNowPlayingInSet = async (sessionId, allowedIds, opts = {}) => {
    const attempts = Number(opts.attempts || 6);
    const delay = Number(opts.delay || 1000);

    for (let i = 0; i < attempts; i++) {
        const res = await JellyFin.Sessions.list();
        if (!res.status) return { status: false, error: res.error };
        const s = (res.items || []).find(it => it && it.Id === sessionId);
        const id = s && s.NowPlayingItem && s.NowPlayingItem.Id;
        if (id && allowedIds.has(id)) return { status: true, session: s, attempt: i + 1 };
        await new Promise(r => setTimeout(r, delay));
    }

    const lastRes = await JellyFin.Sessions.list();
    const last = (lastRes && lastRes.items) ? lastRes.items.find(it => it && it.Id === sessionId) : null;
    return { status: false, error: 'Did not start an episode from expected series', lastSession: last };
};

(async () => {
    const seriesName = process.env.TEST_SERIES_NAME || process.argv.slice(2).join(' ').trim();
    if (!seriesName) {
        console.error('Usage: TEST_SERIES_NAME="Series Title" [TEST_DEVICE_NAME="Living Room"] node tools/integration/play-series-by-name.js');
        process.exit(2);
    }

    const session = await pickSession();

    const series = await JellyFin.ResolveSeriesByName(seriesName);
    if (!series || !series.Id) {
        console.error('Series not found via ResolveSeriesByName:', seriesName);
        process.exit(4);
    }

    const eps = await JellyFin.Episodes({ seriesId: series.Id, Recursive: true, Limit: 500 });
    if (!eps.status || !eps.items || !eps.items.length) {
        console.error('No episodes found for series:', seriesName);
        process.exit(4);
    }

    const allowedIds = new Set((eps.items || []).map(it => it && it.Id).filter(Boolean));

    const handlerInput = makeHandlerInput({
        intentName: 'PlaySeriesIntent',
        locale: process.env.TEST_LOCALE || 'es-ES',
        deviceId: process.env.ALEXA_DEVICE_ID || 'integration-device',
        slots: {
            seriesname: { value: seriesName },
            ...(process.env.TEST_DEVICE_NAME ? { devicename: { value: process.env.TEST_DEVICE_NAME } } : {})
        }
    });

    const response = await PlaySeriesIntent.handle(handlerInput);

    const verify = await waitForNowPlayingInSet(session.Id, allowedIds, {
        attempts: Number(process.env.TEST_ATTEMPTS || 6),
        delay: Number(process.env.TEST_DELAY_MS || 1000)
    });

    if (!verify.status) {
        console.error('FAIL: Remote playback did not start an episode from the requested series.');
        if (verify.lastSession && verify.lastSession.NowPlayingItem) {
            console.error('NowPlayingItem:', verify.lastSession.NowPlayingItem.Name, verify.lastSession.NowPlayingItem.Id);
        }
        console.error('Alexa response summary:', response && response.outputSpeech ? response.outputSpeech.text : '<no speech>');
        process.exit(5);
    }

    console.log('PASS: Series playback started on session:', session.DeviceName || session.Name);
    process.exit(0);
})();
