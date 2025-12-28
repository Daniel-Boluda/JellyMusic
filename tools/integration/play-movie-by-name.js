require('./bootstrap-jellyfin')();

const JellyFin = require('../../src/jellyfin-api.js');
const { PlayMovieIntent } = require('../../src/skill/movie-intents.js');
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

(async () => {
    const movieName = process.env.TEST_MOVIE_NAME || process.argv.slice(2).join(' ').trim();
    if (!movieName) {
        console.error('Usage: TEST_MOVIE_NAME="Movie Title" [TEST_DEVICE_NAME="Living Room"] node tools/integration/play-movie-by-name.js');
        process.exit(2);
    }

    const session = await pickSession();

    const expected = await JellyFin.ResolveMovieByName(movieName, { userId: session.UserId });
    if (!expected || !expected.Id) {
        console.error('Movie not found via ResolveMovieByName:', movieName);
        process.exit(4);
    }

    const handlerInput = makeHandlerInput({
        intentName: 'PlayMovieIntent',
        locale: process.env.TEST_LOCALE || 'es-ES',
        deviceId: process.env.ALEXA_DEVICE_ID || 'integration-device',
        slots: {
            moviename: { value: movieName },
            ...(process.env.TEST_DEVICE_NAME ? { devicename: { value: process.env.TEST_DEVICE_NAME } } : {})
        }
    });

    const response = await PlayMovieIntent.handle(handlerInput);

    const verify = await JellyFin.Sessions.waitForNowPlaying(
        session.Id,
        expected.Id,
        {
            attempts: Number(process.env.TEST_ATTEMPTS || 6),
            delay: Number(process.env.TEST_DELAY_MS || 1000)
        }
    );

    if (!verify.status) {
        console.error('FAIL: Remote playback did not start the expected movie.');
        if (verify.lastSession && verify.lastSession.NowPlayingItem) {
            console.error('NowPlayingItem:', verify.lastSession.NowPlayingItem.Name, verify.lastSession.NowPlayingItem.Id);
        }
        console.error('Alexa response summary:', response && response.outputSpeech ? response.outputSpeech.text : '<no speech>');
        process.exit(5);
    }

    console.log('PASS: Movie started on session:', session.DeviceName || session.Name);
    process.exit(0);
})();
