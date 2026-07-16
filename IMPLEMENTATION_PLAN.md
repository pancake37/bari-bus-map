# План реализации: hardening и исправления bari-bus-map

Документ опирается на внешний анализ репозитория, верификацию против актуального кода и текущее состояние (`server.js`, `index.html`). Цель — довести пет-проект до надёжного локального/публичного сервиса **без** раздувания стека: zero-dependency Node, один HTML-клиент.

**Не цель этого плана:** полный rewrite, фреймворки, БД, auth-система уровня SaaS, ML-переобучение офлайн.

**Статус (2026-07-16):** верификация агента подтвердила все ключевые диагнозы (PR1–PR8) как реальные воспроизводимые баги. OTP-метрика **уже реализована** в коде (см. §0) — не путать с «не сделано».

---

## 0. Уже есть в коде (не реализовывать заново)

| Фича | Где | Заметки |
|------|-----|---------|
| **OTP (on-time performance)** | `computeOTP()`, константы `OTP_EARLY_S = -60`, `OTP_LATE_S = 300`, вызов из `pollRealtime` → `otpCache`, эндпоинт **`/api/otp`** | Окно −1…+5 мин совпадает с определением из amtab-elt. **Рабочее, не заглушка.** README (PR9) должен описать API, а не писать «OTP не реализован». |
| Graceful RT backup | `lastVehiclesBackup` / `lastDelaysBackup`, TTL 5 min | Оставить; дополняется таймаутами (PR2) |
| Calendar parse order | calendar до фильтра stop times | Отдельный от PR1 (PR1 = накопительная мутация `routeShapes`) |

---

## 1. Цели и критерии успеха

| Цель | Критерий «готово» |
|------|-------------------|
| Календарь сервисов не деградирует со днями | После двух (и более) вызовов `recomputeActiveServices()` набор shapes совпадает с пересборкой «с нуля» для текущей даты |
| Confidence не даёт ложных `low` | Сравнение в пространстве **trip `stop_sequence`** (как в GTFS-RT `CurrentStopSequence`); при отсутствии данных — `unknown`, не `low` |
| CSV GTFS с кавычками/запятыми парсится корректно | Quoted fields; smoke-тест на строке с `,` внутри кавычек |
| RT-фиды не «вешают» пайплайн | Timeout на HTTPS; `computeETAs` / `computeOTP` продолжают вызываться |
| Публичная отдача только безопасных ассетов | `.gtfs-cache.json`, `google_transit.zip`, `data/*`, `.git/*`, `server.js` недоступны по HTTP |
| Модель скоростей учитывает свежесть | EMA + явные константы |
| Кроссплатформенный GTFS extract | Linux/macOS/Windows без обязательного PowerShell |
| CDN/supply-chain | Pin + SRI (или vendor) |
| Операционная гигиена | Midnight один раз в сутки; без debug `console.log` в UI; LICENSE; тесты; README отражает OTP + исправления |

---

## 2. Приоритеты (P0 → P2)

```
P0  Корректность данных + живучесть + confidence (user-facing ETA quality)
P1  Безопасность публичной раздачи + EMA
P2  Портативность, CDN, тесты, лицензия, polish
```

**Порядок выполнения (обновлено после верификации):**

| PR | Тема | Приоритет | Заметка |
|----|------|-----------|---------|
| **PR1** | Фикс календаря (`recomputeActiveServices`) + guard midnight | **P0** | Накопительное сужение `routeShapes` |
| **PR4** | Confidence: trip `stop_sequence`, не shape index | **P0** | Наравне с PR1: AMTAB `stop_sequence` с 1; shape index 0-based → массовые ложные `low` |
| **PR2** | Timeout + abort для `fetchJSON` / poll | **P0** | |
| **PR3** | RFC4180 CSV-парсер | **P0** | |
| **PR5** | Static file allowlist | **P1** | |
| **PR6** | EMA для `histSpeed` | **P1** | |
| **PR7** | Cross-platform unzip | **P2** | |
| **PR8** | CDN pin + SRI; убрать debug log | **P2** | Leaflet@1.9.4 ок; MovingMarker `@master` — нет |
| **PR9** | LICENSE, tests, README (**включая `/api/otp` и computeOTP**) | **P2** | Не писать «OTP не сделан» |

