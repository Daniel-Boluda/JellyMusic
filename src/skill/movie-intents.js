const Alexa = require('ask-sdk-core');
const Log = require('../logger.js');
const JellyFin = require('../jellyfin-api.js');
const { CreateIntent } = require('./alexa-helper.js');
const { tFor } = require('./i18n');
const fs = require('fs');
const path = require('path');

// Cache playback device definitions per locale
const playbackDeviceCache = {}; 

const getPlaybackDeviceValuesForLocale = function(locale) {
    const lang = String((locale || '').split('-')[0] || 'en').toLowerCase();
    if (playbackDeviceCache[lang]) return playbackDeviceCache[lang];

    const fileMap = { en: 'skill-EN.json', es: 'skill-ES.json' };
    const fileName = fileMap[lang] || fileMap.en;
    const filePath = path.join(__dirname, '..', '..', 'skill-json', fileName);

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const json = JSON.parse(raw);
        const types = json && json.interactionModel && json.interactionModel.languageModel && json.interactionModel.languageModel.types;
        if (Array.isArray(types)) {
            const t = types.find(tt => tt.name === 'PLAYBACK_DEVICE');
            if (t && Array.isArray(t.values)) {
                const vals = t.values.map(v => v && v.name && v.name.value).filter(Boolean);
                playbackDeviceCache[lang] = vals;
                return vals;
            }
        }
    } catch (e) {
        try { Log.warn('[Intent] Failed to load skill JSON for playback devices', filePath, e.message); } catch (inner) {}
    }

    playbackDeviceCache[lang] = [];
    return [];
};

// Sessions-based remote control (Jellyfin remote play)
const buildArtURL = function(item) {
    if (!item || !item.Id) return undefined;
    const url = new URL(`/Items/${item.Id}/Images/Primary`, CONFIG.jellyfin.host);
    if (item.PrimaryImageTag) url.searchParams.append('tag', item.PrimaryImageTag);
    return url.toString();
};

// Resolve session by friendly device name
const findSessionByDeviceName = async function(deviceName) {
    const res = await JellyFin.Sessions.findByDeviceName(deviceName);
    return res;
};

// Close the Alexa overlay ASAP (Fire TV Cube): speak briefly and end session.
const endNow = (rb, speech) =>
    rb.speak(speech).withShouldEndSession(true).getResponse();




/*********************************************************************************
 * Exports
 */

// Helpers: persistence and video state
const getAttrManager = (handlerInput) => {
    const am = handlerInput.attributesManager;
    return {
        async load() {
            let persistent = {};
            try { persistent = await am.getPersistentAttributes() || {}; } catch (e) { persistent = {}; }
            const session = am.getSessionAttributes() || {};
            // ensure video namespace
            persistent.video = persistent.video || {};
            session.video = session.video || {};
            return { persistent, session, am };
        },
        async savePersistent(persistent) {
            try { am.setPersistentAttributes(persistent); await am.savePersistentAttributes(); } catch (e) { const msg = e && e.message || ''; if (msg.includes('Cannot set PersistentAttributes without persistence adapter')) try { Log.debug('[Attributes] Persistence adapter not configured'); } catch (inner) {} else try { Log.warn('[Attributes] Failed to save persistent attributes', msg); } catch (inner) {} }
        },
        setSession(session) { am.setSessionAttributes(session); }
    };
};

// Resolve an active device using persisted state or by querying Jellyfin
const resolveActiveDevice = async function(handlerInput, preferredDeviceName) {
    const m = getAttrManager(handlerInput);
    const { persistent, session } = await m.load();

    // Provided override takes precedence
    const overrideName = preferredDeviceName && String(preferredDeviceName).trim();

    const listRes = await JellyFin.Sessions.list();
    if (!listRes.status || !listRes.items || !listRes.items.length) return { status: 'not-found' };

    // If override provided, try to match it first
    if (overrideName) {
        const match = await JellyFin.Sessions.findByDeviceName(overrideName);
        if (match.status === 'ok') return { status: 'ok', session: match.session, persist: true };
        if (match.status === 'ambiguous') return { status: 'ambiguous', matches: match.matches };
        return { status: 'not-found' };
    }

    // Check persisted activeDevice
    const vid = persistent.video && persistent.video.activeDevice;
    if (vid && vid.sessionId) {
        const found = listRes.items.find(it => it.Id === vid.sessionId);
        if (found) return { status: 'ok', session: found };
        // persisted session no longer present; fallthrough to auto-select
    }

    // Auto select if exactly one eligible session
    if (listRes.items.length === 1) return { status: 'ok', session: listRes.items[0], persist: true };

    // Multiple sessions: require user to pick one
    if (listRes.items.length > 1) return { status: 'multiple', matches: listRes.items.map(it => it.DeviceName || it.Name) };

    return { status: 'not-found' };
};

