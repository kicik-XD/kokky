window.KOKKY = {
  source: {
    name: "YouTube",
    url: "https://www.youtube.com",
    about: "полные треки · без аккаунта",
  },
  // Необязательный ключ YouTube Data API v3. Если указать — поиск пойдёт через
  // официальный API Google, а не через публичные Piped-инстансы.
  youtube: {
    apiKey: "",
  },
  // Публичные Piped-инстансы для поиска. Используется первый доступный.
  piped: [
    "https://api.piped.private.coffee",
    "https://pipedapi.ducks.party",
  ],
  // Запросы, из которых собирается «Мой поток».
  feedQueries: [
    "pop music",
    "hip hop music",
    "rock music",
    "r&b music",
    "indie music",
  ],
};
