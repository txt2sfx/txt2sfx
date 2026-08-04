# txt2sfx v0 — план работ (handoff-документ)

Дата создания: 2026-08-04. Статус: **Фаза 1 завершена**, фазы 2–7 впереди.
Документ самодостаточен: его достаточно, чтобы продолжить работу на другой машине
без исходного диалога.

---

## 0. Что это за проект

Опенсорс-инструмент: текстовое описание звукового эффекта → **компактный процедурный
код Web Audio API** (300–1000 байт, zero-dependency), а не аудиофайл. Философия
скопирована с img2threejs — *reconstruction-by-code*.

Четыре принципа, обязательные для всех архитектурных решений:

1. **Scripts enforce, the model judges.** Парсинг, валидация, рендер, метрики, скоринг —
   детерминированный код без LLM. LLM участвует только в проектировании структуры звука
   и оценке перцептивного сходства.
2. **Spec-first, fail fast.** Кодогенерация не стартует, пока спека не прошла валидатор
   физических инвариантов. Никогда не чинить сгенерированный JS — чинится soundline,
   JS перегенерируется.
3. **Разделение структуры и чисел.** LLM проектирует топологию (слои, примитивы, роли);
   точные числа подбирает численный оптимизатор против целевого акустического профиля.
4. **Выход — читаемый текст.** Единица обмена — формат `soundline`, диффабельный.

Никаких облачных text-to-audio моделей (Stable Audio, ElevenLabs) в ядре. CLAP-судья —
опциональный плагин, в v0 достаточно интерфейса-заглушки.

### Требование заказчика по ключам и локальности

- Тестирование идёт через **Gemini по API-ключу, который вставляется прямо в плейграунде**,
  и через **Opus 5 из CLI / по API / через MCP**.
- Внешний агент пользователя должен воспользоваться библиотекой и накопленной базой
  рецептов **максимально быстро и без установки**.
- LLM всегда пользовательская; если привлекается локальная модель генерации звука —
  она тоже исполняется на машине пользователя. Ничего не проксируется через наш сервис.

---

## 1. Как поднять окружение на новой машине

```powershell
# требуется Node >= 20 (проверено на v24.15.0)
cd <repo>
corepack pnpm install      # см. примечание про pnpm ниже
corepack pnpm vitest run   # 90 тестов должны быть зелёными
corepack pnpm build        # tsc -b packages/shared packages/core
```

Примечания:

- **pnpm глобально не установлен**, а `corepack enable pnpm` падает с `EPERM` на
  `C:\Program Files\nodejs`. Рабочий обход — вызывать `corepack pnpm <cmd>`.
  Чтобы получить обычный `pnpm`, нужен `corepack enable pnpm` из терминала
  с правами администратора.
- В `package.json` уже прописан `pnpm.onlyBuiltDependencies: ["esbuild"]`;
  предупреждение «Ignored build scripts: esbuild» безвредно, vitest работает.
- **Репозиторий ещё не под git** (`git init` не выполнялся). Первый шаг на новой машине
  или перед переносом: `git init`, коммит, пуш. `.gitignore` и `.gitattributes` готовы;
  `.gitattributes` форсит `eol=lf` — без него round-trip тесты на Windows падают.

---

## 2. Текущее состояние: Фаза 1 (готово)

Реализованы: shared + core/grammar (lexer → parser → serializer) + 10 examples + тесты.

```
txt2sfx/
├── package.json               # workspaces, скрипты build/test, pnpm.onlyBuiltDependencies
├── pnpm-workspace.yaml
├── tsconfig.base.json         # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── vitest.config.ts           # алиасы @txt2sfx/* → src, тесты идут без сборки
├── .gitignore, .gitattributes
├── examples/*.soundline       # 10 файлов, все в канонической форме
└── packages/
    ├── shared/src/{types.ts,constants.ts,index.ts}
    └── core/
        ├── src/grammar/{signatures.ts,units.ts,errors.ts,lexer.ts,parser.ts,serializer.ts}
        ├── src/index.ts
        └── test/{roundtrip,lexer,parse-errors,suggestions}.test.ts
```