// Persist active device
const persistActiveDevice = async function(handlerInput, session) {
    const m = getAttrManager(handlerInput);
    const { persistent } = await m.load();
    persistent.video = persistent.video || {};
    persistent.video.activeDevice = { sessionId: session.Id, deviceName: session.DeviceName || session.Name };
    await m.savePersistent(persistent);
};

// Persist last series context
const persistLastSeries = async function(handlerInput, data) {
    const m = getAttrManager(handlerInput);
    const { persistent } = await m.load();
    persistent.video = persistent.video || {};
    persistent.video.lastSeries = Object.assign({}, persistent.video.lastSeries || {}, data);
    await m.savePersistent(persistent);
};

// PlayMovieIntent (updated to use active device resolution rules)
const PlayMovieIntent = CreateIntent('PlayMovieIntent', async function(handlerInput) {
    const { requestEnvelope, responseBuilder } = handlerInput;
    const slots = requestEnvelope.request.intent.slots || {};

    try { Log.info('[Intent] PlayMovieIntent', Log.summarizeSlots(slots)); } catch (e) {}

    if (!slots.moviename || !slots.moviename.value) {
        const speach = tFor(handlerInput, 'MISSING_MOVIE_NAME');
        return endNow(responseBuilder, speach);
    }

    const movieName = slots.moviename.value;

    Log.info(`Requesting Movie: ${movieName}`);

    // Optional device override (compatibility) — don't require it
    const deviceOverride = slots.devicename && slots.devicename.value ? slots.devicename.value : null;

    const dev = await resolveActiveDevice(handlerInput, deviceOverride);

    if (dev.status === 'not-found') {
        const speach = tFor(handlerInput, 'NO_JELLYFIN_DEVICES');
        return endNow(responseBuilder, speach);
    }

    if (dev.status === 'multiple') {
        const speach = tFor(handlerInput, 'ASK_TO_SELECT_DEVICE');
        return endNow(responseBuilder, speach);
    }

    if (dev.status === 'ambiguous') {
        const speach = tFor(handlerInput, 'DEVICE_NAME_AMBIGUOUS', { devices: dev.matches.join(', ') });
        return endNow(responseBuilder, speach);
    }

    const session = dev.session;

    // Resolve movie (after we know the session user id so searches can be user-scoped)
    const selected = await JellyFin.ResolveMovieByName(movieName, { userId: session.UserId });

    try { Log.info('[Search] Movie result:', selected && selected.Name); } catch (e) {}


    if (!session.IsActive) {
        const speach = tFor(handlerInput, 'SESSION_INACTIVE', { device: session.DeviceName || session.Name });
        return endNow(responseBuilder, speach);
    }

    // Persist chosen device if asked to
    if (dev.persist) await persistActiveDevice(handlerInput, session);

    // Resolve playable source for the target session user (same pattern as for series)
    let movieMediaSource = null;
    try {
        const pb = await JellyFin.PlaybackInfo(selected.Id, { UserId: session.UserId });
        if (!pb || !pb.status) {
            Log.warn('[Intent] PlaybackInfo failed for movie:', pb && (pb.error || pb));
            const speach = tFor(handlerInput, 'PLAYBACK_FAILED');
            return endNow(responseBuilder, speach);
        }

        movieMediaSource = (pb.mediaSources || [])[0];
        if (!movieMediaSource || !movieMediaSource.Id) {
            Log.warn('[Intent] No valid media source for movie:', selected.Id, pb.playbackInfo);
            const speach = tFor(handlerInput, 'PLAYBACK_FAILED');
            return endNow(responseBuilder, speach);
        }
    } catch (err) {
        Log.warn('[Intent] PlaybackInfo threw for movie:', String(err));
        const speach = tFor(handlerInput, 'PLAYBACK_FAILED');
        return endNow(responseBuilder, speach);
    }

    // Start playback, providing MediaSourceId
    const res = await JellyFin.Sessions.playNow(session.Id, selected.Id, { MediaSourceId: movieMediaSource.Id, StartPositionTicks: 0 });

    if (!res.status) {
        Log.warn('[Intent] playOnSession failed:', res.error || res);
        const speach = tFor(handlerInput, 'PLAYBACK_FAILED');
        return endNow(responseBuilder, speach);
    }
    Log.info(`[Play] Requested remote play of movie ${selected.Name} on ${session.Id}`);

    return endNow(responseBuilder, 'Reproduciendo.');
});