Рекомендуемый batch для старта реализации: **PR1 + PR4 + PR2 + PR3 + PR5 + PR6** в одном проходе по `server.js` (логические блоки независимы), затем PR7–PR9.

---

## 3. Детальный план по задачам

### PR1 — Деструктивный пересчёт календаря (баг #1)

**Проблема.**  
`recomputeActiveServices()` фильтрует `gtfsData.routeShapes` in-place. На следующий день (и при повторном midnight-тике) набор только сужается; «неактивные сегодня, но нужные завтра» shapes не возвращаются, пока не сработает полный `extractAll()` / cache re-extract.

**Корневая причина в коде.**  
При extract уже строится «сегодняшний» `routeShapes` (filter по `activeSids`). Полночный recompute снова фильтрует *уже* урезанный массив. Нет full snapshot «все shapes по route».

**План реализации.**

1. При `extractAll()` (и при load cache, если нужна миграция схемы) сохранять **полный** индекс:
   - `gtfsData.routeShapesAll` — все shape_id по route_id из trips (без фильтра сервиса), **или**
   - `gtfsData.allRouteShapes` + пересобирать `routeShapes` только из него.
2. Аналогично решить судьбу `stopInfo` / filtered stop times:
   - либо хранить полный `stopTimes` и пересобирать `stopInfo` на смене суток;
   - либо при midnight вызывать узкую `rebuildServiceDependentViews(activeSids)`, а не filter-in-place.
3. Переписать `recomputeActiveServices()`:
   ```
   activeSids = getActiveServiceIds(today)
   routeShapes = filter(routeShapesAll, trip ∈ activeSids)
   stopInfo   = rebuild from full stopTimes (если есть)
   ```
4. Midnight guard: флаг `lastServiceDate = 'YYYYMMDD'`; recompute только при смене календарного дня, не каждую секунду `00:00`.
5. После recompute **не** обязательно переписывать весь `.gtfs-cache.json` каждый день (shapes/graphs тяжёлые) — кэшировать full data; service-dependent views — в памяти.

**Файлы:** `server.js` (`extractAll`, `recomputeActiveServices`, `initRealtime` interval).  
**Проверка:** unit-like скрипт или ручной вызов `recomputeActiveServices()` дважды с подменой даты → размеры `routeShapes` не монотонно падают; на «понедельник → воскресенье» shapes выходных появляются.

---

### PR2 — Таймауты HTTPS к AMTAB (баг #4)

**Проблема.**  
`fetchJSON` через `https.get` без timeout. Если сокет завис, `done()` в `pollRealtime` не вызовется → ETA/OTP/flush «замрут».

**План.**

1. Обернуть `fetchJSON(url, cb, opts)`:
   - `req.setTimeout(TIMEOUT_MS)` (например 8000–12000 ms);
   - на timeout: `req.destroy()`, `cb(new Error('timeout'))`;
   - guard от двойного callback (`let settled = false`).
2. Опционально: общий budget на оба фида (vehicles + trip-updates) ≤ poll interval (10 s).
3. При timeout/error — уже существующий backup TTL (5 min) остаётся; логировать раз в N минут, не каждый poll (anti-spam).
4. Не менять семантику `pending/done` — оба колбэка всегда должны вызывать `done()`.

**Файлы:** `server.js` (`fetchJSON`, `pollRealtime`).  
**Проверка:** mock/broken URL или firewall drop → через ≤ timeout `computeETAs` всё ещё крутится (логи/`/api/stats` обновляются).

---

### PR3 — CSV-парсер GTFS (баг #3)

**Проблема.**  
`lines[i].split(',')` ломает quoted fields (`"Via Roma, 12"` → лишние колонки).

**План.**

