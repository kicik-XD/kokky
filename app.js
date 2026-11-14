(() => {
  "use strict";

  const library = window.KOKKY;
  if (!library) return;

  const FILE_MODE = window.location.protocol === "file:";

  const PIPED =
    Array.isArray(library.piped) && library.piped.length
      ? library.piped
      : ["https://api.piped.private.coffee", "https://pipedapi.ducks.party"];

  const FEED_QUERIES =
    Array.isArray(library.feedQueries) && library.feedQueries.length
      ? library.feedQueries
      : ["pop music", "hip hop music", "rock music", "r&b music", "indie music"];

  const STORE = {
    liked: "kokky:liked:yt",
    volume: "kokky:volume",
    motion: "kokky:motion",
    playlists: "kokky:playlists:yt",
    feed: "kokky:feed:yt",
  };

  const FALLBACK_COVER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480"><rect width="480" height="480" fill="#0d0d0d"/><path d="M240 152 336 328H144Z" fill="#262626"/></svg>'
  )}`;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  let feed = [];
  let feedError = false;

  /* =========================================================
     Track helpers
     ========================================================= */

  const ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };

  const decodeEntities = (value) =>
    String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, code) => {
      const key = String(code).toLowerCase();
      if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
      return ENTITIES[key] || match;
    });

  const cleanArtist = (name) =>
    decodeEntities(name || "YouTube")
      .replace(/\s*-\s*Topic$/i, "")
      .replace(/\s+/g, " ")
      .trim() || "YouTube";

  const videoIdFrom = (url) => {
    const match = String(url || "").match(/[?&]v=([\w-]{11})/);
    if (match) return match[1];
    const tail = String(url || "").split("/").pop() || "";
    return /^[\w-]{11}$/.test(tail) ? tail : "";
  };

  const coverFor = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  const fromPiped = (item) => {
    if (!item || item.type === "channel" || item.type === "playlist") return null;
    const id = videoIdFrom(item.url) || (item.id && /^[\w-]{11}$/.test(item.id) ? item.id : "");
    if (!id) return null;
    return {
      id,
      videoId: id,
      title: decodeEntities(item.title || "без названия").trim() || "без названия",
      artist: cleanArtist(item.uploaderName),
      duration: Math.max(0, Math.round(Number(item.duration) || 0)),
      cover: coverFor(id),
      permalink: `https://www.youtube.com/watch?v=${id}`,
      genre: "",
      album: null,
    };
  };

  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((track) => {
      if (!track || !track.id || seen.has(track.id)) return false;
      seen.add(track.id);
      return true;
    });
  };

  const isCachedTrack = (track) =>
    !!track &&
    typeof track.id === "string" &&
    /^[\w-]{11}$/.test(track.id) &&
    typeof track.title === "string";

  /* =========================================================
     YouTube search (Piped or official Data API)
     ========================================================= */

  async function requestJson(url, signal) {
    const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function pipedJson(path, signal) {
    let lastError = null;

    for (const base of PIPED) {
      try {
        const json = await requestJson(`${base}${path}`, signal);
        if (!json || typeof json !== "object") throw new Error("bad payload");
        return json;
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        lastError = error;
      }
    }

    throw lastError || new Error("piped unavailable");
  }

  async function searchPiped(query, limit = 24, signal, maxSeconds = 5400) {
    const json = await pipedJson(
      `/search?q=${encodeURIComponent(query)}&filter=music_songs`,
      signal
    );
    const items = Array.isArray(json.items) ? json.items : [];

    const tracks = items
      .map(fromPiped)
      .filter(Boolean)
      .filter(
        (track) =>
          track.duration === 0 || (track.duration >= 30 && track.duration <= maxSeconds)
      );

    return dedupe(tracks).slice(0, limit);
  }

  function parseISODuration(value) {
    const match = String(value || "").match(
      /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
    );
    if (!match) return 0;
    return (
      (Number(match[1]) || 0) * 86400 +
      (Number(match[2]) || 0) * 3600 +
      (Number(match[3]) || 0) * 60 +
      (Number(match[4]) || 0)
    );
  }

  async function searchOfficial(query, limit = 24, signal) {
    const key = library.youtube?.apiKey;
    const base = "https://www.googleapis.com/youtube/v3";
    const max = Math.min(25, Math.max(1, limit));

    const found = await requestJson(
      `${base}/search?part=snippet&type=video&videoCategoryId=10&maxResults=${max}` +
        `&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`,
      signal
    );

    const items = Array.isArray(found.items) ? found.items : [];
    const ids = items.map((item) => item.id?.videoId).filter(Boolean);
    if (!ids.length) return [];

    let durations = new Map();
    try {
      const details = await requestJson(
        `${base}/videos?part=contentDetails&id=${ids.join(",")}` +
          `&key=${encodeURIComponent(key)}`,
        signal
      );
      durations = new Map(
        (details.items || []).map((item) => [
          item.id,
          parseISODuration(item.contentDetails?.duration),
        ])
      );
    } catch (_) {
      /* длительности необязательны — плеер уточнит их сам */
    }

    return items
      .map((item) => {
        const id = item.id?.videoId;
        if (!id) return null;
        return {
          id,
          videoId: id,
          title: decodeEntities(item.snippet?.title || "без названия").trim(),
          artist: cleanArtist(item.snippet?.channelTitle),
          duration: durations.get(id) || 0,
          cover: coverFor(id),
          permalink: `https://www.youtube.com/watch?v=${id}`,
          genre: "",
          album: null,
        };
      })
      .filter(Boolean);
  }

  function fetchYouTubeTracks(query, limit = 24, signal) {
    if (library.youtube?.apiKey) return searchOfficial(query, limit, signal);
    return searchPiped(query, limit, signal);
  }

  function readFeedCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(STORE.feed) || "null");
      if (!cached || !Array.isArray(cached.tracks)) return { tracks: [], at: 0 };
      return {
        tracks: cached.tracks.filter(isCachedTrack),
        at: Number(cached.at) || 0,
      };
    } catch (_) {
      return { tracks: [], at: 0 };
    }
  }

  function writeFeedCache(tracks) {
    try {
      localStorage.setItem(
        STORE.feed,
        JSON.stringify({ at: Date.now(), tracks: tracks.slice(0, 60) })
      );
    } catch (_) {
      /* ignore */
    }
  }

  async function fetchFeed() {
    const settled = await Promise.allSettled(
      FEED_QUERIES.map((query) => searchPiped(query, 20, undefined, 900))
    );

    const lists = settled
      .filter((result) => result.status === "fulfilled" && result.value.length)
      .map((result) => result.value);

    if (!lists.length) throw new Error("feed unavailable");

    const merged = [];
    const seen = new Set();

    for (let index = 0; merged.length < 60; index += 1) {
      let added = false;
      for (const list of lists) {
        const track = list[index];
        if (!track) continue;
        added = true;
        if (seen.has(track.id)) continue;
        seen.add(track.id);
        merged.push(track);
        if (merged.length >= 60) break;
      }
      if (!added) break;
    }

    return merged;
  }

  /* =========================================================
     Player state
     ========================================================= */

  const state = {
    view: "stream",
    queue: [],
    index: 0,
    current: null,
    liked: new Set(),
    volume: 0.8,
    muted: false,
    closed: false,
    playing: false,
  };

  try {
    const savedLikes = JSON.parse(localStorage.getItem(STORE.liked) || "[]");
    if (Array.isArray(savedLikes)) state.liked = new Set(savedLikes);
  } catch (_) {
    /* ignore broken storage */
  }

  try {
    const savedVolume = Number.parseFloat(localStorage.getItem(STORE.volume));
    if (Number.isFinite(savedVolume)) {
      state.volume = Math.min(1, Math.max(0, savedVolume));
    }
  } catch (_) {
    /* ignore broken storage */
  }

  let userPlaylists = [];
  try {
    const savedPlaylists = JSON.parse(localStorage.getItem(STORE.playlists) || "[]");
    if (Array.isArray(savedPlaylists)) {
      userPlaylists = savedPlaylists.filter(
        (playlist) =>
          playlist &&
          typeof playlist.id === "string" &&
          typeof playlist.title === "string" &&
          Array.isArray(playlist.tracks)
      );
    }
  } catch (_) {
    /* ignore broken storage */
  }

  const dom = {
    body: document.body,
    stage: $("#stage"),
    art: $(".art"),
    artNotice: $("#artNotice"),
    serverHelpBtn: $("#serverHelpBtn"),
    playerView: $("#view-stream"),
    views: {
      stream: $("#view-stream"),
      search: $("#view-search"),
      playlists: $("#view-playlists"),
      playlist: $("#view-playlist"),
    },
    navItems: $$(".nav__item"),
    playBtn: $("#playBtn"),
    prevBtn: $("#prevBtn"),
    nextBtn: $("#nextBtn"),
    seek: $("#seek"),
    seekFill: $("#seekFill"),
    seekLabel: $("#seekLabel"),
    seekTime: $("#seekTime"),
    cover: $("#coverImage"),
    artistName: $("#artistName"),
    trackTitle: $("#trackTitle"),
    likeBtns: $$(".like"),
    playlistBtn: $("#playlistBtn"),
    volumeBtn: $("#volumeBtn"),
    volumeRange: $("#volumeRange"),
    volumeValue: $("#volumeValue"),
    volumeWrap: $("#volumeWrap"),
    trackMenuBtn: $("#trackMenuBtn"),
    trackMenu: $("#trackMenu"),
    trackSourceLink: $("#trackSourceLink"),
    topMenuBtn: $("#topMenuBtn"),
    topMenu: $("#topMenu"),
    settingsBtn: $("#settingsBtn"),
    settingsMenu: $("#settingsMenu"),
    settingsItemMotion: $('[data-action="toggle-motion"]'),
    motionCheck: $("#motionCheck"),
    closeBtn: $("#closeBtn"),
    reopenBtn: $("#reopenBtn"),
    searchInput: $("#searchInput"),
    results: $("#results"),
    playlists: $("#playlists"),
    playlistBack: $("#playlistBack"),
    playlistTitle: $("#playlistTitle"),
    playlistMeta: $("#playlistMeta"),
    playlistPlay: $("#playlistPlay"),
    playlistAdd: $("#playlistAdd"),
    playlistTracks: $("#playlistTracks"),
    playlistDialog: $("#playlistDialog"),
    dialogTitle: $("#dialogTitle"),
    dialogBody: $("#dialogBody"),
    toast: $("#toast"),
    menuButtons: [$("#topMenuBtn"), $("#trackMenuBtn"), $("#settingsBtn")],
    menus: [$("#topMenu"), $("#trackMenu"), $("#settingsMenu")],
  };

  let rafId = null;
  let lastProgress = -1;
  let lastSecond = -1;
  let toastTimer = null;
  let scrubbing = false;

  /* =========================================================
     Helpers
     ========================================================= */

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return `${minutes}:${String(rest).padStart(2, "0")}`;
  };

  const tracksWord = (count) => {
    const last = count % 10;
    const lastTwo = count % 100;
    if (last === 1 && lastTwo !== 11) return "трек";
    if (last >= 2 && last <= 4 && (lastTwo < 10 || lastTwo >= 20)) return "трека";
    return "треков";
  };

  const isLiked = (track) => !!track && state.liked.has(track.id);

  function persistLikes() {
    try {
      localStorage.setItem(STORE.liked, JSON.stringify([...state.liked]));
    } catch (_) {
      /* ignore */
    }
  }

  function toast(message, duration = 2600) {
    dom.toast.textContent = message;
    dom.toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      dom.toast.classList.remove("is-visible");
    }, duration);
  }

  function guardCover(image, fallback = FALLBACK_COVER) {
    image.addEventListener(
      "error",
      () => {
        if (image.src !== fallback) image.src = fallback;
      },
      { once: false }
    );
  }

  /* =========================================================
     Menus
     ========================================================= */

  function closeMenus() {
    dom.menus.forEach((menu) => menu.classList.remove("is-open"));
    dom.menuButtons.forEach((button) => button.setAttribute("aria-expanded", "false"));
    dom.volumeWrap.classList.remove("is-open");
  }

  function toggleMenu(menu, button) {
    const willOpen = !menu.classList.contains("is-open");
    closeMenus();
    if (willOpen) {
      menu.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
    }
  }

  dom.topMenuBtn.addEventListener("click", () => toggleMenu(dom.topMenu, dom.topMenuBtn));
  dom.trackMenuBtn.addEventListener("click", () => toggleMenu(dom.trackMenu, dom.trackMenuBtn));
  dom.settingsBtn.addEventListener("click", () => {
    toggleMenu(dom.settingsMenu, dom.settingsBtn);
    syncMotionUI();
  });

  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".menu") && !event.target.closest('[aria-haspopup="menu"]')) {
      closeMenus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenus();
      if (dom.playlistDialog && !dom.playlistDialog.hidden) closeDialog();
      if (dom.volumeWrap.classList.contains("is-open")) {
        dom.volumeWrap.classList.remove("is-open");
      }
    }
  });

  dom.menus.forEach((menu) => {
    menu.addEventListener("click", (event) => {
      if (event.target.closest("a, button")) closeMenus();
    });
  });

  /* =========================================================
     Toast actions
     ========================================================= */

  document.addEventListener("click", (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === "shortcuts") {
      toast("space — пауза · ← → — 5 сек · ↑ ↓ — звук");
    }

    if (action === "about") {
      toast("kokky · полные треки с YouTube · без аккаунта");
    }

    if (action === "add-to-playlist") {
      openAddToPlaylist();
    }

    if (action === "copy-link") {
      if (!state.current) return;
      const url = state.current.permalink || library.source.url;
      copyText(url).then((ok) => {
        toast(ok ? "ссылка скопирована" : "не удалось скопировать");
      });
    }

    if (action === "toggle-motion") {
      const reduced = !dom.body.classList.contains("reduce-motion");
      dom.body.classList.toggle("reduce-motion", reduced);
      try {
        localStorage.setItem(STORE.motion, reduced ? "1" : "0");
      } catch (_) {
        /* ignore */
      }
      syncMotionUI();
      toast(reduced ? "анимации уменьшены" : "анимации включены");
    }

    if (action === "clear-likes") {
      state.liked.clear();
      persistLikes();
      syncLikeButtons(false);
      toast("избранное очищено");
    }
  });

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      /* fall through to legacy copy */
    }

    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  /* =========================================================
     Player UI
     ========================================================= */

  function updateTrackUI(track) {
    const artist = track.artist || library.source.name;

    dom.cover.src = track.cover || FALLBACK_COVER;
    dom.cover.alt = `${track.title} — ${artist}`;
    dom.artistName.textContent = artist;
    dom.artistName.classList.toggle("is-long", artist.length > 18);
    dom.trackTitle.textContent = track.title;
    dom.seekLabel.textContent = `${artist} — ${track.title}`;
    dom.trackSourceLink.href = track.permalink || library.source.url;
    dom.playlistBtn.disabled = false;
    document.title = `${track.title} — ${artist} · kokky`;

    syncLikeButtons(false);
    markCurrentRow();
    updateMediaSession(track);
    resetProgressUI();
  }

  function resetProgressUI() {
    const duration = state.current?.duration || 0;
    lastProgress = -1;
    lastSecond = -1;
    dom.seekFill.style.width = "0%";
    dom.seekTime.textContent = `0:00 / ${formatTime(duration)}`;
    dom.seek.setAttribute("aria-valuenow", "0");
    dom.seek.setAttribute("aria-valuemax", String(Math.max(1, Math.round(duration))));
  }

  function updateProgress() {
    const duration = getDuration();
    const current = duration > 0 ? Math.min(getCurrentTime(), duration) : 0;
    const percent = duration > 0 ? (current / duration) * 100 : 0;
    const second = Math.floor(current);

    if (Math.abs(percent - lastProgress) > 0.03) {
      dom.seekFill.style.width = `${percent.toFixed(2)}%`;
      lastProgress = percent;
    }

    if (second !== lastSecond) {
      dom.seekTime.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
      dom.seek.setAttribute("aria-valuenow", String(second));
      dom.seek.setAttribute("aria-valuemax", String(Math.max(1, Math.round(duration))));
      lastSecond = second;
    }
  }

  function startTicker() {
    if (rafId) return;
    const tick = () => {
      updateProgress();
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
  }

  function stopTicker() {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    updateProgress();
  }

  function syncPlayState() {
    const playing = !!state.playing;
    dom.body.classList.toggle("is-playing", playing);
    dom.playBtn.setAttribute("aria-label", playing ? "Пауза" : "Играть");
  }

  function syncLikeButtons(animate) {
    const liked = isLiked(state.current);
    dom.likeBtns.forEach((button) => {
      button.classList.toggle("is-liked", liked);
      button.setAttribute("aria-pressed", liked ? "true" : "false");
      button.setAttribute("aria-label", liked ? "Убрать из избранного" : "В избранное");
      if (animate && liked) {
        button.classList.remove("is-liked");
        void button.offsetWidth;
        button.classList.add("is-liked");
      }
    });
  }

  function toggleLike() {
    if (!state.current) return;
    if (state.liked.has(state.current.id)) {
      state.liked.delete(state.current.id);
    } else {
      state.liked.add(state.current.id);
    }
    persistLikes();
    syncLikeButtons(true);
  }

  dom.likeBtns.forEach((button) => button.addEventListener("click", toggleLike));

  /* =========================================================
     Volume
     ========================================================= */

  function applyVolume(persist = false) {
    const percent = Math.round(state.volume * 100);

    if (ytReady) {
      try {
        ytPlayer.setVolume(percent);
        if (state.muted || state.volume === 0) ytPlayer.mute();
        else ytPlayer.unMute();
      } catch (_) {
        /* player is not ready yet */
      }
    }

    dom.volumeRange.value = String(percent);
    dom.volumeRange.style.setProperty("--vol", `${percent}%`);
    dom.volumeValue.textContent = String(percent);
    dom.volumeBtn.classList.toggle("is-muted", state.muted || state.volume === 0);
    dom.volumeBtn.setAttribute("aria-pressed", state.muted ? "true" : "false");
    dom.volumeBtn.setAttribute(
      "aria-label",
      state.muted || state.volume === 0 ? "Включить звук" : "Выключить звук"
    );

    if (persist) {
      try {
        localStorage.setItem(STORE.volume, String(state.volume));
      } catch (_) {
        /* ignore */
      }
    }
  }

  dom.volumeBtn.addEventListener("click", () => {
    if (state.muted || state.volume === 0) {
      state.muted = false;
      if (state.volume === 0) state.volume = 0.6;
    } else {
      state.muted = true;
    }
    applyVolume(true);
  });

  dom.volumeRange.addEventListener("input", () => {
    const value = Number(dom.volumeRange.value) / 100;
    state.volume = Math.min(1, Math.max(0, value));
    state.muted = false;
    applyVolume(true);
  });

  /* =========================================================
     YouTube player
     ========================================================= */

  let ytPlayer = null;
  let ytReady = false;
  let pendingCue = null;
  let errorStreak = 0;

  const PLAYER_STATE = {
    UNSTARTED: -1,
    ENDED: 0,
    PLAYING: 1,
    PAUSED: 2,
    BUFFERING: 3,
    CUED: 5,
  };

  function getDuration() {
    if (ytReady) {
      try {
        const live = Number(ytPlayer.getDuration());
        if (Number.isFinite(live) && live > 0) return live;
      } catch (_) {
        /* ignore */
      }
    }
    return state.current?.duration || 0;
  }

  function getCurrentTime() {
    if (!ytReady) return 0;
    try {
      return Number(ytPlayer.getCurrentTime()) || 0;
    } catch (_) {
      return 0;
    }
  }

  function playerState() {
    if (!ytReady) return PLAYER_STATE.UNSTARTED;
    try {
      return ytPlayer.getPlayerState();
    } catch (_) {
      return PLAYER_STATE.UNSTARTED;
    }
  }

  function cueTrack(track, { autoplay = false } = {}) {
    if (FILE_MODE) return;

    if (!ytReady || !track) {
      pendingCue = { autoplay };
      return;
    }

    const id = track.videoId || track.id;
    if (!/^[\w-]{11}$/.test(id)) {
      toast("у этого трека нет видео YouTube · включите другой");
      return;
    }

    pendingCue = null;
    dom.art.classList.add("has-player");

    try {
      if (autoplay) ytPlayer.loadVideoById(id);
      else ytPlayer.cueVideoById(id);
    } catch (_) {
      toast("не удалось включить трек · попробуйте ещё раз");
    }
  }

  function loadTrack(track, { autoplay = false } = {}) {
    if (!track) return;
    state.current = track;

    updateTrackUI(track);
    cueTrack(track, { autoplay });
  }

  function playAudio({ silent = false } = {}) {
    if (FILE_MODE) {
      openServerHelp();
      return;
    }

    if (!state.current) return;
    if (!ytReady) {
      pendingCue = { autoplay: true };
      return;
    }

    try {
      ytPlayer.playVideo();
    } catch (_) {
      if (!silent) toast("не удалось включить трек · проверьте соединение");
    }
  }

  function pauseAudio() {
    if (!ytReady) return;
    try {
      ytPlayer.pauseVideo();
    } catch (_) {
      /* ignore */
    }
  }

  function togglePlay() {
    if (FILE_MODE) {
      openServerHelp();
      return;
    }

    if (!state.current) return;
    const status = playerState();

    if (status === PLAYER_STATE.PLAYING || status === PLAYER_STATE.BUFFERING) {
      pauseAudio();
    } else {
      if (!ytReady || status === PLAYER_STATE.CUED || status === PLAYER_STATE.UNSTARTED) {
        cueTrack(state.current, { autoplay: true });
      } else {
        playAudio();
      }
    }
  }

  function openPlayer() {
    if (!state.closed) return;
    state.closed = false;
    dom.playerView.classList.remove("is-closed");
    dom.stage.classList.remove("is-idle");
  }

  function closePlayer() {
    if (state.closed) return;
    state.closed = true;
    pauseAudio();
    setView("stream");
    dom.playerView.classList.add("is-closed");
    dom.stage.classList.add("is-idle");
    closeMenus();
  }

  function step(direction) {
    if (!state.queue.length) return;
    const wasPlaying = state.playing;
    state.index = (state.index + direction + state.queue.length) % state.queue.length;
    loadTrack(state.queue[state.index], { autoplay: wasPlaying });
  }

  function playTrack(track, queue = feed) {
    if (FILE_MODE) {
      openServerHelp();
      return;
    }

    const list = queue.filter(Boolean);
    let index = list.findIndex((item) => item.id === track.id);
    if (index < 0) {
      index = 0;
    }
    state.queue = list;
    state.index = index;
    openPlayer();
    loadTrack(list[index], { autoplay: true });
    setView("stream");
  }

  function startQueue(queue, startIndex = 0) {
    if (FILE_MODE) {
      openServerHelp();
      return;
    }

    const list = queue.filter(Boolean);
    if (!list.length) return;
    const index = Math.min(Math.max(0, startIndex), list.length - 1);
    state.queue = list;
    state.index = index;
    openPlayer();
    loadTrack(list[index], { autoplay: true });
    setView("stream");
  }

  function playUserPlaylist(playlist, startIndex = 0) {
    if (!playlist.tracks.length) {
      toast("плейлист пуст · добавьте первый трек");
      return;
    }
    startQueue(
      playlist.tracks.map((track, index) => ({
        ...track,
        album: playlist.title,
        albumId: playlist.id,
        cover: track.cover || FALLBACK_COVER,
        trackNo: index + 1,
      })),
      startIndex
    );
  }

  dom.playBtn.addEventListener("click", togglePlay);
  dom.nextBtn.addEventListener("click", () => step(1));
  dom.prevBtn.addEventListener("click", () => {
    if (getCurrentTime() > 3) {
      seekTo(0);
      updateProgress();
      return;
    }
    step(-1);
  });

  dom.closeBtn.addEventListener("click", closePlayer);
  dom.reopenBtn.addEventListener("click", openPlayer);

  /* =========================================================
     Seek
     ========================================================= */

  function seekTo(seconds) {
    if (!ytReady) return;
    try {
      ytPlayer.seekTo(Math.max(0, seconds), true);
    } catch (_) {
      /* ignore */
    }
  }

  function seekToRatio(ratio) {
    const duration = getDuration();
    if (!Number.isFinite(duration) || duration <= 0) return;
    const clamped = Math.min(1, Math.max(0, ratio));
    seekTo(clamped * duration);
    updateProgress();
  }

  function seekFromPointer(event) {
    const rect = dom.seek.getBoundingClientRect();
    if (rect.width === 0) return;
    seekToRatio((event.clientX - rect.left) / rect.width);
  }

  dom.seek.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    scrubbing = true;
    dom.seek.setPointerCapture?.(event.pointerId);
    seekFromPointer(event);
  });

  dom.seek.addEventListener("pointermove", (event) => {
    if (scrubbing) seekFromPointer(event);
  });

  const endScrub = (event) => {
    if (!scrubbing) return;
    scrubbing = false;
    if (dom.seek.hasPointerCapture?.(event.pointerId)) {
      dom.seek.releasePointerCapture(event.pointerId);
    }
    seekFromPointer(event);
  };

  dom.seek.addEventListener("pointerup", endScrub);
  dom.seek.addEventListener("pointercancel", () => {
    scrubbing = false;
  });

  dom.seek.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      seekToRatio((getCurrentTime() + 5) / getDuration());
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      seekToRatio((getCurrentTime() - 5) / getDuration());
    }
    if (event.key === "Home") {
      event.preventDefault();
      seekToRatio(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      seekToRatio(1);
    }
  });

  /* =========================================================
     YouTube player lifecycle
     ========================================================= */

  function handlePlayerReady() {
    ytReady = true;
    applyVolume();

    if (state.current) {
      cueTrack(state.current, { autoplay: !!pendingCue?.autoplay });
    }
  }

  function handlePlayerState(event) {
    const status = event.data;

    if (status === PLAYER_STATE.PLAYING) {
      errorStreak = 0;
      state.playing = true;
      syncPlayState();
      startTicker();
      updateProgress();
      return;
    }

    if (status === PLAYER_STATE.PAUSED) {
      state.playing = false;
      syncPlayState();
      stopTicker();
      return;
    }

    if (status === PLAYER_STATE.ENDED) {
      state.playing = false;
      syncPlayState();
      stopTicker();
      if (state.queue.length > 1) {
        state.index = (state.index + 1) % state.queue.length;
        loadTrack(state.queue[state.index], { autoplay: true });
      } else {
        seekTo(0);
        updateProgress();
      }
      return;
    }

    if (status === PLAYER_STATE.CUED || status === PLAYER_STATE.UNSTARTED) {
      updateProgress();
    }
  }

  function handlePlayerError(event) {
    const code = Number(event?.data);
    state.playing = false;
    syncPlayState();

    if (code === 150 || code === 101) {
      toast("видео запрещено встраивать · включаем следующий");
    } else if (code === 100 || code === 2) {
      toast("трек недоступен · включаем следующий");
    } else {
      toast("не удалось включить трек · проверьте соединение");
    }

    errorStreak += 1;
    if (errorStreak > 5) {
      errorStreak = 0;
      toast("несколько треков подряд недоступны · попробуйте поиск");
      return;
    }

    if (state.queue.length > 1) {
      window.setTimeout(() => step(1), 700);
    }
  }

  function createPlayer() {
    if (ytPlayer) return;

    const vars = {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      fs: 0,
      iv_load_policy: 3,
    };

    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      vars.origin = window.location.origin;
    }

    ytPlayer = new window.YT.Player("ytPlayer", {
      width: "100%",
      height: "100%",
      playerVars: vars,
      events: {
        onReady: handlePlayerReady,
        onStateChange: handlePlayerState,
        onError: handlePlayerError,
      },
    });
  }

  function loadYouTubeApi() {
    if (FILE_MODE) return;

    if (window.YT && window.YT.Player) {
      createPlayer();
      return;
    }

    window.onYouTubeIframeAPIReady = createPlayer;

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.addEventListener("error", () => {
      toast("YouTube недоступен · проверьте соединение");
    });
    document.head.appendChild(script);
  }

  /* =========================================================
     Search
     ========================================================= */

  let searchTimer = 0;
  let searchController = null;
  let searchToken = 0;

  const compactText = (value) =>
    String(value)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");

  const filterTracks = (query) => {
    const needle = compactText(query);
    if (!needle) return feed;
    return feed.filter((track) =>
      compactText(
        `${track.title} ${track.artist} ${track.album || ""} ${track.genre || ""}`
      ).includes(needle)
    );
  };

  function createResultRow(track, queue) {
    const row = el("button", "result");
    row.type = "button";
    row.dataset.id = track.id;
    row.setAttribute("aria-label", `Включить ${track.title}`);

    const cover = el("img", "result__cover");
    cover.src = track.cover || FALLBACK_COVER;
    cover.alt = "";
    cover.loading = "lazy";
    guardCover(cover);

    const text = el("span", "result__text");
    text.appendChild(el("span", "result__title", track.title));
    text.appendChild(
      el(
        "span",
        "result__meta",
        [track.artist, track.album, track.genre].filter(Boolean).join(" · ") ||
          library.source.name
      )
    );

    const duration = el("span", "result__dur", formatTime(track.duration));

    const play = el("span", "result__play");
    play.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 4.8 20 12 8 19.2V4.8Z" fill="currentColor"/></svg>';

    row.append(cover, text, duration, play);
    row.addEventListener("click", () => playTrack(track, queue));
    return row;
  }

  function markCurrentRow() {
    if (!state.current) return;
    $$(".result", dom.results).forEach((row) => {
      row.classList.toggle("is-current", row.dataset.id === state.current.id);
    });
  }

  function paintNotice(caption) {
    dom.results.innerHTML = "";
    dom.results.appendChild(el("p", "results__caption", caption));
  }

  function paintResults(list, caption) {
    dom.results.innerHTML = "";

    dom.results.appendChild(el("p", "results__caption", caption));

    if (!list.length) {
      const empty = el("div", "empty");
      empty.appendChild(el("strong", "", "ничего не нашлось."));
      empty.appendChild(document.createTextNode("попробуйте другое слово, жанр или исполнителя."));
      dom.results.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    list.forEach((track) => fragment.appendChild(createResultRow(track, list)));
    dom.results.appendChild(fragment);
    markCurrentRow();
  }

  function cancelSearch() {
    window.clearTimeout(searchTimer);
    if (searchController) {
      searchController.abort();
      searchController = null;
    }
    searchToken += 1;
  }

  function scheduleSearch(query, local) {
    const token = ++searchToken;
    window.clearTimeout(searchTimer);
    if (searchController) searchController.abort();

    searchTimer = window.setTimeout(async () => {
      const controller = new AbortController();
      searchController = controller;
      try {
        const remote = await fetchYouTubeTracks(query, 30, controller.signal);
        if (token !== searchToken || dom.searchInput.value.trim() !== query) return;

        const merged = dedupe([...local, ...remote]);
        paintResults(merged, `найдено · ${merged.length}`);
      } catch (error) {
        if (error.name === "AbortError" || token !== searchToken) return;
        const fallback = local.length ? local : filterTracks(query);
        paintResults(
          fallback,
          fallback.length ? `найдено · ${fallback.length}` : "ничего не нашлось · проверьте соединение"
        );
      } finally {
        if (searchController === controller) searchController = null;
      }
    }, 260);
  }

  function renderResults(query = dom.searchInput.value) {
    const normalized = query.trim();

    if (!normalized) {
      cancelSearch();
      if (feed.length) {
        paintResults(feed, `тренды YouTube · ${feed.length}`);
      } else {
        paintNotice(
          feedError ? "не удалось загрузить тренды · попробуйте поиск" : "загружаем тренды YouTube…"
        );
      }
      return;
    }

    const local = filterTracks(normalized);
    paintResults(local, local.length ? `найдено · ${local.length}` : "ищем на YouTube…");
    scheduleSearch(normalized, local);
  }

  dom.searchInput.addEventListener("input", () => renderResults(dom.searchInput.value));

  dom.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dom.searchInput.value) {
      event.stopPropagation();
      dom.searchInput.value = "";
      renderResults();
    }
  });

  /* =========================================================
     Playlists
     ========================================================= */

  function persistUserPlaylists() {
    try {
      localStorage.setItem(STORE.playlists, JSON.stringify(userPlaylists));
    } catch (_) {
      /* ignore */
    }
  }

  function createPlaylist(title, track = null) {
    const playlist = {
      id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      createdAt: Date.now(),
      tracks: track ? [track] : [],
    };
    userPlaylists.unshift(playlist);
    persistUserPlaylists();
    return playlist;
  }

  function addTrackToPlaylist(playlist, track) {
    if (playlist.tracks.some((item) => item.id === track.id)) return false;
    playlist.tracks.push(track);
    persistUserPlaylists();
    return true;
  }

  function removeTrackFromPlaylist(playlist, trackId) {
    const next = playlist.tracks.filter((track) => track.id !== trackId);
    if (next.length === playlist.tracks.length) return false;
    playlist.tracks = next;
    persistUserPlaylists();
    return true;
  }

  let dialogReturnFocus = null;
  let dialogCleanup = null;

  function showDialog(title, nodes, cleanup = null) {
    if (dialogCleanup) dialogCleanup();
    dialogCleanup = cleanup;
    dom.dialogTitle.textContent = title;
    dom.dialogBody.innerHTML = "";
    nodes.forEach((node) => dom.dialogBody.appendChild(node));
    dom.playlistDialog.hidden = false;
    dialogReturnFocus = document.activeElement;
  }

  function closeDialog() {
    if (dom.playlistDialog.hidden) return;
    dom.playlistDialog.hidden = true;
    dom.dialogBody.innerHTML = "";
    if (dialogCleanup) {
      dialogCleanup();
      dialogCleanup = null;
    }
    if (dialogReturnFocus && typeof dialogReturnFocus.focus === "function") {
      dialogReturnFocus.focus({ preventScroll: true });
    }
    dialogReturnFocus = null;
  }

  dom.playlistDialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-dialog]")) closeDialog();
  });

  function appDirectory() {
    try {
      const path = decodeURIComponent(window.location.pathname || "").replace(/^\/+/, "");
      const dir = path.replace(/\/[^/]+$/, "");
      return (dir || "C:\\Users\\Admin\\kokky").replace(/\//g, "\\");
    } catch (_) {
      return "C:\\Users\\Admin\\kokky";
    }
  }

  function openServerHelp() {
    const panel = el("div", "dialog__help");

    panel.appendChild(
      el(
        "p",
        "dialog__hint",
        "YouTube запрещает встроенный плеер на страницах file://. Запустите kokky через локальный сервер — и всё заработает."
      )
    );

    const steps = el("ol", "dialog__steps");
    steps.append(
      el("li", "", "Дважды кликните start.bat в папке kokky."),
      el("li", "", "Откроется http://localhost:8000 — играйте и добавляйте треки.")
    );
    panel.appendChild(steps);

    const command = `cd ${appDirectory()}\npython -m http.server 8000`;
    panel.appendChild(el("pre", "dialog__code", command));

    const actions = el("div", "dialog__actions");

    const copy = el("button", "ghost-pill", "Скопировать команду");
    copy.type = "button";
    copy.addEventListener("click", () => {
      copyText(command).then((ok) => {
        toast(ok ? "команда скопирована" : "не удалось скопировать");
      });
    });

    const done = el("button", "solid-pill", "Понятно");
    done.type = "button";
    done.addEventListener("click", closeDialog);

    actions.append(copy, done);
    panel.appendChild(actions);

    showDialog("как запустить", [panel]);
  }

  dom.serverHelpBtn.addEventListener("click", openServerHelp);

  function openCreateDialog(pendingTrack = null) {
    const form = el("form", "dialog__form");

    const input = el("input", "dialog__input");
    input.type = "text";
    input.maxLength = 60;
    input.placeholder = "название плейлиста";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Название плейлиста");

    const actions = el("div", "dialog__actions");
    const cancel = el("button", "ghost-pill", "Отмена");
    cancel.type = "button";
    cancel.addEventListener("click", closeDialog);

    const submit = el("button", "solid-pill", "Создать");
    submit.type = "submit";
    actions.append(cancel, submit);

    form.append(input, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) {
        input.focus();
        return;
      }
      const playlist = createPlaylist(title, pendingTrack);
      closeDialog();
      renderPlaylists();
      openPlaylist(playlist.id);
      toast(
        pendingTrack
          ? `плейлист «${playlist.title}» создан · трек добавлен`
          : `плейлист «${playlist.title}» создан · добавьте треки`
      );
    });

    showDialog("новый плейлист", [form]);
    window.setTimeout(() => input.focus({ preventScroll: true }), 40);
  }

  function openAddToPlaylist() {
    const track = state.current;
    if (!track) {
      toast("сначала включите трек");
      return;
    }

    if (!userPlaylists.length) {
      openCreateDialog(track);
      return;
    }

    const list = el("div", "dialog__choices");

    userPlaylists.forEach((playlist) => {
      const choice = el("button", "dialog__choice");
      choice.type = "button";
      choice.append(
        el("span", "dialog__choice-name", playlist.title),
        el(
          "span",
          "dialog__choice-meta",
          `${playlist.tracks.length} ${tracksWord(playlist.tracks.length)}`
        )
      );
      choice.addEventListener("click", () => {
        const added = addTrackToPlaylist(playlist, track);
        closeDialog();
        renderPlaylists();
        if (activePlaylistId === playlist.id) renderPlaylistDetail();
        toast(added ? `добавлено в «${playlist.title}»` : `уже есть в «${playlist.title}»`);
      });
      list.appendChild(choice);
    });

    const create = el("button", "dialog__new", "+ новый плейлист");
    create.type = "button";
    create.addEventListener("click", () => openCreateDialog(track));
    list.appendChild(create);

    showDialog("добавить в плейлист", [list]);
  }

  function openAddTracksDialog(playlist) {
    const panel = el("div", "dialog__search");

    const input = el("input", "dialog__input");
    input.type = "search";
    input.placeholder = "найти трек на YouTube";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Поиск трека");

    const hint = el(
      "p",
      "dialog__hint",
      "выберите трек — он сразу появится в плейлисте"
    );

    const list = el("div", "dialog__tracks");
    panel.append(input, hint, list);

    const paint = (tracks, caption) => {
      list.innerHTML = "";
      if (caption) list.appendChild(el("p", "dialog__caption", caption));
      if (!tracks.length) return;

      tracks.forEach((track) => {
        const already = playlist.tracks.some((item) => item.id === track.id);
        const row = el("button", already ? "dialog__track is-added" : "dialog__track");
        row.type = "button";
        row.setAttribute("aria-label", `Добавить ${track.title}`);

        const cover = el("img", "dialog__track-cover");
        cover.src = track.cover || FALLBACK_COVER;
        cover.alt = "";
        cover.loading = "lazy";
        guardCover(cover);

        const text = el("span", "dialog__track-text");
        text.append(
          el("span", "dialog__track-name", track.title),
          el("span", "dialog__track-meta", track.artist)
        );

        const action = el("span", "dialog__track-action", already ? "✓" : "+");

        row.append(
          cover,
          text,
          el("span", "dialog__track-dur", formatTime(track.duration)),
          action
        );

        row.addEventListener("click", () => {
          if (!addTrackToPlaylist(playlist, track)) {
            toast(`уже есть в «${playlist.title}»`);
            return;
          }
          row.classList.add("is-added");
          action.textContent = "✓";
          renderPlaylistDetail();
          renderPlaylists();
          toast(`«${track.title}» добавлен в плейлист`);
        });

        list.appendChild(row);
      });
    };

    paint(feed.slice(0, 30), feed.length ? "тренды YouTube" : "начните вводить название");

    let timer = 0;
    let controller = null;
    let token = 0;

    const runSearch = async (query, currentToken) => {
      controller = new AbortController();
      try {
        const remote = await fetchYouTubeTracks(query, 24, controller.signal);
        if (currentToken !== token) return;
        const merged = dedupe([...filterTracks(query), ...remote]);
        paint(merged, `найдено · ${merged.length}`);
      } catch (error) {
        if (error.name === "AbortError" || currentToken !== token) return;
        const local = filterTracks(query);
        paint(local, local.length ? `найдено · ${local.length}` : "ничего не нашлось");
      }
    };

    input.addEventListener("input", () => {
      window.clearTimeout(timer);
      if (controller) controller.abort();
      token += 1;
      const query = input.value.trim();

      if (!query) {
        paint(feed.slice(0, 30), feed.length ? "тренды YouTube" : "начните вводить название");
        return;
      }

      const currentToken = token;
      timer = window.setTimeout(() => runSearch(query, currentToken), 280);
    });

    showDialog(`добавить в «${playlist.title}»`, [panel], () => {
      window.clearTimeout(timer);
      token += 1;
      if (controller) controller.abort();
    });

    window.setTimeout(() => input.focus({ preventScroll: true }), 40);
  }

  const openIcon =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9.8 6.6 5.4 5.4-5.4 5.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const removeIcon =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6.8 6.8 10.4 10.4M17.2 6.8 6.8 17.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  function createCreateCard() {
    const card = el("button", "playlist-create");
    card.type = "button";
    card.setAttribute("aria-label", "Создать плейлист");

    const mark = el("span", "playlist-create__mark");
    mark.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5.2v13.6M5.2 12h13.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

    card.append(mark, el("span", "playlist-create__label", "создать плейлист"));
    card.addEventListener("click", () => openCreateDialog());
    return card;
  }

  function createUserCard(playlist) {
    const card = el("button", "playlist");
    card.type = "button";
    card.setAttribute("aria-label", `Открыть плейлист «${playlist.title}»`);

    const wrap = el("span", "playlist__cover-wrap");

    if (playlist.tracks.length) {
      const cover = el("img", "playlist__cover");
      cover.src = playlist.tracks[0].cover || FALLBACK_COVER;
      cover.alt = `Плейлист «${playlist.title}»`;
      cover.loading = "lazy";
      guardCover(cover);
      wrap.appendChild(cover);
    } else {
      const empty = el("span", "playlist__empty");
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6.5h9.5M4 11.5h9.5M4 16.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16.5 7.2v8.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="18.7" cy="16.6" r="2.2" fill="currentColor"/><path d="M18.7 16.6V7.8l2.2-.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      wrap.appendChild(empty);
    }

    const overlay = el("span", "playlist__overlay");
    const open = el("span", "playlist__play");
    open.innerHTML = openIcon;
    overlay.appendChild(open);
    wrap.appendChild(overlay);

    card.append(
      wrap,
      el("span", "playlist__name", playlist.title),
      el(
        "span",
        "playlist__meta",
        `${playlist.tracks.length} ${tracksWord(playlist.tracks.length)} · мой плейлист`
      )
    );
    card.addEventListener("click", () => openPlaylist(playlist.id));
    return card;
  }

  function renderPlaylists() {
    dom.playlists.innerHTML = "";
    dom.playlists.appendChild(createCreateCard());
    userPlaylists.forEach((playlist) => dom.playlists.appendChild(createUserCard(playlist)));
  }

  let activePlaylistId = null;

  function getActivePlaylist() {
    return userPlaylists.find((playlist) => playlist.id === activePlaylistId) || null;
  }

  function openPlaylist(id) {
    const playlist = userPlaylists.find((item) => item.id === id);
    if (!playlist) return;
    activePlaylistId = id;
    setView("playlist");
    renderPlaylistDetail();
  }

  function renderPlaylistDetail() {
    const playlist = getActivePlaylist();
    if (!playlist) {
      setView("playlists");
      renderPlaylists();
      return;
    }

    const count = playlist.tracks.length;
    dom.playlistTitle.textContent = playlist.title;
    dom.playlistMeta.textContent = `${count} ${tracksWord(count)} · мой плейлист`;
    dom.playlistPlay.disabled = count === 0;
    dom.playlistTracks.innerHTML = "";

    if (!count) {
      const empty = el("div", "pl-empty");
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6.5h9.5M4 11.5h9.5M4 16.5h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M16.5 7.2v8.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="18.6" cy="16.6" r="2.1" fill="currentColor"/><path d="M18.6 16.6V7.8l2.2-.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      const text = el("div", "pl-empty__text");
      text.append(
        el("strong", "", "пока пусто"),
        el("p", "", "добавьте первый трек — поиск идёт по всему каталогу YouTube.")
      );

      const add = el("button", "ghost-pill", "Добавить трек");
      add.type = "button";
      add.addEventListener("click", () => openAddTracksDialog(playlist));

      empty.append(text, add);
      dom.playlistTracks.appendChild(empty);
      return;
    }

    playlist.tracks.forEach((track, index) => {
      const row = el("div", "pl-track");

      const main = el("button", "pl-track__main");
      main.type = "button";
      main.setAttribute("aria-label", `Включить ${track.title}`);

      const cover = el("img", "pl-track__cover");
      cover.src = track.cover || FALLBACK_COVER;
      cover.alt = "";
      cover.loading = "lazy";
      guardCover(cover);

      const text = el("span", "pl-track__text");
      text.append(
        el("span", "pl-track__name", track.title),
        el("span", "pl-track__artist", track.artist || library.source.name)
      );

      main.append(
        cover,
        text,
        el("span", "pl-track__dur", formatTime(track.duration))
      );
      main.addEventListener("click", () => playUserPlaylist(playlist, index));

      const remove = el("button", "pl-track__remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Убрать ${track.title} из плейлиста`);
      remove.innerHTML = removeIcon;
      remove.addEventListener("click", () => {
        if (!removeTrackFromPlaylist(playlist, track.id)) return;
        renderPlaylistDetail();
        renderPlaylists();
        toast("трек убран из плейлиста");
      });

      row.append(main, remove);
      dom.playlistTracks.appendChild(row);
    });
  }

  dom.playlistBack.addEventListener("click", () => {
    setView("playlists");
    renderPlaylists();
  });

  dom.playlistPlay.addEventListener("click", () => {
    const playlist = getActivePlaylist();
    if (playlist) playUserPlaylist(playlist);
  });

  dom.playlistAdd.addEventListener("click", () => {
    const playlist = getActivePlaylist();
    if (playlist) openAddTracksDialog(playlist);
  });

  dom.playlistBtn.addEventListener("click", openAddToPlaylist);

  /* =========================================================
     Navigation
     ========================================================= */

  function setView(view) {
    if (!dom.views[view]) return;
    state.view = view;
    const navView = view === "playlist" ? "playlists" : view;

    dom.navItems.forEach((item) => {
      item.classList.toggle("is-active", item.dataset.view === navView);
    });

    Object.entries(dom.views).forEach(([name, node]) => {
      node.hidden = name !== view;
    });

    dom.stage.classList.toggle("is-browsing", view !== "stream");
    if (view !== "stream") {
      dom.stage.classList.remove("is-idle");
    } else {
      dom.stage.classList.toggle("is-idle", state.closed);
    }

    if (view === "search") {
      renderResults(dom.searchInput.value);
      if (window.matchMedia("(min-width: 821px)").matches) {
        window.setTimeout(() => dom.searchInput.focus({ preventScroll: true }), 60);
      }
    } else {
      cancelSearch();
    }

    closeMenus();
  }

  dom.navItems.forEach((item) => {
    item.addEventListener("click", () => setView(item.dataset.view));
  });

  $(".brand").addEventListener("click", (event) => {
    event.preventDefault();
    setView("stream");
  });

  /* =========================================================
     Keyboard
     ========================================================= */

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof Element && target.closest("input, textarea, [contenteditable]");

    if (typing) return;

    if (event.key === "Escape") {
      closeMenus();
      return;
    }

    if (target instanceof Element && target.closest('button, a, [role="slider"], iframe')) {
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
      togglePlay();
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      seekToRatio((getCurrentTime() + 5) / getDuration());
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekToRatio((getCurrentTime() - 5) / getDuration());
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.volume = Math.min(1, state.volume + 0.05);
      state.muted = false;
      applyVolume(true);
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.volume = Math.max(0, state.volume - 0.05);
      applyVolume(true);
    }

    if (event.key === "/") {
      event.preventDefault();
      setView("search");
    }
  });

  /* =========================================================
     Media Session
     ========================================================= */

  let mediaSessionReady = false;

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", () => playAudio());
      navigator.mediaSession.setActionHandler("pause", () => pauseAudio());
      navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
      navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
      navigator.mediaSession.setActionHandler("seekbackward", () =>
        seekToRatio((getCurrentTime() - 5) / getDuration())
      );
      navigator.mediaSession.setActionHandler("seekforward", () =>
        seekToRatio((getCurrentTime() + 5) / getDuration())
      );
      mediaSessionReady = true;
    } catch (_) {
      mediaSessionReady = false;
    }
  }

  function updateMediaSession(track) {
    if (!mediaSessionReady || typeof MediaMetadata === "undefined") return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album || library.source.name,
        artwork: [
          {
            src: new URL(track.cover || FALLBACK_COVER, window.location.href).href,
            sizes: "480x480",
            type: "image/jpeg",
          },
        ],
      });
    } catch (_) {
      /* ignore */
    }
  }

  /* =========================================================
     Motion preference
     ========================================================= */

  function syncMotionUI() {
    const reduced = dom.body.classList.contains("reduce-motion");
    dom.settingsItemMotion?.classList.toggle("is-on", reduced);
    dom.motionCheck?.setAttribute("aria-hidden", reduced ? "false" : "true");
  }

  try {
    if (localStorage.getItem(STORE.motion) === "1") {
      dom.body.classList.add("reduce-motion");
    }
  } catch (_) {
    /* ignore */
  }
  syncMotionUI();

  /* =========================================================
     Initial paint
     ========================================================= */

  let feedRequested = false;

  function adoptFeed(list) {
    feed = dedupe(list);
    feedError = false;

    if (!state.current && feed.length) {
      state.queue = feed;
      state.index = 0;
      loadTrack(feed[0], { autoplay: false });
    }

    if (!dom.searchInput.value.trim()) {
      renderResults();
    }
  }

  function loadCachedFeed() {
    const cached = readFeedCache();
    if (!cached.tracks.length) return;
    adoptFeed(cached.tracks);
  }

  async function loadFeed() {
    if (feedRequested) return;
    feedRequested = true;

    try {
      const list = await fetchFeed();
      if (!list.length) throw new Error("empty feed");

      writeFeedCache(list);
      adoptFeed(list);
    } catch (_) {
      feedError = feed.length === 0;
      if (state.view === "search" && !dom.searchInput.value.trim()) {
        renderResults();
      }
      if (!state.current) {
        dom.trackTitle.textContent = "нет соединения";
        toast("не удалось загрузить тренды · проверьте соединение");
      }
    }
  }

  function init() {
    renderPlaylists();
    applyVolume();
    setupMediaSession();
    loadCachedFeed();
    syncPlayState();
    setView("stream");
    renderResults();

    if (FILE_MODE) {
      dom.artNotice.hidden = false;
    } else {
      loadYouTubeApi();
    }

    loadFeed();
  }

  init();
})();