// PlaySeriesIntent (video-only, plays next up or first episode)
const PlaySeriesIntent = CreateIntent('PlaySeriesIntent', async function(handlerInput) {
    const { requestEnvelope, responseBuilder } = handlerInput;
    const slots = requestEnvelope.request.intent.slots || {};

    try { Log.info('[Intent] PlaySeriesIntent', Log.summarizeSlots(slots)); } catch (e) {}

    if (!slots.seriesname || !slots.seriesname.value) {
        const speach = tFor(handlerInput, 'MISSING_SERIES_NAME');
        return endNow(responseBuilder, speach);
    }

    const seriesName = slots.seriesname.value;

    Log.info(`Requesting Series: ${seriesName}`);

    const series = await JellyFin.ResolveSeriesByName(seriesName);
    if (!series) {
        const speach = tFor(handlerInput, 'SERIES_NOT_FOUND', { series: seriesName });
        return endNow(responseBuilder, speach);
    }

    // Fetch episodes and try to pick next up
    const eps = await JellyFin.Episodes({ seriesId: series.Id, Recursive: true, Limit: 500 });

    try { Log.info('[Search] Episodes:', Log.summarizeItems(eps.items, 6)); } catch (e) {}

    if (!eps.status || !eps.items || !eps.items.length) {
        const speach = tFor(handlerInput, 'NO_EPISODES_FOUND', { series: seriesName });
        return endNow(responseBuilder, speach);
    }

    // Ensure episodes belong to the requested series (some servers may not honor seriesId filter reliably)
    let episodes = (eps.items || []).slice();
    const belongsToSeries = it => (it && (it.SeriesId === series.Id || it.ParentId === series.Id || (it.Series && it.Series.Id === series.Id)));
    const filtered = episodes.filter(belongsToSeries);
    if (filtered.length) {
        episodes = filtered;
        try { Log.info(`[Search] Filtered episodes: ${eps.items.length} -> ${episodes.length}`); } catch (e) {}
    }

    // Sort by season (ParentIndexNumber) then episode (IndexNumber)
    episodes.sort((a, b) => {
        const sa = Number(a.ParentIndexNumber) || 0;
        const sb = Number(b.ParentIndexNumber) || 0;
        if (sa !== sb) return sa - sb;
        const ea = Number(a.IndexNumber) || 0;
        const eb = Number(b.IndexNumber) || 0;
        return ea - eb;
    });

    // Prefer NextUp flag if present
    let selectedEpisode = episodes.find(it => it.UserData && it.UserData.NextUp);

    // Otherwise first unplayed
    if (!selectedEpisode) selectedEpisode = episodes.find(it => !(it.UserData && it.UserData.Played));

    // Fallback to first
    if (!selectedEpisode) selectedEpisode = episodes[0];

    if (!selectedEpisode) {
        const speach = tFor(handlerInput, 'NO_EPISODES_FOUND', { series: seriesName });
        return endNow(responseBuilder, speach);
    }

    // Resolve active device
    const dev = await resolveActiveDevice(handlerInput, null);

    if (dev.status === 'not-found') {
        const speach = tFor(handlerInput, 'NO_JELLYFIN_DEVICES');
        return endNow(responseBuilder, speach);
    }

    if (dev.status === 'multiple') {
        const speach = tFor(handlerInput, 'ASK_TO_SELECT_DEVICE');
        return endNow(responseBuilder, speach);
    }

    if (dev.status === 'ambiguous') {
        const speach = tFor(handlerInput, 'DEVICE_NAME_AMBIGUOUS', { devices: dev.matches.join(', ') });
        return endNow(responseBuilder, speach);
    }

    const session = dev.session;

    if (!session.IsActive) {
        const speach = tFor(handlerInput, 'SESSION_INACTIVE', { device: session.DeviceName || session.Name });
        return endNow(responseBuilder, speach);
    }

    if (dev.persist) await persistActiveDevice(handlerInput, session);

    // Resolve playable source for the target session user
    let mediaSource = null;
    let pb = null;
    try {
        pb = await JellyFin.PlaybackInfo(selectedEpisode.Id, { UserId: session.UserId });
        if (!pb || !pb.status) {
            Log.warn('[Intent] PlaybackInfo failed:', pb && (pb.error || pb));
            const speach = tFor(handlerInput, 'PLAYBACK_FAILED');
            return endNow(responseBuilder, speach);
        }

        mediaSource = (pb.mediaSources || [])[0];
        if (!mediaSource || !mediaSource.Id) {
            Log.warn('[Intent] No valid media source for item:', selectedEpisode.Id, pb.playbackInfo);
            const speach = tFor(handlerInput, 'PLAYBACK_FAILED');
            return endNow(responseBuilder, speach);
        }
    } catch (err) {
        Log.warn('[Intent] PlaybackInfo threw:', String(err));
        const speach = tFor(handlerInput, 'PLAYBACK_FAILED');
        return endNow(responseBuilder, speach);
    }

    // Provide MediaSourceId to play command so Jellyfin can start the correct stream
    const res = await JellyFin.Sessions.playNow(session.Id, selectedEpisode.Id, { MediaSourceId: mediaSource.Id, StartPositionTicks: 0, debug: (CONFIG && CONFIG.jellyfin && CONFIG.jellyfin.debugPlayRequests) });
    if (!res.status) {
        Log.warn('[Intent] playOnSession failed:', res.error || res);
        const speach = tFor(handlerInput, 'PLAYBACK_FAILED');
        return endNow(responseBuilder, speach);
    }

    // If debug info is available, log it for production comparison
    if (res.debug) {
        try { Log.info('[Intent] playOnSession debug:', res.debug); } catch (e) {}
    }

    // Verify that the session actually started playing the expected item
    const verify = await JellyFin.Sessions.waitForNowPlaying(session.Id, selectedEpisode.Id, { attempts: 3, delay: 1000 });
    if (!verify.status) {
        Log.warn('[Intent] playback verification failed for session', session.Id, 'expected', selectedEpisode.Id, 'actual', verify.lastSession && verify.lastSession.NowPlayingItem ? (verify.lastSession.NowPlayingItem.Name || verify.lastSession.NowPlayingItem.Id) : '<none>');

        // If PlaybackInfo provided a PlaySessionId, retry the play with it
        if (pb && pb.playbackInfo && pb.playbackInfo.PlaySessionId) {
            Log.info('[Intent] Retrying play with PlaySessionId', pb.playbackInfo.PlaySessionId);
            const retry = await JellyFin.Sessions.playNow(session.Id, selectedEpisode.Id, { MediaSourceId: mediaSource.Id, PlaySessionId: pb.playbackInfo.PlaySessionId, StartPositionTicks: 0, debug: (CONFIG && CONFIG.jellyfin && CONFIG.jellyfin.debugPlayRequests) });
            if (retry && retry.debug) try { Log.info('[Intent] playOnSession retry debug:', retry.debug); } catch (e) {}

            if (!retry || !retry.status) {
                Log.warn('[Intent] playOnSession retry failed:', retry && (retry.error || retry));
                const speach = tFor(handlerInput, 'PLAYBACK_FAILED');
                return endNow(responseBuilder, speach);
            }

            // Re-verify
            const verify2 = await JellyFin.Sessions.waitForNowPlaying(session.Id, selectedEpisode.Id, { attempts: 3, delay: 1000 });
            if (!verify2.status) {
                const actual = verify2.lastSession && verify2.lastSession.NowPlayingItem && (verify2.lastSession.NowPlayingItem.Name || verify2.lastSession.NowPlayingItem.Id);
                const speach = tFor(handlerInput, 'PLAYBACK_MISMATCH', { actual: actual || 'otro contenido' });
                return endNow(responseBuilder, speach);
            }
        } else {
            const actual = verify.lastSession && verify.lastSession.NowPlayingItem && (verify.lastSession.NowPlayingItem.Name || verify.lastSession.NowPlayingItem.Id);
            const speach = tFor(handlerInput, 'PLAYBACK_MISMATCH', { actual: actual || 'otro contenido' });
            return endNow(responseBuilder, speach);
        }
    }

    // Persist lastSeries context
    await persistLastSeries(handlerInput, { seriesId: series.Id, seriesName: series.Name, lastEpisodeId: selectedEpisode.Id, seasonNumber: Number(selectedEpisode.ParentIndexNumber), episodeNumber: Number(selectedEpisode.IndexNumber) });
    Log.info(`[Play] Requested remote play of episode ${selectedEpisode.Name} on ${session.Id}`);

    return endNow(responseBuilder, 'Reproduciendo.');
});