1. Вынести `parseCSVLine(line)` / `parseCSV(text)`:
   - RFC 4180: кавычки, `""` escape, CRLF;
   - trim header names; сохранить пустые поля.
2. Заменить локальный `parseCSV` внутри `extractAll` на общий helper.
3. Не тянуть `csv-parse` npm — zero-dependency, ~30–40 строк достаточно для GTFS.
4. Smoke: парсинг синтетической строки + (желательно) сверка count stops до/после на реальном zip.

**Файлы:** `server.js` (helper + `extractAll`).  
**Проверка:** unit-тест на 5–10 edge-case строк; после re-extract число stops/routes не «ломается», names с запятой целые.

---

### PR4 — Confidence-check (баг #2)

**Проблема.**  
Сравниваются `nextStopIdx` (индекс в **shape stop sequence**) и `CurrentStopSequence` (нумерация **trip** / GTFS-RT). Это разные пространства → ложные `low`.

**План (предпочтительный).**

1. При extract построить per-trip (или per shape+trip) карту:
   - `stop_sequence` из `stop_times.txt` → `stop_id` / ordered list.
2. Геометрический `nextStopId` сопоставить с **trip** sequence index:
   - `rtSeq = v.currentStopSequence`
   - `geoSeq = tripStopSequence[v.tid][nextStopId]` (или индекс в ordered list trip)
3. Confidence:
   - нет `currentStopSequence` или нет trip map → `confidence = 'unknown'` (или не выставлять `low`);
   - `|geoSeq - rtSeq| > THRESHOLD` → `low`, иначе `high`.
4. Фронт: уже показывает live/≈estimate — добавить третий стиль для `unknown` при необходимости (минимально: трактовать unknown как high для UI, но API честный).

**Альтернатива (если trip maps тяжёлые по памяти):**  
временно **не** сравнивать индексы; confidence = `high` только при совпадении `v.stopId === nextStopId` / `IN_TRANSIT_TO`, иначе `unknown`. Меньше false low, слабее сигнал.

**Файлы:** `server.js` (`extractAll` / `buildStopSequences`, `computeETAs`); точечно `index.html` если UI.  
**Проверка:** логировать долю low до/после на live фиде 10–15 мин; low должен стать редким, а не «половина парка».

---

### PR5 — Hardening статики (баг #5)

**Проблема.**  
Любой файл под root (кроме `..`) отдаётся: cache, zip, JSONL с GPS.

**План.**

1. Allowlist для static:
   - `/` → `index.html`
   - `/assets/*` (например только `.png`, `.svg`, `.css`, `.js` если vendor)
   - опционально `/favicon.ico`
2. Явный deny: `.gtfs-cache.json`, `google_transit.zip`, `data/`, `.git/`, `node_modules/`, `*.jsonl`, `server.js`, `.env*`.
3. Нормализация path: `path.normalize` + reject `..` и absolute (уже есть) + reject symlink escape при желании.
4. API остаётся без изменений.

**Файлы:** `server.js` (static branch в конце handler).  
**Проверка:** curl `/google_transit.zip`, `/.gtfs-cache.json`, `/data/hist-speed.json` → 403/404; `/` и `/assets/demo.png` → 200.

---

### PR6 — EMA / свежесть модели (баг #6)

**Проблема.**  
`avg = sum/count` без decay; пол 16 км/ч и default 22 захардкожены.

**План.**

1. Константы вверху файла:
   ```js
   const DEFAULT_SPEED = 22;
   const MIN_SPEED_FLOOR = 16;
   const SPEED_EMA_ALPHA = 0.05; // или 0.1
   const MIN_OBS_SPEED = 10;
   ```
2. `updateVai`:
   - `h.avg = alpha * sample + (1 - alpha) * h.avg`
   - хранить `count`, `updatedAt`; `sum` можно deprecate (миграция: если есть `sum/count` — seed `avg`, дальше EMA).
