/*
 * La page DUI de ztech_media : un lecteur par navigateur, chez chaque client.
 *
 * Servie par le serveur de jeu lui-meme (SMedia.lua, SetHttpHandler) : une
 * origine http, que YouTube accepte la ou une page NUI est refusee. Le Lua
 * lui parle par postMessage (DuiBrowser:init, init, update, stop) et elle
 * repond par les callbacks NUI de la resource, dont le nom est dans
 * l'adresse. Le protocole est celui de pmms-dui (kibook), pour que la page
 * de kibook reste utilisable a la place de celle-ci.
 *
 * Le volume se regle a chaque image d'apres ce que le Lua dit : la
 * distance, la meme piece ou non, la pause. Le decalage se cale sur l'horloge
 * du serveur a deux secondes pres.
 *
 * Les pubs YouTube sont sautees : le navigateur du jeu laisse la page lire
 * dans le cadre du lecteur, on y detecte la pub, on la coupe et on la passe.
 */

var MAX_DRIFT = 2;
var AD_TICK = 250;

var resourceName = 'ztech_media';
var currentServerEndpoint = '127.0.0.1:30120';

function sendMessage(name, params) {
    return fetch('https://' + resourceName + '/' + name, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(params),
    });
}

/* ## Le son « vieux poste »
 *
 * Un passe-bande et un peu de gain en moins : ce qu'un transistor laisse
 * passer. Pose une fois, quand le media joue. */
function sourceOf(player) {
    if (player.youTubeApi) {
        var video = player.youTubeApi.getIframe().contentWindow.document.querySelector('.html5-main-video');
        return video;
    }
    if (player.hlsPlayer) return player.hlsPlayer.media;
    if (player.originalNode) return player.originalNode;
    return player;
}

function applyFilter(player) {
    try {
        var context = new (window.AudioContext || window.webkitAudioContext)();
        var element = sourceOf(player);
        if (!element) return;

        var source = context.createMediaElementSource(element);
        var gain = context.createGain();
        gain.gain.value = 0.5;

        var lowpass = context.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = 5000;

        var highpass = context.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 200;

        source.connect(gain);
        gain.connect(lowpass);
        lowpass.connect(highpass);
        highpass.connect(context.destination);
    } catch (e) {
        console.log('ztech_media: filtre impossible : ' + e.message);
    }
}

/* ## Les pubs
 *
 * Le lecteur YouTube marque son cadre `ad-showing` pendant une pub. On la
 * rend muette, on appuie sur « Passer » des qu'il parait, et on l'envoie a
 * sa fin pour celles qui ne se passent pas. Le volume reste a zero tant
 * qu'elle est la : update() le lit. */
var AD_MARKERS = [
    '.ytp-ad-player-overlay', '.ytp-ad-player-overlay-layout', '.ytp-ad-text', '.ytp-ad-preview-container',
    '.ytp-ad-preview-text', '.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern',
    '.ytp-ad-persistent-progress-bar-container', '.ytp-ad-simple-ad-badge', '.ytp-ad-badge',
    '.ytp-ad-visit-advertiser-button', '.ytp-ad-duration-remaining', '.video-ads .ytp-ad-module > *',
].join(', ');

/* Une pub est la si le lecteur se marque comme tel, ou si l'un de ses
 * habillages de pub est a l'ecran. */
function isAdShowing(doc, frame) {
    if (frame && (frame.classList.contains('ad-showing') || frame.classList.contains('ad-interrupting'))) return true;

    try {
        if (frame && typeof frame.getAdState === 'function' && frame.getAdState() > 0) return true;
    } catch (e) { /* pas cette version du lecteur */ }

    return !!doc.querySelector(AD_MARKERS);
}

/* Ce que le cadre montre, en une ligne : les classes du lecteur, les
 * elements de pub presents, le temps de la video. */
function describeFrame(doc, frame, showing) {
    var ads = [];
    var all = doc.querySelectorAll('[class*="ytp-ad"], [class*="video-ads"]');

    for (var i = 0; i < all.length && ads.length < 8; i++) {
        var name = String(all[i].className).split(/\s+/)[0];
        if (ads.indexOf(name) < 0 && all[i].offsetParent !== null) ads.push(name);
    }

    var video = doc.querySelector('.html5-main-video');

    return (showing ? 'PUB' : 'pas de pub') + ' | lecteur : ' + (frame ? String(frame.className).replace(/\s+/g, ' ').slice(0, 160) : 'absent')
        + ' | pub visibles : ' + (ads.join(' ') || 'aucun')
        + ' | video : ' + (video ? Math.round(video.currentTime) + '/' + Math.round(video.duration) : 'absente');
}