// ChangePlaybackDeviceIntent (free text device name)
const ChangePlaybackDeviceIntent = CreateIntent('ChangePlaybackDeviceIntent', async function(handlerInput) {
    const { requestEnvelope, responseBuilder } = handlerInput;
    const slots = requestEnvelope.request.intent.slots || {};

    try { Log.info('[Intent] ChangePlaybackDeviceIntent', Log.summarizeSlots(slots)); } catch (e) {}

    if (!slots.devicename || !slots.devicename.value) {
        const speach = tFor(handlerInput, 'MISSING_DEVICE_NAME');
        return responseBuilder.speak(speach).getResponse();
    }

    const deviceName = slots.devicename.value;
    const listRes = await JellyFin.Sessions.list();
    if (!listRes.status || !listRes.items || !listRes.items.length) {
        const speach = tFor(handlerInput, 'NO_JELLYFIN_DEVICES');
        return responseBuilder.speak(speach).getResponse();
    }

    const key = String(deviceName).trim().toLowerCase();
    const names = listRes.items.map(it => ({ session: it, display: it.DeviceName || it.Name }));

    const exact = names.filter(n => (n.display || '').toLowerCase() === key);
    if (exact.length === 1) { await persistActiveDevice(handlerInput, exact[0].session); return responseBuilder.speak(tFor(handlerInput, 'CHANGE_DEVICE_SUCCESS', { device: exact[0].display })).getResponse(); }

    const includes = names.filter(n => (n.display || '').toLowerCase().includes(key));
    if (includes.length === 1) { await persistActiveDevice(handlerInput, includes[0].session); return responseBuilder.speak(tFor(handlerInput, 'CHANGE_DEVICE_SUCCESS', { device: includes[0].display })).getResponse(); }

    if (includes.length > 1) {
        const speach = tFor(handlerInput, 'DEVICE_NAME_AMBIGUOUS', { devices: includes.map(i => i.display).join(', ') });
        return responseBuilder.speak(speach).getResponse();
    }

    const speach = tFor(handlerInput, 'DEVICE_NOT_FOUND');
    return responseBuilder.speak(speach).getResponse();
});