**Критерии фазы выполнены:** `serialize(parse(src))` побайтово равен исходнику на всех
10 примерах; 34 теста на ошибки парсинга (требовалось ≥15); 90/90 тестов зелёные;
`tsc -b` под strict чистый, тестовые файлы тоже типизируются без ошибок.

### Файлы, добавленные сверх ТЗ-структуры (и почему)

- `core/src/grammar/signatures.ts` — синтаксические контракты примитивов/эффектов/огибающей.
  Единый источник правды для лексера, парсера, сериализатора и будущих `primitives/*.ts`.
  Лежит в `grammar/`, чтобы парсер не зависел от DSP-кода: `parse()` работает где угодно.
- `core/src/grammar/units.ts` — конвертации Hz/kHz, ms/s, dB→linear, формат чисел.
- `core/src/grammar/errors.ts` — `SoundlineError`, словарь синонимов, Дамерау-Левенштейн.
- `vitest.config.ts`, `.gitattributes` — инфраструктура.

---

## 3. Замороженные решения (не переоткрывать без причины)

Все они уже отражены в коде; при написании `docs/SOUNDLINE_GRAMMAR.md` их надо перенести
в документацию.

1. **Заголовок:** `sound "<имя>" <длительность> [<категория>] [loop]`.
   Категория — из закрытого списка `pop|ui|laser|impact|explosion|pickup|foley|cycle|misc`;
   без неё валидатору фазы 3 не к чему привязать инварианты. `misc` — дефолт, при
   сериализации опускается. `loop` — отдельный флаг; категория зациклённых звуков `cycle`
   (валидатор фазы 3 требует для неё флаг `loop`).
2. **Сигнальный порядок:** `source → envelope → chain → mix`, хотя пишется
   `source >> chain | envelope`. Огибающая шейпит источник, эффекты идут после неё,
   поэтому хвосты `delay`/`verb` переживают `decay`. На этом построен helicopter
   (ротор = сабовый удар, рециркулированный delay-петлёй; LFO в v0 нет).
   **Компилятор фазы 2 обязан следовать этому порядку.**
3. **Числа хранятся как написаны** (`1.2kHz` = 1.2 + unit `kHz`), конвертация только
   через `toHz/toMs/toLinear`. Это и даёт lossless round-trip.
4. **Слитные безразмерные параметры** (`Q6`) — только для закрытого набора имён из
   сигнатур (kind `ratio`/`level`). Поэтому слой `snap2` остаётся одним идентификатором.
   Сериализатор склеивает только односимвольные имена в верхнем регистре (`Q6`),
   остальное через пробел (`gain 0.9`).
5. **Ошибки построчные:** одна сломанная строка не прячет остальные
   (`parseWithDiagnostics`). Лексические ошибки прерывают разбор целиком.
   Формат сообщения: `line L, col C: <detail> (<hint>)` — идёт в LLM как есть.
6. **Словарь синонимов в подсказках** (`lowpass→lp`, `reverb→verb`, `sweep→chirp`,
   `release→decay`, `volume→gain`, ...) + Дамерау-Левенштейн для опечаток
   (`nosie→noise`). Расстояние `lowpass`→`lp` = 5, чистая метрика такое не ловит,
   а LLM ошибается именно так. Каждый пойманный синоним экономит итерацию агента.
7. **В AST попадают только явно написанные аргументы**; дефолты применяет компилятор.
   Иначе round-trip перестаёт быть побайтовым.
8. **Канонизация:** 2 пробела отступа слоя, аргументы в порядке сигнатуры, огибающая
   в порядке `gain attack hold decay curve delay`, комментарии сохраняются
   (файловые, построчные над слоем и хвостовые), пустые строки съедаются.

---

## 4. Инварианты стиля (соблюдать во всех фазах)

- `@txt2sfx/core`, `shared`, `analyzer`, `optimizer` — **ноль runtime-зависимостей**
  (FFT, WAV, DE — свои). Зависимости только в `apps/` и в devDependencies.