function watchAds(player) {
    if (!player.youTubeApi || player.zm.adWatcher) return;

    var api = player.youTubeApi;
    var probed = false;

    player.zm.adWatcher = setInterval(function () {
        var doc = null;

        try {
            doc = api.getIframe().contentWindow.document;
            if (doc && !doc.querySelector) doc = null;
        } catch (e) {
            doc = null;
        }

        /* Une fois : le cadre est-il lisible d'ici. Sans lui, pas de saut. */
        player.zm.probes++;

        if (!probed && (doc || player.zm.probes > 20)) {
            probed = true;
            sendMessage('duiInfo', {handle: player.zm.handle, frame: !!doc});
        }

        if (!doc) return;

        var frame = doc.querySelector('.html5-video-player') || doc.getElementById('movie_player');
        var showing = isAdShowing(doc, frame);

        /* Les vingt premieres secondes : ce que le lecteur montre, en clair,
         * pour reconnaitre la pub telle que YouTube la marque aujourd'hui. */
        if (player.zm.probes < 80 && player.zm.probes % 8 === 0 && (showing || player.zm.probes === 8)) {
            sendMessage('duiInfo', {handle: player.zm.handle, debug: describeFrame(doc, frame, showing)});
        }

        if (showing !== player.zm.adShowing) {
            player.zm.adShowing = showing;
            sendMessage('duiInfo', {handle: player.zm.handle, ad: showing});
        }

        if (!showing) return;

        /* Le son est coupe par update(), qui lit adShowing ; ici on passe la
         * pub : « Passer » des qu'il parait, sa fin pour les autres. */
        var video = doc.querySelector('.html5-main-video');

        if (video) {
            video.playbackRate = 16;

            if (isFinite(video.duration) && video.duration > 0) {
                video.currentTime = video.duration;
            }
        }

        var skip = doc.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button');
        if (skip) skip.click();

        var overlay = doc.querySelector('.ytp-ad-overlay-close-button');
        if (overlay) overlay.click();
    }, AD_TICK);
}

/* ## Les erreurs
 *
 * MediaElement met le code YouTube dans le message de l'evenement
 * (« Code 150: ... ») ; on le traduit, pour que le joueur et le journal
 * sachent pourquoi ca ne joue pas. */
var YT_ERRORS = {
    2: 'lien YouTube invalide',
    5: 'le lecteur HTML5 de YouTube a échoué',
    100: 'vidéo introuvable, retirée ou privée',
    101: 'la chaîne interdit la lecture hors de YouTube',
    150: 'la chaîne interdit la lecture hors de YouTube',
    153: 'YouTube refuse cette page (referer manquant)',
};

function describeError(event, media) {
    var text = (event && event.message) || (media && media.error && media.error.message) || '';
    var code = text.match(/Code (\d+)/);

    if (code && YT_ERRORS[code[1]]) return YT_ERRORS[code[1]] + ' (YouTube ' + code[1] + ')';
    if (code) return 'YouTube ' + code[1];

    return text || 'erreur inconnue';
}

/* ## Le lecteur */

function showLoading(on) {
    document.getElementById('loading').style.display = on ? 'block' : 'none';
}

function initPlayer(id, handle, options) {
    var element = document.createElement('video');
    element.id = id;
    element.src = options.url;
    document.body.appendChild(element);

    options.attenuation = options.attenuation || {sameRoom: 4, diffRoom: 6};

    new MediaElement(id, {
        error: function (media, event) {
            showLoading(false);
            sendMessage('initError', {url: options.url, message: describeError(event, media)});
            media.remove();
        },
        success: function (media) {
            media.className = 'player';
            media.zm = {
                handle: handle,
                initialized: false,
                attenuationFactor: options.attenuation.diffRoom,
                volumeFactor: options.diffRoomVolume || 0.25,
                adShowing: false,
                adWatcher: null,
                probes: 0,
                started: false,
            };
            media.volume = 0;

            media.addEventListener('error', function (event) {
                showLoading(false);
                sendMessage('playError', {url: options.url, message: describeError(event, media)});
                if (!media.zm.initialized) media.remove();
            });

            media.addEventListener('canplay', function () {
                if (media.zm.initialized) return;

                showLoading(false);

                if (!isFinite(media.duration) || media.duration === 0 || media.hlsPlayer) {
                    options.offset = 0;
                    options.duration = false;
                    options.loop = false;
                } else {
                    options.duration = media.duration;
                }

                if (media.youTubeApi) {
                    try { options.title = media.youTubeApi.getVideoData().title; } catch (e) { /* sans titre */ }
                } else if (media.twitchPlayer) {
                    try {
                        var button = media.twitchPlayer._iframe.contentWindow.document.querySelector('button[data-a-target="player-overlay-mature-accept"]');
                        if (button) button.click();
                    } catch (e) { /* pas d'avertissement a fermer */ }
                }

                sendMessage('init', {handle: handle, options: options});
                media.zm.initialized = true;
                media.play();
            });

            media.addEventListener('playing', function () {
                if (options.filter && !media.zm.filterAdded) {
                    applyFilter(media);
                    media.zm.filterAdded = true;
                }
            });

            /* La pub d'ouverture joue avant que le lecteur ne dise « lecture » :
             * on surveille des que le lecteur YouTube existe. */
            var waitApi = setInterval(function () {
                if (!document.getElementById(id)) return clearInterval(waitApi);

                if (media.youTubeApi) {
                    clearInterval(waitApi);
                    watchAds(media);
                }
            }, 200);

            media.play();
        },
    });
}

