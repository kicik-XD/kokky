(() => {
  "use strict";

  const library = window.KOKKY;
  if (!library) return;

  const API = "https://api.audius.co";
  const APP_NAME = "KOKKY";
  const STREAM = `${API}/v1/tracks`;
  const STORE = {
    liked: "kokky:liked",
    volume: "kokky:volume",
    motion: "kokky:motion",
    playlists: "kokky:playlists",
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

  const cleanArtist = (track) =>
    String(track.user?.name || track.user?.handle || "Audius")
      .replace(/^@+/, "")
      .replace(/\s+/g, " ")
      .trim();

  const fromAudius = (track) => ({
    id: track.id,
    title: String(track.title || "без названия").trim(),
    artist: cleanArtist(track),
    duration: Math.round(Number(track.duration) || 0),
    cover: track.artwork?.["480x480"] || track.artwork?.["150x150"] || FALLBACK_COVER,
    permalink: track.permalink ? `https://audius.co${track.permalink}` : library.source.url,
    genre: track.genre || "",
    album: null,
  });

  const isPlayable = (track) =>
    !!track &&
    !track.is_delete &&
    track.is_streamable !== false &&
    !track.is_stream_gated &&
    Number(track.duration) > 30 &&
    Number(track.duration) <= 1200;

  const streamUrl = (track) =>
    `${STREAM}/${encodeURIComponent(track.id)}/stream?app_name=${APP_NAME}`;

  async function requestAudius(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    return Array.isArray(json.data) ? json.data : [];
  }

  async function fetchTrendingTracks() {
    const base = `${API}/v1/tracks/trending?app_name=${APP_NAME}&limit=40`;
    let raw = [];
    try {
      raw = await requestAudius(`${base}&time=week`);
    } catch (_) {
      /* retry without the time filter below */
    }
    if (!raw.length) raw = await requestAudius(base);
    return raw.filter(isPlayable).map(fromAudius);
  }

  async function fetchAudiusTracks(query, limit = 24, signal) {
    const url = `${API}/v1/tracks/search?query=${encodeURIComponent(
      query
    )}&limit=${limit}&app_name=${APP_NAME}`;
    const raw = await requestAudius(url, signal);
    return raw.filter(isPlayable).map(fromAudius);
  }

  const state = {
    view: "stream",
    queue: [],
    index: 0,
    current: null,
    liked: new Set(),
    volume: 0.8,
    muted: false,
    closed: false,
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
    audio: $("#audio"),
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

  const audio = dom.audio;
  audio.volume = state.volume;

  let rafId = null;
  let lastProgress = -1;
  let lastSecond = -1;
  let toastTimer = null;
  let scrubbing = false;
  let loadId = 0;

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

  const getDuration = () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    return state.current?.duration || 30;
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
      toast("kokky · полные треки с Audius · без аккаунта");
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
    const duration = state.current?.duration || 30;
    lastProgress = -1;
    lastSecond = -1;
    dom.seekFill.style.width = "0%";
    dom.seekTime.textContent = `0:00 / ${formatTime(duration)}`;
    dom.seek.setAttribute("aria-valuenow", "0");
    dom.seek.setAttribute("aria-valuemax", String(Math.round(duration)));
  }

  function updateProgress() {
    const duration = getDuration();
    const current = Math.min(audio.currentTime || 0, duration);
    const percent = duration > 0 ? (current / duration) * 100 : 0;
    const second = Math.floor(current);

    if (Math.abs(percent - lastProgress) > 0.03) {
      dom.seekFill.style.width = `${percent.toFixed(2)}%`;
      lastProgress = percent;
    }

    if (second !== lastSecond) {
      dom.seekTime.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
      dom.seek.setAttribute("aria-valuenow", String(second));
      dom.seek.setAttribute("aria-valuemax", String(Math.round(duration)));
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
    const playing = !audio.paused && !audio.ended;
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
    audio.volume = state.volume;
    audio.muted = state.muted || state.volume === 0;

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

  audio.volume = state.volume;

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
     Audio loading & transport
     ========================================================= */

  function loadTrack(track, { autoplay = false } = {}) {
    if (!track) return;
    state.current = track;
    const id = ++loadId;

    audio.pause();
    audio.removeAttribute("src");
    audio.load();

    audio.src = streamUrl(track);
    audio.load();
    try {
      audio.currentTime = 0;
    } catch (_) {
      /* metadata is not ready yet */
    }

    updateTrackUI(track);

    if (autoplay && id === loadId) {
      playAudio({ silent: true });
    }
  }

  async function playAudio({ silent = false } = {}) {
    if (!state.current) return;
    try {
      if (!audio.currentSrc) {
        audio.src = streamUrl(state.current);
        audio.load();
      }
      await audio.play();
    } catch (error) {
      if (!silent && error && error.name !== "AbortError") {
        toast("не удалось включить трек · проверьте соединение");
      }
    }
  }

  async function togglePlay() {
    if (!state.current) return;
    if (audio.paused) {
      if (!audio.currentSrc) loadTrack(state.current, { autoplay: true });
      else playAudio();
    } else {
      audio.pause();
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
    audio.pause();
    setView("stream");
    dom.playerView.classList.add("is-closed");
    dom.stage.classList.add("is-idle");
    closeMenus();
  }

  function step(direction) {
    if (!state.queue.length) return;
    const wasPlaying = !audio.paused;
    state.index = (state.index + direction + state.queue.length) % state.queue.length;
    loadTrack(state.queue[state.index], { autoplay: wasPlaying });
  }

  function playTrack(track, queue = feed) {
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
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
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

  function seekToRatio(ratio) {
    const duration = getDuration();
    if (!Number.isFinite(duration) || duration <= 0) return;
    const clamped = Math.min(1, Math.max(0, ratio));
    try {
      audio.currentTime = clamped * duration;
    } catch (_) {
      /* ignore */
    }
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
      seekToRatio((audio.currentTime + 5) / getDuration());
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      seekToRatio((audio.currentTime - 5) / getDuration());
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
     Audio events
     ========================================================= */

  audio.addEventListener("play", () => {
    syncPlayState();
    startTicker();
  });

  audio.addEventListener("pause", () => {
    syncPlayState();
    stopTicker();
  });

  audio.addEventListener("loadedmetadata", updateProgress);
  audio.addEventListener("durationchange", updateProgress);
  audio.addEventListener("seeked", updateProgress);

  audio.addEventListener("ended", () => {
    if (state.queue.length > 1) {
      state.index = (state.index + 1) % state.queue.length;
      loadTrack(state.queue[state.index], { autoplay: true });
    } else {
      audio.currentTime = 0;
      syncPlayState();
      updateProgress();
    }
  });

  audio.addEventListener("error", () => {
    if (!state.current) return;
    toast("трек недоступен · включите другой");
    syncPlayState();
  });

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

  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((track) => {
      if (seen.has(track.id)) return false;
      seen.add(track.id);
      return true;
    });
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
      el("span", "result__meta", `${track.artist} · ${track.album || track.genre || library.source.name}`)
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
        const remote = await fetchAudiusTracks(query, 30, controller.signal);
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
        paintResults(feed, `тренды Audius · ${feed.length}`);
      } else {
        paintNotice(
          feedError ? "не удалось загрузить тренды · попробуйте поиск" : "загружаем тренды Audius…"
        );
      }
      return;
    }

    const local = filterTracks(normalized);
    paintResults(local, local.length ? `найдено · ${local.length}` : "ищем в Audius…");
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
    input.placeholder = "найти трек в Audius";
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

    paint(feed.slice(0, 30), feed.length ? "тренды Audius" : "начните вводить название");

    let timer = 0;
    let controller = null;
    let token = 0;

    const runSearch = async (query, currentToken) => {
      controller = new AbortController();
      try {
        const remote = await fetchAudiusTracks(query, 24, controller.signal);
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
        paint(feed.slice(0, 30), feed.length ? "тренды Audius" : "начните вводить название");
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
        el("p", "", "добавьте первый трек — поиск идёт по всему каталогу Audius.")
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

    if (target instanceof Element && target.closest('button, a, [role="slider"]')) {
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
      togglePlay();
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      seekToRatio((audio.currentTime + 5) / getDuration());
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekToRatio((audio.currentTime - 5) / getDuration());
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
      navigator.mediaSession.setActionHandler("pause", () => audio.pause());
      navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
      navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
      navigator.mediaSession.setActionHandler("seekbackward", () =>
        seekToRatio((audio.currentTime - 5) / getDuration())
      );
      navigator.mediaSession.setActionHandler("seekforward", () =>
        seekToRatio((audio.currentTime + 5) / getDuration())
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

  async function loadFeed() {
    if (feedRequested) return;
    feedRequested = true;

    try {
      const list = dedupe(await fetchTrendingTracks());
      if (!list.length) throw new Error("empty feed");

      feed = list;
      feedError = false;

      if (!state.current) {
        state.queue = list;
        state.index = 0;
        loadTrack(list[0], { autoplay: false });
      }

      if (state.view === "search" && !dom.searchInput.value.trim()) {
        renderResults();
      }
    } catch (_) {
      feedError = true;
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
    syncPlayState();
    setView("stream");
    renderResults();
    loadFeed();
  }

  init();
})();