// NextEpisodeIntent
const NextEpisodeIntent = CreateIntent('NextEpisodeIntent', async function(handlerInput) {
    const { responseBuilder } = handlerInput;
    const m = getAttrManager(handlerInput);
    const { persistent } = await m.load();

    const last = persistent.video && persistent.video.lastSeries;
    if (!last || !last.seriesId) {
        const speach = tFor(handlerInput, 'NO_VIDEO_CONTEXT');
        return endNow(responseBuilder, speach);
    }

    // Find episodes and current index
    const eps = await JellyFin.Episodes({ seriesId: last.seriesId, Recursive: true, Limit: 500 });
    if (!eps.status || !eps.items || !eps.items.length) return endNow(responseBuilder, tFor(handlerInput, 'NO_EPISODES_FOUND', { series: last.seriesName }));

    // Filter to the requested series (server-side filter may be unreliable)
    let episodes = (eps.items || []).slice();
    const belongsToSeries = it => (it && (it.SeriesId === last.seriesId || it.ParentId === last.seriesId || (it.Series && it.Series.Id === last.seriesId)));
    const filtered = episodes.filter(belongsToSeries);
    if (filtered.length) {
        episodes = filtered;
        try { Log.info(`[Search] Filtered episodes: ${eps.items.length} -> ${episodes.length} for ${last.seriesName}`); } catch (e) {}
    }

    // Normalize and sort
    const sorted = episodes.slice().sort((a,b) => (Number(a.ParentIndexNumber) - Number(b.ParentIndexNumber)) || (Number(a.IndexNumber) - Number(b.IndexNumber)));

    const currentIndex = sorted.findIndex(it => it.Id === last.lastEpisodeId);
    let nextEpisode = null;

    // Prefer NextUp
    nextEpisode = sorted.find(it => it.UserData && it.UserData.NextUp);
    if (!nextEpisode && currentIndex >= 0 && currentIndex < (sorted.length -1)) nextEpisode = sorted[currentIndex+1];

    if (!nextEpisode) return endNow(responseBuilder, tFor(handlerInput, 'NEXT_EPISODE_NOT_AVAILABLE', { series: last.seriesName }));

    // Resolve device
    const dev = await resolveActiveDevice(handlerInput, null);
    if (dev.status !== 'ok') {
        if (dev.status === 'multiple') return endNow(responseBuilder, tFor(handlerInput, 'ASK_TO_SELECT_DEVICE'));
        return endNow(responseBuilder, tFor(handlerInput, 'NO_JELLYFIN_DEVICES'));
    }

    const session = dev.session;
    if (!session.IsActive) return endNow(responseBuilder, tFor(handlerInput, 'SESSION_INACTIVE', { device: session.DeviceName || session.Name }));

    const res = await JellyFin.Sessions.playNow(session.Id, nextEpisode.Id);
    if (!res.status) return endNow(responseBuilder, tFor(handlerInput, 'PLAYBACK_FAILED'));

    // Update lastSeries
    await persistLastSeries(handlerInput, { lastEpisodeId: nextEpisode.Id, seasonNumber: Number(nextEpisode.ParentIndexNumber), episodeNumber: Number(nextEpisode.IndexNumber) });

    return endNow(responseBuilder, 'Reproduciendo.');
});