function getPlayer(handle, options) {
    if (handle === undefined) return null;

    var id = 'player_' + String(handle);
    var player = document.getElementById(id);

    if (!player && options && options.url) player = initPlayer(id, handle, options);

    return player;
}

function parseTimecode(timecode) {
    if (typeof timecode !== 'string') return timecode;

    if (timecode.indexOf(':') >= 0) {
        var parts = timecode.split(':');
        return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
    }

    return parseInt(timecode, 10);
}

function init(data) {
    if (!data.options || !data.options.url) return;

    showLoading(true);
    data.options.offset = parseTimecode(data.options.offset) || 0;
    if (!data.options.title) data.options.title = data.options.url;

    getPlayer(data.handle, data.options);
}

function stop(handle) {
    var player = getPlayer(handle);
    if (!player) return;

    if (player.zm && player.zm.adWatcher) clearInterval(player.zm.adWatcher);

    try { player.pause(); } catch (e) { /* deja arrete */ }

    player.remove();
}

/* ## Le volume, a chaque image */

function approach(current, target, step) {
    if (current > target) return Math.max(target, current - step);
    return Math.min(target, current + step);
}

function update(data) {
    var player = getPlayer(data.handle, data.options);
    if (!player || !player.zm) return;

    var options = data.options;
    var out = data.distance < 0 || data.distance > options.range || options.paused;

    if (out) {
        if (!player.paused) player.pause();
        return;
    }

    if (data.sameRoom) {
        player.zm.attenuationFactor = approach(player.zm.attenuationFactor, options.attenuation.sameRoom, 0.1);
        player.zm.volumeFactor = approach(player.zm.volumeFactor, 1.0, 0.01);
    } else {
        player.zm.attenuationFactor = approach(player.zm.attenuationFactor, options.attenuation.diffRoom, 0.1);
        player.zm.volumeFactor = approach(player.zm.volumeFactor, options.diffRoomVolume, 0.01);
    }

    if (player.readyState > 0) {
        var volume = 0;

        if (!options.muted && data.volume > 0 && !player.zm.adShowing) {
            volume = ((100 - data.distance * player.zm.attenuationFactor) / 100) * player.zm.volumeFactor * (data.volume / 100);
        }

        volume = Math.max(0, Math.min(1, volume));

        if (data.distance > 100 && volume > 0) {
            player.volume = approach(player.volume, volume, 0.05);
        } else {
            player.volume = volume;
        }

        /* La musique commence vraiment : le serveur recale son chrono, pour
         * que tout le monde parte de zero avec celui qui a lance. */
        if (!player.zm.started && !player.zm.adShowing && player.currentTime > 0.2) {
            player.zm.started = true;
            sendMessage('started', {handle: data.handle});
        }

        if (options.duration && !player.zm.adShowing && player.zm.started) {
            var expected = options.offset % player.duration;

            if (Math.abs(expected - player.currentTime) > MAX_DRIFT) player.currentTime = expected;
        }

        if (player.paused) player.play();
    }
}

/* ## Ce que le Lua envoie */

window.addEventListener('message', function (event) {
    var data = event.data || {};

    switch (data.type) {
        case 'init': init(data); break;
        case 'update': update(data); break;
        case 'stop': stop(data.handle); break;
        case 'play': break;
        case 'DuiBrowser:init': sendMessage('DuiBrowser:initDone', {handle: data.handle}); break;
        default: break;
    }
});

window.addEventListener('load', function () {
    var params = new URLSearchParams(window.location.search);
    resourceName = params.get('resourceName') || resourceName;

    sendMessage('duiStartup', {}).then(function (resp) { return resp.json(); }).then(function (resp) {
        if (resp && resp.currentServerEndpoint) currentServerEndpoint = resp.currentServerEndpoint;
    }).catch(function () { /* le Lua n'a pas repondu : rien a regler */ });
});
