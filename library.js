window.KOKKY = {
  source: {
    name: "SoundCloud",
    url: "https://soundcloud.com",
    about: "полные треки · без аккаунта",
  },
  // SoundCloud не отдаёт CORS для поиска, поэтому запросы идут через
  // маленький прокси. По умолчанию — публичный r.jina.ai (без ключа).
  // Если развернёте свой воркер (см. worker/README.md) — укажите его адрес:
  // proxy: "https://kokky-sc.example.workers.dev/?url="
  soundcloud: {
    clientId: "qLcgHhXgeEFFaSolTB9I71LBsqncsD93",
    proxy: "",
  },
  // Запросы, из которых собирается «Мой поток».
  feedQueries: [
    "pop hits",
    "hip hop",
    "r&b",
    "electronic",
    "indie",
    "chill",
  ],
};