- TypeScript strict, без `any` в публичных API, экспортируемые типы с TSDoc.
- Никакого `localStorage` в web (состояние в React state; персистентность — через API банка).
- Секреты только из env (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`), плюс `.env.example`.
  Ключ Gemini, введённый в UI, живёт в памяти вкладки и уходит только в запросы,
  которые инициировал пользователь.
- Сообщения об ошибках рассчитаны на двух адресатов сразу: человека и LLM в цикле.
- Спорные решения (формула расстояния, дефолтные диапазоны) — принять, реализовать
  и обосновать комментарием/в docs, а не останавливаться с вопросом.
- В конце каждой фазы — работающие тесты.

---

## 5. Фаза 2 — примитивы, компиляция, рендер, кодоген

**Файлы:**

```
packages/core/src/
├── primitives/
│   ├── index.ts            # реестр PrimitiveDef, импортирует сигнатуры из grammar/signatures.ts
│   ├── tone.ts noise.ts chirp.ts pluck.ts modal.ts fm.ts sub.ts click.ts
│   └── effects/lp.ts hp.ts bp.ts dist.ts delay.ts verb.ts
├── compile/
│   ├── graph.ts            # AST → живой Web Audio граф (для playground)
│   └── codegen.ts          # AST → строка vanilla-JS функции
├── render/
│   ├── offline.ts          # AST → AudioBuffer через инжектируемый OfflineAudioContext
│   └── wav.ts              # AudioBuffer → WAV (Uint8Array)
└── test/{primitives,codegen,render}.test.ts
```

**Ключевые требования:**

- Единый интерфейс `PrimitiveDef`: каждый файл импортирует свою сигнатуру из
  `grammar/signatures.ts` и добавляет `build(ctx, args, when, durationMs)`.
  Дублировать список параметров запрещено.
- **Ядро не зависит от `node-web-audio-api`.** Рендер-функция (фабрика
  `OfflineAudioContext`) инжектится: в браузере нативная, в Node — из
  `node-web-audio-api` как devDependency в server/bench/тестах.
- `noise`: pink/brown генерировать детерминированно (свой seeded PRNG), иначе
  метрики и снапшоты рендера будут плавать. Seed — часть опций рендера.
- `pluck` — Karplus–Strong через `AudioBufferSourceNode` + петля задержки либо
  предрасчёт буфера; выбрать предрасчёт, если это дешевле для codegen.
- `modal` — 2–5 биквад-резонаторов, пресеты ratios по материалу
  (metal 1:2.41:3.86, wood 1:2.57:4.94, glass 1:2.76:5.40, membrane 1:1.59:2.14).
- Экспоненциальные рампы: цель никогда не 0, использовать `GLOBAL_LIMITS.minExpTarget`
  (0.001). Это глобальный инвариант, он же проверяется валидатором фазы 3.
- `codegen` выдаёт самодостаточную функцию `(ctx, when = 0) => void` без внешних
  зависимостей, ≤ 1 KB (`GLOBAL_LIMITS.maxExportBytes`).

**Критерии приёмки:**

- все 10 examples рендерятся в непустой AudioBuffer без клиппинга;
- codegen выдаёт функцию ≤ 1 KB, исполняющуюся в чистом `AudioContext` (тест —
  исполнить строку через `new Function` в node-web-audio-api и сравнить рендер
  с рендером графа: RMS-огибающие должны совпасть в пределах допуска);
- снапшот-тесты рендера детерминированны при фиксированном seed.

**Известный риск, требующий действия:** в `examples/explosion.soundline` сумма gain
четырёх слоёв ≈ 1.63 в момент атаки. Как только появится рендер — замерить пик и
подкрутить gain в примерах, чтобы уложиться в `maxPeak = 0.95`. Правится **спека**,
не рендер (см. принцип 2). То же проверить для sword-clash и footstep-gravel.

---

## 6. Фаза 3 — валидатор и анализатор

**Файлы:**

```
packages/core/src/validate/{invariants.ts,index.ts}
packages/analyzer/src/{fft.ts,profile.ts,distance.ts,diff.ts,index.ts}
packages/analyzer/package.json, tsconfig.json
```

**Валидатор** — `validate(ast): ValidationIssue[]`, инварианты из
`shared/constants.ts` (`CATEGORY_LIMITS`, `GLOBAL_LIMITS`), минимум:

- pop/click/snap: суммарная длительность ≤ 60 ms, decay каждого слоя ≤ 40 ms,
  частотные рампы длиннее 20 ms запрещены (анти-«пиу»);
- laser 80–300 ms; explosion/impact 200–1500 ms; ui 30–120 ms;
  cycle 500–3000 ms и обязателен флаг `loop`;
- глобально: пиковая амплитуда ≤ 0.95, ни один exponential-рамп не заканчивается на 0,
  число слоёв ≤ 6;
- контракт длительности заголовка: всё, что выходит за него (включая хвосты
  delay/verb — считать по сигнальному порядку из §3.2), — issue.

Каждое нарушение — `ValidationIssue { severity, layer, rule, got, expected, hint, loc }`;
`hint` формулируется как инструкция для LLM.

**Анализатор** — своя radix-2 FFT без зависимостей; `extractProfile(buffer): SoundProfile`
(поля уже описаны в `shared/types.ts`); `profileDistance(a, b)` = взвешенная сумма
расстояний по полям + multi-resolution STFT loss (окна 256/1024/4096, log-magnitude, L1),
перед сравнением нормализация громкости и выравнивание по onset;
`humanReadableDiff(a, b): string[]` — директивы вида
`"attack is 45ms, target 8ms — shorten the gain ramp"`,
`"centroid 1.2kHz vs 3.4kHz — raise bp frequency in layer 'snap'"`.
Именно эти строки, а не сырые числа, идут в промпт LLM.

**Критерии приёмки:** профиль bubble-pop даёт `durationMs < 60`; валидатор ловит
подсунутый «пиу» под видом pop (обязательный тест-кейс: `sound "pop" 35ms pop` со слоем
`tone sine 2000Hz -> 200Hz in 120ms` → issue `pop.max-freq-ramp`).

---

## 7. Фаза 4 — оптимизатор

**Файлы:** `packages/optimizer/src/{slots.ts,de.ts,index.ts}` + package.json/tsconfig.

- `slots.ts` — извлечение слотов `~X[min..max]` из AST (включая слоты на целях рампов)
  и обратная запись вектора значений в AST.
- `de.ts` — differential evolution, популяция ~24, ≤ 60 поколений, seed детерминируем
  (свой PRNG, не `Math.random`).
- `optimize(ast, targetProfile, renderFn, opts)` — fitness =
  `profileDistance(profile(render(candidate)), target)`.

**Критерий приёмки:** тест «восстановление» — взять эталонный soundline, испортить
значения слотов, оптимизатор возвращает fitness ниже порога за ≤ 60 поколений.

---

## 8. Фаза 5 — сервер банка рецептов

**Файлы:** `apps/server/src/{index.ts,db.ts,routes/recipes.ts,seed.ts}`, `apps/server/data/`.

Node + Fastify + better-sqlite3. Схема (SQL приведён в ТЗ дословно): таблица `recipes`
(id, name, prompt, soundline, profile_json, category, tags, duration_ms, rating,
created_at) + `recipes_fts` (fts5, content=recipes).

REST:

- `GET  /api/recipes?q=&category=&limit=` — FTS5 + фильтры
- `GET  /api/recipes/:id`
- `POST /api/recipes` — **валидирует soundline через @txt2sfx/core перед записью**
- `POST /api/recipes/:id/vote` — `{delta: 1|-1}`
- `GET  /api/retrieve?prompt=&k=3` — top-k для few-shot (v0: FTS-ранжирование по промпту
  и тегам; интерфейс готов к замене на embedding-поиск)
- `GET  /api/health`

`seed.ts` парсит все `examples/*.soundline`, рендерит, снимает профили, заливает в БД.

**Критерий приёмки:** `retrieve` по «coin pickup sound» возвращает coin в топ-1.

**Не забыть про требование заказчика:** этот сервер — точка входа для внешнего агента
без установки. Значит: CORS, `GET /api/health`, человекочитаемые ошибки и, желательно,
`GET /api/llms.txt` или аналогичная страница с грамматикой + примерами, чтобы чужой
агент за один запрос получил всё нужное для генерации soundline.

---

## 9. Фаза 6 — веб-плейграунд

**Файлы:** `apps/web/src/App.tsx`, `components/{PromptBar,SoundlineEditor,LayerTimeline,
Visualizer,CompareView,ExportPanel,Gallery}.tsx`, `api.ts`. Vite + React + TS.

Сценарий: ввёл промпт → (нет ключа? кнопка деградирует до выбора ближайшего рецепта
через `/retrieve`) → звук играет, слои видны на таймлайне, soundline открыт в редакторе →
пользователь крутит слот-значения слайдерами (слайдеры генерируются из слотов `~`) →
Export: копировать JS / скачать WAV / копировать soundline. Правка текста немедленно
перепарсивается, ошибки парсера подчёркиваются в строке (`error.loc` уже содержит
`offset`/`length` именно для этого).

Тёмная тема, неоновые акценты по цветам слоёв (циан/пурпур/янтарь/изумруд),
моноширинный шрифт для soundline. Визуализатор — свой canvas-код, спектрограмма
с логарифмической осью частот.

**Плюс требование заказчика:** поле для вставки **Gemini API-ключа** прямо в UI
(в памяти вкладки, без localStorage), выбор провайдера Gemini/Anthropic/mock.

**Критерий приёмки:** сценарий проходит вручную end-to-end с mock-провайдером.

---

## 10. Фаза 7 — агент, бенчмарк, документация, CI

**Файлы:**

```
packages/agent/src/{provider.ts,anthropic.ts,gemini.ts,mock.ts,prompts.ts,loop.ts}
bench/{run.ts,README.md,targets/*.json}
docs/{ARCHITECTURE,SOUNDLINE_GRAMMAR,PRIMITIVES,ACOUSTIC_PROFILE,AGENT_LOOP,API}.md
README.md, LICENSE (Apache-2.0), CONTRIBUTING.md, ROADMAP.md, .env.example
.github/workflows/ci.yml, tsconfig.test.json
```

- `LLMProvider { complete(msgs): Promise<string> }`; реализации: Anthropic, **Gemini**
  (ключ из env или передан вызовом — см. §0), mock с зашитыми ответами.
- `prompts.ts` — системный промпт: грамматика + физика + few-shot из банка (`/api/retrieve`).
- `loop.ts` — `generateSound(prompt, opts)`: prompt → soundline → validate → render →
  метрики/diff → правка → ... до порога или лимита итераций.
  **Жёсткое правило:** LLM меняет топологию только если оптимизатор упёрся
  (fitness не улучшился за N поколений и остаётся выше порога).
- `bench/run.ts` — для каждой цели из `targets/*.json`: agent + optimizer → скор → таблица.
- README по структуре образца img2threejs: логотип-заглушка (SVG), слоган
  *«Text-to-SFX as code. Sounds that weigh bytes, not megabytes.»*, три абзаца «что это»,
  блок «убийственный пример» (5 строк soundline рядом с ~40 строками Web Audio и подписью
  о размере экспорта), mermaid-диаграмма полного цикла, quick start, таблица примитивов,
  **honesty about limits** (процедурный синтез силён в SFX — удары, щелчки, зумы, UI,
  sci-fi — и слаб в органике: голос, реалистичные животные, сложные текстуры),
  roadmap/contributing/license.
- ROADMAP: v0 прототип → v0.2 CLAP-судья и vision-сравнение спектрограмм →
  v0.3 SFX-Bench 50 целей + публичная таблица → v0.4 showcase на GitHub Pages →
  v1.0 стабильная грамматика.
- CI: lint + test + build на PR. Добавить `tsconfig.test.json` — сейчас `tsc -b`
  покрывает только `src`, тесты типизируются отдельным вызовом.

---

## 11. Хвосты и напоминания

- [ ] `git init` + первый коммит (репозиторий ещё не под контролем версий).
- [ ] `LICENSE` (Apache-2.0, полный текст) — отложен на фазу 7.
- [ ] Подкрутить gain в explosion/sword-clash/footstep-gravel по факту замера пика (фаза 2).
- [ ] `tsconfig.test.json` для типизации тестов в CI (фаза 7).
- [ ] Перенести замороженные решения §3 в `docs/SOUNDLINE_GRAMMAR.md`.
- [ ] Gemini-провайдер + поле ключа в UI (требование заказчика, §0).
- [ ] Точка входа для внешнего агента без установки (§8).