3. Опционально: half-life / не обновлять при weekend mismatch (если позже появятся day-type keys) — **не** в первом проходе.
4. `saveHistSpeed` по-прежнему периодический; схема файла совместима (`avg` + `count`).

**Файлы:** `server.js` (`getVai`, `updateVai`, `loadHistSpeed`).  
**Проверка:** искусственно загнать avg=5 и 10 сэмплов 40 км/ч → avg растёт быстрее, чем при global mean; README: обновить формулу модели.

---

### PR7 — Cross-platform unzip (known limitation)

**Проблема.**  
`execSync(PowerShell Expand-Archive …)` — Linux/macOS extract падает.

**План (zero-dep).**

1. Минимальный ZIP reader для **stored + deflate** (GTFS почти всегда deflate):
   - local file headers, inflate через `zlib.inflateRawSync` / `createInflateRaw`;
   - извлекать только нужные `*.txt` в tmp dir.
2. Fallback order:
   - native JS unzip;
   - (optional) `unzip` CLI если есть;
   - PowerShell на Windows как last resort.
3. Не добавлять `adm-zip`/`yauzl`, если цель — zero runtime deps; если JS-unzip раздувает код >~150 строк — допустим один dev-only путь, но предпочтительно self-contained.

**Файлы:** `server.js` (`extractAll`); возможно `lib/unzip-gtfs.js` если разумно вынести.  
**Проверка:** extract на Windows + (если есть) WSL/Linux; cache rebuild.

---

### PR8 — CDN, SRI, debug log

**Проблема.**  
Leaflet с unpkg без SRI; MovingMarker с `@master` jsDelivr — supply-chain; `console.log("[AMTAB debug]…")` в `index.html`.

**План.**

1. Pin MovingMarker на конкретный commit/tag, не `master`.
2. Добавить `integrity` + `crossorigin` для CSS/JS Leaflet (хеши с unpkg/jsDelivr).
3. Либо vendor: `assets/vendor/leaflet.*` + `MovingMarker.js` — надёжнее offline.
4. Удалить debug `console.log` (или обернуть в `?debug=1`).

**Файлы:** `index.html`, опционально `assets/vendor/*`.  
**Проверка:** DevTools Network — скрипты грузятся; CSP не ломается (если позже добавят).

---

### PR9 — Операционка: LICENSE, тесты, README

1. **LICENSE** — MIT или Apache-2.0 (на выбор автора); без лицензии «all rights reserved».
2. **Тесты (минимум, zero или один runner):**
   - `node --test` (Node 18+) для: CSV lines, polyline encode/decode roundtrip, haversine sanity, filter calendar pure functions.
   - Вынести pure helpers из замыканий, если нужно тестировать без HTTP.
3. **`uncaughtException`:** логировать и **exit(1)** в production mode (`NODE_ENV=production`), в dev — текущее поведение; не глотать молча навсегда.
4. **README:** Known Limitations — вычеркнуть исправленное; добавить раздел Security (static allowlist), Timeouts, EMA.
5. **`.gitignore`:** убедиться, что `data/observations-*.jsonl` и cache не утекают в git (если не нужны в репо).

---

## 4. Карта изменений по файлам

| Файл | Изменения |
|------|-----------|
| `server.js` | calendar rebuild, CSV, timeouts, confidence, static allowlist, EMA, unzip, midnight flag, error handlers |
| `index.html` | CDN/SRI, remove debug log, UI confidence `unknown` (если нужно) |
| `data/hist-speed.json` | автомиграция при load (не ручной edit) |
| `README.md` | модель, security, limitations |
| `LICENSE` | новый |
| `test/*.test.js` или `*.test.js` | CSV, calendar filter, confidence helpers |
| `IMPLEMENTATION_PLAN.md` | этот документ (можно удалить после выполнения) |

Новые runtime-зависимости: **не планируются**.

---

## 5. Риски и митигация