// PreviousEpisodeIntent
const PreviousEpisodeIntent = CreateIntent('PreviousEpisodeIntent', async function(handlerInput) {
    const { responseBuilder } = handlerInput;
    const m = getAttrManager(handlerInput);
    const { persistent } = await m.load();

    const last = persistent.video && persistent.video.lastSeries;
    if (!last || !last.seriesId) {
        const speach = tFor(handlerInput, 'NO_VIDEO_CONTEXT');
        return endNow(responseBuilder, speach);
    }

    const eps = await JellyFin.Episodes({ seriesId: last.seriesId, Recursive: true, Limit: 500 });
    if (!eps.status || !eps.items || !eps.items.length) return endNow(responseBuilder, tFor(handlerInput, 'NO_EPISODES_FOUND', { series: last.seriesName }));

    // Filter to the requested series in case server-side filtering didn't work
    let episodes = (eps.items || []).slice();
    const belongsToSeries = it => (it && (it.SeriesId === last.seriesId || it.ParentId === last.seriesId || (it.Series && it.Series.Id === last.seriesId)));
    const filtered = episodes.filter(belongsToSeries);
    if (filtered.length) {
        episodes = filtered;
        try { Log.info(`[Search] Filtered episodes: ${eps.items.length} -> ${episodes.length} for ${last.seriesName}`); } catch (e) {}
    }

    const sorted = episodes.slice().sort((a,b) => (Number(a.ParentIndexNumber) - Number(b.ParentIndexNumber)) || (Number(a.IndexNumber) - Number(b.IndexNumber)));

    const currentIndex = sorted.findIndex(it => it.Id === last.lastEpisodeId);

    let prevEpisode = null;
    if (currentIndex > 0) prevEpisode = sorted[currentIndex-1];

    if (!prevEpisode) return endNow(responseBuilder, tFor(handlerInput, 'PREVIOUS_EPISODE_NOT_AVAILABLE', { series: last.seriesName }));

    const dev = await resolveActiveDevice(handlerInput, null);
    if (dev.status !== 'ok') {
        if (dev.status === 'multiple') return endNow(responseBuilder, tFor(handlerInput, 'ASK_TO_SELECT_DEVICE'));
        return endNow(responseBuilder, tFor(handlerInput, 'NO_JELLYFIN_DEVICES'));
    }

    const session = dev.session;
    if (!session.IsActive) return endNow(responseBuilder, tFor(handlerInput, 'SESSION_INACTIVE', { device: session.DeviceName || session.Name }));

    const res = await JellyFin.Sessions.playNow(session.Id, prevEpisode.Id);
    if (!res.status) return endNow(responseBuilder, tFor(handlerInput, 'PLAYBACK_FAILED'));

    // Update lastSeries
    await persistLastSeries(handlerInput, { lastEpisodeId: prevEpisode.Id, seasonNumber: Number(prevEpisode.ParentIndexNumber), episodeNumber: Number(prevEpisode.IndexNumber) });

    return endNow(responseBuilder, 'Reproduciendo.');
});

