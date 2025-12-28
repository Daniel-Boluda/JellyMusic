const Log = require('./logger.js');
/*********************************************************************************
 * Request Items from API
 *      https://api.jellyfin.org/
 */

const Request = async function(endpoint, params, ...args)
{
    const url = new URL(endpoint, CONFIG.jellyfin.host);
    
    if (params)
    {
        params = Object.assign({}, params, ...args);

        for (const key in params)
        {
            const value = params[key];

            if (value instanceof Array)
                value.forEach(item => url.searchParams.append(key, String(item)));
            else
                url.searchParams.append(key, String(value));
        }
    }

    // DEBUG: Log outgoing Jellyfin request (endpoint and query only; never log tokens).
    Log.debug('[Jellyfin] GET', Log.redactUrl(url.toString()));

    const started = Date.now();

    let response;
    try {
        response = await fetch(
        url,
        {
            method: 'GET',
            headers:
            {
                Authorization: `MediaBrowser Token="${CONFIG.jellyfin.key}"`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        }
    );
    } catch (err) {
        Log.error('[Jellyfin] Network error:', err);
        return {status: false, error: String(err)};
    }

    Log.debug(`[Jellyfin] Response ${response.status} (${Date.now() - started}ms) for`, url.pathname);

    if (!response.ok) {
        // capture body safely for diagnostics, but avoid throwing
        let body;
        try { body = await response.text(); } catch (e) { body = '<failed-to-read-body>'; }
        Log.warn(`[Jellyfin] Non-OK response ${response.status} for ${url.pathname}:`, body);
        return {status: false, statusCode: response.status, error: body};
    }

    var result = await response.json();

    // TRACE: show result summary
    Log.trace('[Jellyfin] Result summary:', {
        startIndex: result.StartIndex,
        total: result.TotalRecordCount,
        returned: Array.isArray(result.Items) ? result.Items.length : undefined
    });
    Log.debug('[Jellyfin] ' + Log.summarizeItems(result.Items, 8));
    
    return {status: true, items: result.Items, index: result.StartIndex, count: result.TotalRecordCount };
};

/*********************************************************************************
 * Paged Items.
 * Returns the first page and process a function for all pages.
 */

/*const PagedItems = async function(callback, api, limit, ...args)
{
    const result = await api(...args, {limit})

    if (!result.status) return result;

    if (callback)
    {
        callback(res);

        for (let i = result.index; i < result.count; i += limit)
            api(...args, {limit, startIndex: i}).then(callback);
    };

    return result;
};*/

/*********************************************************************************
 * Request Artists
 */

const Artists = async (...params) => await Request("/Artists", ...params);

Artists.ByName = async (artist, ...params) => await Request(`/Artists/${artist}`, ...params);

Artists.AlbumArtists = async (...params) => await Request("/Artists/AlbumArtists", ...params);

/*********************************************************************************
 * Music Genres (new helper)
 * Supports the dedicated /MusicGenres endpoint which returns an array.
 * Implements server-side SearchTerm/Limit and a ResolveIdByName helper with caching.
 */

const MusicGenres = async function(params) {
    const url = new URL("/MusicGenres", CONFIG.jellyfin.host);

    if (params && typeof params === 'object') {
        for (const k in params) url.searchParams.append(k, String(params[k]));
    }

    // Debug: log request
    Log.debug('[Jellyfin] GET', Log.redactUrl(url.toString()));

    const started = Date.now();

    let response;
    try {
        response = await fetch(
            url,
            {
                method: 'GET',
                headers:
                {
                    Authorization: `MediaBrowser Token="${CONFIG.jellyfin.key}"`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );
    } catch (err) {
        Log.error('[Jellyfin] Network error:', err);
        return {status: false, error: String(err)};
    }

    Log.debug(`[Jellyfin] Response ${response.status} (${Date.now() - started}ms) for`, url.pathname);

    if (!response.ok) {
        let body;
        try { body = await response.text(); } catch (e) { body = '<failed-to-read-body>'; }
        Log.warn(`[Jellyfin] Non-OK response ${response.status} for ${url.pathname}:`, body);
        return {status: false, statusCode: response.status, error: body};
    }

    const result = await response.json();

    // Normalize result: /MusicGenres may return an array directly
    let items = [];
    if (Array.isArray(result)) items = result;
    else if (Array.isArray(result.Items)) items = result.Items;

    Log.trace('[Jellyfin] MusicGenres result count:', items.length);
    Log.debug('[Jellyfin] ' + Log.summarizeItems(items, 8));

    return { status: true, items, index: 0, count: items.length };
};

// Search helper using server-side SearchTerm & Limit
MusicGenres.Search = async function(query, opts = {}) {
    const params = Object.assign({}, opts, { SearchTerm: query });
    if (!params.Limit) params.Limit = CONFIG.jellyfin.limit || 25;
    return await MusicGenres(params);
};

// Simple in-memory cache for genre name -> id
const _genreCache = { };
const _genreCacheTtl = Number(process.env.GENRE_CACHE_TTL) || (CONFIG.jellyfin.genreCacheTtl || 30 * 60 * 1000);

// Resolve best matching genre Id by name with ranking
// Prioridad: exacto (case-insensitive) > startsWith > includes > first
MusicGenres.ResolveIdByName = async function(name) {
    if (!name) return null;

    const key = String(name).trim().toLowerCase();

    // Cache hit
    const cached = _genreCache[key];
    if (cached && cached.expires > Date.now()) {
        Log.debug(`[Genres] Cache hit for '${key}' -> ${cached.id}`);
        return cached.id;
    }

    Log.info(`[Genres] Resolving genre name: '${name}'`);

    const res = await MusicGenres.Search(name);

    if (!res.status) {
        Log.warn(`[Genres] Search failed for '${name}':`, res.error || res);
        return null;
    }

    const items = res.items || [];

    Log.debug('[Genres] Search returned:', Log.summarizeItems(items, 12));

    if (!items.length) {
        Log.info(`[Genres] No genres found for '${name}'`);
        return null;
    }

    const norm = s => String(s || '').trim().toLowerCase();

    // Ranking phases
    let selected = null;

    // exact
    for (const it of items) if (norm(it.Name) === key) { selected = it; Log.info(`[Genres] Exact match -> ${it.Name} (${it.Id})`); break; }

    // startsWith
    if (!selected) for (const it of items) if (norm(it.Name).startsWith(key)) { selected = it; Log.info(`[Genres] StartsWith match -> ${it.Name} (${it.Id})`); break; }

    // includes
    if (!selected) for (const it of items) if (norm(it.Name).includes(key)) { selected = it; Log.info(`[Genres] Includes match -> ${it.Name} (${it.Id})`); break; }

    // fallback first
    if (!selected) { selected = items[0]; Log.info(`[Genres] Fallback to first -> ${selected.Name} (${selected.Id})`); }

    // Cache the selection
    if (selected) {
        _genreCache[key] = { id: selected.Id, expires: Date.now() + _genreCacheTtl };
        Log.debug(`[Genres] Cached '${key}' -> ${selected.Id} (ttl=${_genreCacheTtl}ms)`);
        return selected.Id;
    }

    return null;
};

/*********************************************************************************
 * Request Items
 */

const Items = async (...params) => await Request("/Items", { Recursive:true }, ...params);

Items.Artists = Artists;
Items.Music = async (...params) => await Items({includeItemTypes: "Audio"}, ...params);
Items.Albums = async (...params) => await Items({includeItemTypes: "MusicAlbum"}, ...params);
Items.MusicGenres = async (...params) => await Items({includeItemTypes: "MusicGenre"}, ...params);

// Ensure the high-level MusicGenres helpers are available on the exported Items namespace
// (ResolveIdByName & Search are implemented above on the internal MusicGenres helper)
if (typeof MusicGenres !== 'undefined') {
    Items.MusicGenres.ResolveIdByName = MusicGenres.ResolveIdByName;
    Items.MusicGenres.Search = MusicGenres.Search;
}

// --- Video helpers: Movies, Series, Episodes
Items.Movies = async (...params) => await Items({includeItemTypes: "Movie"}, ...params);
Items.Series = async (...params) => await Items({includeItemTypes: "Series"}, ...params);

// Episodes: when a seriesId is provided, prefer the dedicated Shows/{seriesId}/Episodes endpoint
// This is more reliable than querying /Items with includeItemTypes=Episode and avoids cross-series results
Items.Episodes = async function(...params) {
    const opts = Object.assign({}, ...params);

    // If caller provided seriesId, use the Shows endpoint for precise results
    if (opts && opts.seriesId) {
        const seriesId = opts.seriesId;
        // Remove seriesId from the query params to avoid duplicating it in the query string
        // (we already include the id in the path: /Shows/{id}/Episodes)
        delete opts.seriesId;
        try {
            // Log the path + key params for diagnostics (do not log secrets)
            Log.debug('[Jellyfin] GET', `/Shows/${seriesId}/Episodes`, { Recursive: opts.Recursive, Limit: opts.Limit });

            const res = await Request(`/Shows/${seriesId}/Episodes`, opts);
            if (!res.status) return res;

            // Normalize shape consistent with Items.Request wrapper
            return { status: true, items: res.items || [], index: res.index, count: res.count };
        } catch (err) {
            // If anything goes wrong, fall back to the generic Items endpoint
            Log.warn(`[Jellyfin] /Shows/${seriesId}/Episodes failed, falling back to /Items:`, err && err.message ? err.message : err);
        }
    }

    // Fallback: use /Items with includeItemTypes=Episode
    return await Items(Object.assign({ includeItemTypes: "Episode" }, opts));
};

// Search wrappers for video types
Items.Movies.Search = async (query, opts = {}, ...params) => {
    // If a userId is provided, prefer a broader user-scoped query that mirrors the working curl variant
    const uid = opts && (opts.userId || opts.UserId);
    if (uid) {
        const includes = ["Movie","Series","Episode","Playlist","MusicAlbum","Audio","TvChannel","PhotoAlbum","Photo","AudioBook","Book","BoxSet"];
        const fields = ["PrimaryImageAspectRatio","CanDelete","MediaSourceCount"];
        const paramsObj = {
            userId: uid,
            limit: opts.limit || 800,
            recursive: true,
            searchTerm: String(query).trim(),
            fields: fields,
            includeItemTypes: includes,
            imageTypeLimit: 1,
            enableTotalRecordCount: false
        };
        return await Items(paramsObj, ...params);
    }

    return await Search(Items.Movies, "Name", query, opts, ...params);
};
Items.Series.Search = async (query, ...params) => await Search(Items.Series, "Name", query, ...params);
Items.Episodes.Search = async (query, ...params) => await Search(Items.Episodes, "Name", query, ...params);

// Resolve helpers for movies/series (same ranking: exact > startsWith > includes > first)
const _resolveItemsByName = function(items, key) {
    const norm = s => String(s || '').trim().toLowerCase();
    let selected = null;

    if (!items || !items.length) return null;

    // exact
    for (const it of items) if (norm(it.Name) === key) { selected = it; break; }
    // startsWith
    if (!selected) for (const it of items) if (norm(it.Name).startsWith(key)) { selected = it; break; }
    // includes
    if (!selected) for (const it of items) if (norm(it.Name).includes(key)) { selected = it; break; }
    // fallback
    if (!selected) selected = items[0];

    return selected;
};

Items.ResolveMovieByName = async function(name, opts = {}) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase();

    const res = await Items.Movies.Search(name, opts);
    if (!res.status) return null;

    const selected = _resolveItemsByName(res.items || [], key);
    return selected || null;
};

Items.ResolveSeriesByName = async function(name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase();

    const res = await Items.Series.Search(name);
    if (!res.status) return null;

    const selected = _resolveItemsByName(res.items || [], key);
    return selected || null;
};

// --- Sessions helper for remote play (list, select by deviceName, play/stop)
const Sessions = async function(params) {
    const url = new URL("/Sessions", CONFIG.jellyfin.host);

    if (params && typeof params === 'object') {
        for (const k in params) url.searchParams.append(k, String(params[k]));
    }

    Log.debug('[Jellyfin] GET', Log.redactUrl(url.toString()));

    const started = Date.now();

    let response;
    const timeout = (params && params.timeout) || 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        response = await fetch(
            url,
            {
                method: 'GET',
                headers:
                {
                    Authorization: `MediaBrowser Token="${CONFIG.jellyfin.key}"`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                signal: controller.signal
            }
        );
    } catch (err) {
        if (err.name === 'AbortError') Log.error('[Jellyfin] Request timed out (Sessions)');
        else Log.error('[Jellyfin] Network error:', err);
        clearTimeout(timer);
        return {status: false, error: String(err)};
    } finally { clearTimeout(timer); }

    Log.debug(`[Jellyfin] Response ${response.status} (${Date.now() - started}ms) for`, url.pathname);

    if (!response.ok) {
        let body;
        try { body = await response.text(); } catch (e) { body = '<failed-to-read-body>'; }
        Log.warn(`[Jellyfin] Non-OK response ${response.status} for ${url.pathname}:`, body);
        return {status: false, statusCode: response.status, error: body};
    }

    let result;
    try { result = await response.json(); } catch (e) { result = []; }

    let items = [];
    if (Array.isArray(result)) items = result;
    else if (Array.isArray(result.Items)) items = result.Items;

    Log.trace('[Jellyfin] Sessions result count:', items.length);
    Log.debug('[Jellyfin] ' + Log.summarizeItems(items, 8));

    return { status: true, items, index: 0, count: items.length };
};

// Filter sessions that support remote control and video playback
Sessions.listSessions = async function(opts = {}) {
    const res = await Sessions(opts);
    if (!res.status) return res;

    let items = res.items || [];

    // Filter: SupportsRemoteControl === true and PlayableMediaTypes includes 'Video'
    items = items.filter(it => it && it.SupportsRemoteControl && Array.isArray(it.PlayableMediaTypes) && it.PlayableMediaTypes.includes('Video'));

    // Optional: filter by UserId
    if (opts.userId) items = items.filter(it => it.UserId === opts.userId || (it.User && it.User.Id === opts.userId));

    // Prefer active sessions first
    items.sort((a,b) => (b.IsActive ? 1:0) - (a.IsActive ? 1:0));

    return { status: true, items, index:0, count: items.length };
};

// Tolerant device name match: exact > startsWith > includes. Return ambiguous when multiple matches at same rank
Sessions.findByDeviceName = async function(name) {
    if (!name) return { status: 'not-found' };
    const key = String(name).trim().toLowerCase();

    const res = await Sessions.listSessions();
    if (!res.status) return { status: 'error', error: res.error };

    const items = res.items || [];
    const norm = s => String(s || '').trim().toLowerCase();

    const names = items.map(it => ({
        session: it,
        display: it.DeviceName || (it.Device && it.Device.Name) || it.Name || it.Id
    }));

    const exact = names.filter(n => norm(n.display) === key);
    if (exact.length === 1) return { status: 'ok', session: exact[0].session };
    if (exact.length > 1) return { status: 'ambiguous', matches: exact.map(n => n.display) };

    const starts = names.filter(n => norm(n.display).startsWith(key));
    if (starts.length === 1) return { status: 'ok', session: starts[0].session };
    if (starts.length > 1) return { status: 'ambiguous', matches: starts.map(n => n.display) };

    const includes = names.filter(n => norm(n.display).includes(key));
    if (includes.length === 1) return { status: 'ok', session: includes[0].session };
    if (includes.length > 1) return { status: 'ambiguous', matches: includes.map(n => n.display) };

    return { status: 'not-found' };
};

// Fetch a single session by id (helper)
Sessions.get = async function(sessionId) {
    if (!sessionId) return { status: false, error: 'Missing sessionId' };
    const url = new URL(`/Sessions/${sessionId}`, CONFIG.jellyfin.host);
    Log.debug('[Jellyfin] GET', Log.redactUrl(url.toString()));

    let response;
    try {
        response = await fetch(url, { method: 'GET', headers: { Authorization: `MediaBrowser Token="${CONFIG.jellyfin.key}"` } });
    } catch (err) {
        Log.error('[Jellyfin] Network error (get session):', err);
        return { status: false, error: String(err) };
    }

    if (!response.ok) {
        let body;
        try { body = await response.text(); } catch (e) { body = '<failed-to-read-body>'; }
        return { status: false, statusCode: response.status, error: body };
    }

    let js;
    try { js = await response.json(); } catch (e) { js = null; }
    return { status: true, session: js };
};

// Wait for a session to show the expected NowPlayingItem id. Attempts polls and returns last session info on failure
Sessions.waitForNowPlaying = async function(sessionId, expectedItemId, opts = {}) {
    const attempts = (opts && opts.attempts) || 3;
    const delay = (opts && opts.delay) || 1000;

    for (let i = 0; i < attempts; i++) {
        const res = await Sessions.listSessions();
        if (!res.status) return { status: false, error: res.error };
        const s = (res.items || []).find(it => it && it.Id === sessionId);
        if (s && s.NowPlayingItem && s.NowPlayingItem.Id === expectedItemId) return { status: true, session: s, attempt: i+1 };
        // Wait and retry
        await new Promise(r => setTimeout(r, delay));
    }

    const lastRes = await Sessions.listSessions();
    const last = (lastRes && lastRes.items) ? lastRes.items.find(it => it && it.Id === sessionId) : null;

    return { status: false, error: 'Did not match NowPlayingItem', lastSession: last };
};

// Compatibility wrappers requested by the interaction model spec
Sessions.list = async function(opts = {}) {
    // alias to listSessions but keep name compact
    return await Sessions.listSessions(opts);
};

Sessions.playNow = async function(sessionId, itemId, opts = {}) {
    // wrapper for playOnSession
    return await Sessions.playOnSession(sessionId, itemId, opts);
};

// POST helpers for sessions control
Sessions.playOnSession = async function(sessionId, itemId, opts = {}) {
    if (!sessionId || !itemId) return { status: false, error: 'Missing parameters' };

    const url = new URL(`/Sessions/${sessionId}/Playing`, CONFIG.jellyfin.host);

    // Allow overriding playCommand (e.g. PlayNow, PlayMediaSource) while defaulting to PlayNow
    const playCommand = (opts && opts.playCommand) ? String(opts.playCommand) : 'PlayNow';
    url.searchParams.set('playCommand', playCommand);

    // Also append common playback options as query params for servers that expect them in the query string
    // This mirrors the behaviour of the working Python example which places playCommand & itemIds in the query.
    try {
        if (opts) {
            if (opts.MediaSourceId) url.searchParams.append('mediaSourceId', String(opts.MediaSourceId));
            if (opts.MediaSourceId) url.searchParams.append('MediaSourceId', String(opts.MediaSourceId));
            if (opts.StartPositionTicks !== undefined) url.searchParams.append('startPositionTicks', String(opts.StartPositionTicks));
            if (opts.StartPositionTicks !== undefined) url.searchParams.append('StartPositionTicks', String(opts.StartPositionTicks));
            if (opts.PlaySessionId) url.searchParams.append('PlaySessionId', String(opts.PlaySessionId));
            if (opts.audioStreamIndex !== undefined) url.searchParams.append('audioStreamIndex', String(opts.audioStreamIndex));
            if (opts.subtitleStreamIndex !== undefined) url.searchParams.append('subtitleStreamIndex', String(opts.subtitleStreamIndex));
            // itemIds: prefer single itemId passed, but allow opts.ItemIds too
            if (opts.ItemIds && Array.isArray(opts.ItemIds)) opts.ItemIds.forEach(id => url.searchParams.append('itemIds', String(id)));
            else if (itemId) url.searchParams.append('itemIds', String(itemId));
        }
    } catch (e) { /* best-effort - do not break playback */ }

    const body = Object.assign({}, opts, { ItemIds: [ itemId ], playCommand: playCommand });

    try { Log.debug('[Jellyfin] POST', Log.redactUrl(url.toString()), Object.keys(body)); } catch (e) {}
    let response;
    const timeout = (opts && opts.timeout) || 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        response = await fetch(url, { method: 'POST', headers: { Authorization: `MediaBrowser Token="${CONFIG.jellyfin.key}"`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    } catch (err) {
        if (err.name === 'AbortError') Log.error('[Jellyfin] Request timed out (playOnSession)');
        else Log.error('[Jellyfin] Network error (playOnSession):', err);
        clearTimeout(timer);
        return { status: false, error: err && err.message ? err.message : String(err) };
    } finally { clearTimeout(timer); }

    if (!response.ok) {
        let bodyText;
        try { bodyText = await response.text(); } catch (e) { bodyText = '<failed-to-read-body>'; }
        Log.warn(`[Jellyfin] playOnSession non-OK ${response.status}:`, bodyText);

        // Retry heuristic: some Jellyfin servers validate playCommand as a numeric enum - retry using numeric values if validation fails
        if (response.status === 400 && bodyText && bodyText.toLowerCase().includes('playcommand')) {
            try {
                Log.info('[Jellyfin] Retrying playOnSession with numeric playCommand');
                const retryBody = Object.assign({}, opts, { ItemIds: [ itemId ], playCommand: 1, PlayCommand: 1 });
                const retryController = new AbortController();
                const retryTimer = setTimeout(() => retryController.abort(), timeout);
                let retryResp;
                try {
                    retryResp = await fetch(url, { method: 'POST', headers: { Authorization: `MediaBrowser Token="${CONFIG.jellyfin.key}"`, 'Content-Type': 'application/json' }, body: JSON.stringify(retryBody), signal: retryController.signal });
                } catch (reterr) {
                    if (reterr.name === 'AbortError') Log.error('[Jellyfin] Retry timed out (playOnSession)');
                    else Log.error('[Jellyfin] Network error (playOnSession retry):', reterr);
                    clearTimeout(retryTimer);
                    return { status: false, error: reterr && reterr.message ? reterr.message : String(reterr) };
                } finally { clearTimeout(retryTimer); }

                if (!retryResp.ok) {
                    let rtext;
                    try { rtext = await retryResp.text(); } catch (e) { rtext = '<failed-to-read-body>'; }
                    Log.warn(`[Jellyfin] playOnSession retry non-OK ${retryResp.status}:`, rtext);
                    return { status:false, statusCode: retryResp.status, error: rtext };
                }

                let retryJson;
                try { retryJson = await retryResp.json(); } catch (e) { retryJson = null; }
                Log.info(`[Jellyfin] playOnSession retry succeeded for session ${sessionId} -> item ${itemId}`);
                return { status: true, response: retryJson };
            } catch (err) {
                Log.error('[Jellyfin] Retry failed:', err && err.message ? err.message : String(err));
                return {status:false, statusCode: response.status, error: bodyText };
            }
        }

        return {status:false, statusCode: response.status, error: bodyText };
    }

    let respBody;
    try { respBody = await response.json(); } catch (e) { respBody = null; }

    Log.info(`[Jellyfin] playOnSession succeeded for session ${sessionId} -> item ${itemId}`);

    // If debug requested, include the constructed URL and body so tests / production logs can be compared
    if ((opts && opts.debug) || (CONFIG && CONFIG.jellyfin && CONFIG.jellyfin.debugPlayRequests)) {
        return { status: true, response: respBody, debug: { url: url.toString(), body } };
    }

    return { status: true, response: respBody };
};

Sessions.stopSession = async function(sessionId) {
    if (!sessionId) return { status: false, error: 'Missing sessionId' };

    const url = new URL(`/Sessions/${sessionId}/Playing/Stop`, CONFIG.jellyfin.host);

    Log.debug('[Jellyfin] POST', Log.redactUrl(url.toString()));

    let response;
    try {
        response = await fetch(url, { method: 'POST', headers: { Authorization: `MediaBrowser Token="${CONFIG.jellyfin.key}"`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    } catch (err) {
        Log.error('[Jellyfin] Network error (stopSession):', err);
        return { status: false, error: String(err) };
    }

    if (!response.ok) {
        let bodyText;
        try { bodyText = await response.text(); } catch (e) { bodyText = '<failed-to-read-body>'; }
        Log.warn(`[Jellyfin] stopSession non-OK ${response.status}:`, bodyText);
        return {status:false, statusCode: response.status, error: bodyText };
    }

    Log.info(`[Jellyfin] stopSession succeeded for session ${sessionId}`);
    return { status: true };
};

// Expose Sessions on exported Items
Items.Sessions = Sessions;

Items.Playlists = async (...params) => await Items({includeItemTypes: "Playlist"}, ...params);

// Resolve playable sources for an item for a given user (important for remote play)
Items.PlaybackInfo = async function(itemId, opts = {}) {
    if (!itemId) return { status: false, error: 'Missing itemId' };

    const url = new URL(`/Items/${itemId}/PlaybackInfo`, CONFIG.jellyfin.host);

    // Optionally include UserId so Jellyfin can tailor playback info to the user
    if (opts.UserId) url.searchParams.append('UserId', String(opts.UserId));

    const body = {
        StartTimeTicks: opts.StartTimeTicks || 0,
        IsPlayback: true,
        AutoOpenLiveStream: true
    };

    try { Log.debug('[Jellyfin] POST', Log.redactUrl(url.toString()), Object.keys(body)); } catch (e) {}

    let response;
    const timeout = opts.timeout || 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `MediaBrowser Token="${CONFIG.jellyfin.key}"`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (err) {
        clearTimeout(timer);
        return { status: false, error: err && err.message ? err.message : String(err) };
    } finally { clearTimeout(timer); }

    if (!response.ok) {
        let bodyText = '';
        try { bodyText = await response.text(); } catch (e) {}
        Log.warn(`[Jellyfin] PlaybackInfo non-OK ${response.status}:`, bodyText);
        return { status: false, statusCode: response.status, error: bodyText || 'PlaybackInfo failed' };
    }

    let data = null;
    try { data = await response.json(); } catch (e) { data = null; }

    const sources = (data && data.MediaSources) ? data.MediaSources : [];
    return { status: true, playbackInfo: data, mediaSources: sources };
};


/*********************************************************************************
 * Search Function (server-side)
 */
const Search = async function (api, field, query, opts = {}, ...params) {
    if (!query || !String(query).trim()) {
        return { status: false, error: "Empty query" };
    }

    // Build default params
    const paramsObj = Object.assign({}, opts || {});
    if (!paramsObj.Limit) paramsObj.Limit = CONFIG.jellyfin.limit || 25;
    paramsObj.SearchTerm = String(query).trim();
    paramsObj.searchTerm = String(query).trim();
    paramsObj.Recursive = true;

    // Ask Jellyfin to do the search; do NOT fetch the entire library.
    const result = await api(paramsObj, ...params);

    if (!result.status) return result;

    // Optional: tighten results client-side if you want (case-insensitive contains on 'field')
    const q = String(query).toLowerCase();
    result.items = (result.items || []).filter(it => {
        const v = (it && it[field]) ? String(it[field]).toLowerCase() : "";
        return v.includes(q);
    });

    return result;
};

Items.Music.Search = async (query, ...params) => await Search(Items.Music, "Name", query, ...params);
Items.Albums.Search = async (query, ...params) => await Search(Items.Albums, "Name", query, ...params);
Items.Artists.Search = async (query, ...params) => await Search(Items.Artists, "Name", query, ...params);
Items.MusicGenres.Search = async (query, ...params) => await Search(Items.MusicGenres, "Name", query, ...params);
Items.Playlists.Search = async (query, ...params) => await Search(Items.Playlists, "Name", query, ...params);

/*********************************************************************************
 * Find Albums
 */

Items.Albums.ByGenre = async function(query, ...params)
{
    const result = await Items.MusicGenres.Search(query);

    if (!result.status) return result;

    const result2 = await Items.Albums({genres: result.items.map(item => item.Name).join("|")}, ...params);

    if (!result2.status) return result2;

    result2.genres = result.items;

    return result2;
};

Items.Albums.ByArist = async function(query, ...params)
{
    const result = await Items.Artists.Search(query);

    if (!result.status) return result;

    const result2 = await Items.Albums({artistIds: result.items.map(item => item.Id).join("|")}, ...params);

    if (!result2.status) return result2;

    result2.albums = result.items;

    return result2;
};

/*********************************************************************************
 * Find Artist
 */

Items.Artists.ByGenre = async function(query, ...params)
{
    const result = await Items.MusicGenres.Search(query);

    if (!result.status) return result;

    const result2 = await Items.Artists({genres: result.items.map(item => item.Name).join("|")}, ...params);

    if (!result2.status) return result2;

    result2.artists = result.items;

    return result2;
};

/*********************************************************************************
 * Find Songs
 */

Items.Music.ByGenre = async function(query, ...params)
{
    const result = await Items.MusicGenres.Search(query);

    if (!result.status) return result;

    const result2 = await Items.Music({genres: result.items.map(item => item.Name).join("|")}, ...params);

    if (!result2.status) return result2;

    result2.genres = result.items;

    return result2;
};

Items.Music.ByArist = async function(query, ...params)
{
    const result = await Items.Artists.Search(query);

    if (!result.status) return result;

    const result2 = await Items.Music({artistIds: result.items.map(item => item.Id).join("|")}, ...params);

    if (!result2.status) return result2;

    result2.artists = result.items;

    return result2;
};

Items.Music.ByAlbum = async function(query, ...params)
{
    const result = await Items.Albums.Search(query);

    if (!result.status) return result;

    const result2 = await Items.Music({albumIds: result.items.map(item => item.Id).join("|")}, ...params);

    if (!result2.status) return result2;

    result2.albums = result.items;

    return result2;
};

/*********************************************************************************
 * Find Songs by playlist
 */

/*Items.Music.ByPlayList = async function(query, ...params)
{
    const result = await Items.Playlists.Search(query, {fields: "ItemIds"});

    if (!result.status) return result;

    const items = { };

    for(item of result.items)
    {
        const result2 = await Items({parentId: item.Id}, ...params);

        if (!result2.status) continue;

        result2.items.forEach(item => items[item.Id] = item);
    }

    result.playlists = result.items;

    result.items = Object.values(items);

    return result;
};*/

/*********************************************************************************
 * Exports
 */

module.exports = Items;