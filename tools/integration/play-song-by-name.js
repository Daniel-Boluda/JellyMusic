require('./bootstrap-jellyfin')();

const JellyFin = require('../../src/jellyfin-api.js');
const { PlaySongIntent } = require('../../src/skill/song-intents.js');
const { makeHandlerInput } = require('./alexa-harness');

const pickExpectedSong = async (songName, artistName) => {
    const songs = await JellyFin.Music.Search(songName);
    if (!songs.status || !songs.items || !songs.items.length) return null;

    let song = songs.items[0];

    if (artistName) {
        const artists = await JellyFin.Artists.Search(artistName);
        const artist = (artists && artists.status && artists.items && artists.items[0]) ? artists.items[0] : null;
        if (artist && song.AlbumArtist && String(song.AlbumArtist).toLowerCase() !== String(artist.Name).toLowerCase()) {
            const match = songs.items.find(it => it && it.AlbumArtist && String(it.AlbumArtist).toLowerCase() === String(artist.Name).toLowerCase());
            if (match) song = match;
        }
    }

    return song;
};

(async () => {
    const songName = process.env.TEST_SONG_NAME || process.argv[2];
    const artistName = process.env.TEST_ARTIST_NAME || process.argv.slice(3).join(' ').trim() || null;

    if (!songName) {
        console.error('Usage: TEST_SONG_NAME="Song Title" [TEST_ARTIST_NAME="Artist"] node tools/integration/play-song-by-name.js');
        process.exit(2);
    }

    const expected = await pickExpectedSong(songName, artistName);
    if (!expected || !expected.Id) {
        console.error('Song not found via Jellyfin search:', songName);
        process.exit(4);
    }

    const handlerInput = makeHandlerInput({
        intentName: 'PlaySongIntent',
        locale: process.env.TEST_LOCALE || 'es-ES',
        deviceId: process.env.ALEXA_DEVICE_ID || 'integration-device',
        slots: {
            songname: { value: songName },
            ...(artistName ? { artistname: { value: artistName } } : {})
        }
    });

    const response = await PlaySongIntent.handle(handlerInput);

    const directives = response && response.directives ? response.directives : [];
    const play = directives.find(d => d && d.type === 'AudioPlayer.Play');

    if (!play || !play.audioItem || !play.audioItem.stream || !play.audioItem.stream.url) {
        console.error('FAIL: No AudioPlayer.Play directive returned');
        process.exit(5);
    }

    const url = new URL(play.audioItem.stream.url);
    const expectedPath = `/Audio/${expected.Id}/universal`;

    if (url.pathname !== expectedPath) {
        console.error('FAIL: Stream URL does not match expected item.');
        console.error('Expected pathname:', expectedPath);
        console.error('Actual pathname:', url.pathname);
        process.exit(5);
    }

    console.log('PASS: Song directive points to expected item id:', expected.Id);
    process.exit(0);
})();