// ListPlaybackDevicesIntent (unchanged exporting below)
const ListPlaybackDevicesIntent = CreateIntent('ListPlaybackDevicesIntent', async function(handlerInput) {
    const { requestEnvelope, responseBuilder } = handlerInput;

    try { Log.info('[Intent] ListPlaybackDevicesIntent'); } catch(e) {}

    // Fetch sessions directly from Jellyfin; Sessions.listSessions() already filters by SupportsRemoteControl and Video
    const res = await JellyFin.Sessions.listSessions();

    if (!res.status || !res.items || !res.items.length) {
        const speach = tFor(handlerInput, 'NO_JELLYFIN_DEVICES');
        Log.info('[Intent] No Jellyfin devices found');
        return responseBuilder.speak(speach).getResponse();
    }

    const sessionNames = res.items
        .map(it => it.DeviceName || (it.Device && it.Device.Name) || it.Name)
        .filter(Boolean);

    try { Log.info('[Intent] Found playback devices:', sessionNames.join(', ')); } catch (e) {}
    try { Log.debug('[Intent] Full sessions result:', res); } catch (e) {}

    // Try to match configured PLAYBACK_DEVICE values (from skill JSON) against available sessions
    const locale = (requestEnvelope && requestEnvelope.request && requestEnvelope.request.locale) || 'en-US';
    const configured = getPlaybackDeviceValuesForLocale(locale);

    const norm = s => String(s || '').trim().toLowerCase();

    const configuredAvailable = configured.filter(cfg => sessionNames.find(sn => norm(sn).includes(norm(cfg)) || norm(cfg).includes(norm(sn))));

    let speach;
    if (configuredAvailable && configuredAvailable.length) {
        speach = tFor(handlerInput, 'LIST_DEVICES', { devices: configuredAvailable.join(', ') });
    } else {
        speach = tFor(handlerInput, 'LIST_DEVICES', { devices: sessionNames.join(', ') });
    }

    return responseBuilder.speak(speach).getResponse();
});

module.exports = {
    PlayMovieIntent,
    PlaySeriesIntent,
    ListPlaybackDevicesIntent,
    ChangePlaybackDeviceIntent,
    NextEpisodeIntent,
    PreviousEpisodeIntent
};