| Риск | Митигация |
|------|-----------|
| Смена схемы cache (routeShapesAll) | Bump cache version field; при mismatch — re-extract |
| EMA «забывает» ночные скорости | alpha умеренный (0.05); floor 16; default 22 |
| Trip sequence maps раздувают память | строить только для active trips / lazy per tripId |
| JS unzip не покрывает zip64/encryption | GTFS AMTAB — обычный zip; fallback CLI |
| Allowlist сломает assets | явный whitelist + тест curl demo.png |
| Двойной callback после timeout | `settled` flag в `fetchJSON` |

---

## 6. План проверки (общий DoD)

После каждого PR:

1. `node server.js` стартует, лог: routes/stops/shapes loaded.
2. `http://localhost:3000` — карта, маркеры, ETA на остановке.
3. `/api/vehicles`, `/api/etas`, `/api/stats` — 200, JSON валиден.
4. Негативные: timeout simulation, static deny, double midnight recompute.
5. ESLint CI green (`.github/workflows/eslint.yml`).

Регрессионный чеклист перед «публичным» деплоем:

- [ ] PR1 calendar OK  
- [ ] PR2 timeouts OK  
- [ ] PR3 CSV OK  
- [ ] PR4 confidence OK  
- [ ] PR5 static OK  
- [ ] PR6 EMA OK  
- [ ] PR7 unzip OK (хотя бы Windows + один *nix)  
- [ ] PR8 CDN OK  
- [ ] PR9 LICENSE + tests + README  

---

## 7. Что сознательно не делаем в этой итерации

- Rate limiting / API keys / OAuth  
- Redis / Postgres / multi-instance state  
- TypeScript / bundler / SPA framework  
- **OTP dashboard UI** (бэкенд `computeOTP` + `/api/otp` **уже есть**; UI-дашборд — отдельно, не «реализовать OTP с нуля»)  
- Мобильное нативное приложение  
- Исправление опечатки в upstream URL `VechiclePosition` (API AMTAB — только документировать)

---

## 8. Оценка трудозатрат (ориентир)

| PR | Сложность | Ориентир |
|----|-----------|----------|
| PR1 calendar | medium | 1–2 ч |
| PR4 confidence | medium | 1.5–3 ч |
| PR2 timeouts | low | 30–45 мин |
| PR3 CSV | low–medium | 1 ч |
| PR5 static | low | 30–45 мин |
| PR6 EMA | low | 30–45 мин |
| PR7 unzip | medium–high | 2–4 ч |
| PR8 CDN | low | 30 мин |
| PR9 meta/tests | medium | 1–2 ч |

**MVP hardening (P0 + P1):** PR1, PR4, PR2, PR3, PR5, PR6 ≈ полдня.  
**«Портфолио-продакшен»:** + PR7–PR9 ≈ 1–2 дня.

---

## 9. Порядок старта (актуальный)

1. **PR1 + PR4** — calendar + confidence (максимальный user-facing ROI).  
2. **PR2 + PR3 + PR5** — живучесть, CSV, security.  
3. **PR6** — EMA.  
4. **PR7–PR9** — unzip, CDN, LICENSE/tests/README (**описать существующий OTP**).

---

## 10. Журнал реализации

| Дата | Что |
|------|-----|
| 2026-07-16 | План обновлён: OTP уже в коде; PR4 → P0 наравне с PR1; старт batch PR1/2/3/4/5/6 |
| 2026-07-16 | **Сделано в `server.js` + `index.html`:** PR1 (calendar rebuild + day guard), PR4 (tripStopSeq confidence), PR2 (HTTPS timeout 10s), PR3 (RFC4180 CSV), PR5 (static allowlist), PR6 (EMA). Удалён debug `console.log` во фронте. Live smoke: 403 на zip/cache/data/server.js; confidence high=753 low=99 unknown=0 на 852 ETA. |
| 2026-07-16 | **PR7–PR9:** `lib/zip.js` pure-JS unzip + CLI/PS fallbacks; Leaflet/MovingMarker vendored в `assets/vendor/` (pin commit MovingMarker); MIT `LICENSE`; `package.json` + `test/*.test.js`; README с API/OTP/security/calendar; production exit on uncaught |
