# План: «плейграунд полезен без ключа LLM»

Статус: утверждён, в исполнении (Opus-агент, фазы в порядке 1 → 2 → 5 → 3 → 4 → 6).
Гейт после каждой фазы: `corepack pnpm typecheck` + `corepack pnpm test`.
По завершении — раздел в `.plans/txt2sfx-v0.md` (даты, отклонения, что проверено в браузере).

Замысел: без ключа плейграунд уже умеет редактор, слайдеры слотов, Fit, галерею,
A/B-сравнение и экспорт. Этот план закрывает оставшуюся дыру — путь «текст → звук» —
тремя честными механизмами (мастер-слайдеры, вариации, retrieval из банка) плюс
пресет-каталог, поиск на главной и запись с микрофона как цель для Fit.
Генерация остаётся за ключом/агентом; retrieval никогда не называет себя генерацией.

---

## 0. Что проверить перед стартом (внутренние допущения)

1. **`EnvelopeNode.loc` — это токен `|`** (проверено: `packages/core/src/grammar/parser.ts:616-619`, `loc: pipe.loc`). Это якорь вставки `lp` в фазе 1. Перепроверить после любого rebase.
2. **`NumberLiteral.loc` покрывает только числовой токен** (без `~` и `[min..max]`); спаны границ слота парсер сейчас выбрасывает (`parseSlot` возвращает голые `{min,max}`, `parser.ts:241`). Фаза 1 требует расширения `SlotRange` — перед этим прогнать `Grep "slot: \{"` по репо и убедиться, что никто не конструирует `SlotRange` объектным литералом, ожидая точную форму (важно из-за `exactOptionalPropertyTypes`).
3. **`roundLiteral` кусочная** (`units.ts:122-128`): у масштабирования есть краевой случай, когда после округления `value` может выпасть из округлённых границ или `min === max` — парсер тогда падает жёсткими ошибками `slot.start-outside` / `slot.range-order`. Трансформ обязан защищаться (см. фазу 1).
4. **Тесты web запускаются в `environment: 'node'`** (vitest.config.ts) — новые lib-модули web должны быть тестируемы без DOM; `record.ts` (фаза 6) — единственное исключение, его чистые части выносятся отдельно.
5. **`GalleryItem.origin` / `Entry.Origin`** = `'session' | 'examples' | 'bank'` — перед фазой 5 grep всех switch/сравнений по `origin` (Rail, SoundCard, catalog.test.ts), чтобы расширение union не оставило мёртвых веток.
6. **`render.test.ts` пинит `expect(examples).toHaveLength(10)`**, `docs.test.ts` требует строку `| name |` в ACOUSTIC_PROFILE.md на каждый файл `examples/` — поэтому пресеты идут в отдельный `presets/`, ничего в `examples/` не добавляем.
7. **Глубина glob**: `lib/examples.ts` использует `import.meta.glob('../../../../examples/*.soundline')` — для `presets/` тот же префикс `../../../../presets/*.soundline`.
8. **i18n-конвенция**: полный словарь только `en` (источник типа `Key`), переводы новых ключей — минимум `en` + `ru`, остальные семь локалей падают на английский (зафиксировано в `.plans` §25.1).
9. **`GLOBAL_LIMITS.maxPeak = 0.95`** (`packages/shared/src/constants.ts:151`) — контракт качества пресетов ссылается на эту константу, не на магическое число.
10. Внешних зависимостей план не добавляет нигде (MediaRecorder/getUserMedia — платформенные API). Zero-deps в `packages/*` не нарушается.

---

## Фаза 1 — мастер-слайдеры (pitch / length / brightness)

### 1.1. Ядро: grammar-aware трансформ в `packages/core`

**Изменить `packages/shared/src/types.ts`** — расширить `SlotRange`:

```ts
export interface SlotRange {
  readonly min: number;
  readonly max: number;
  /** Спаны числовых токенов границ; заполняются парсером. Опциональны, потому что
      AST можно построить руками, и exactOptionalPropertyTypes требует явного отсутствия. */
  readonly minLoc?: Loc;
  readonly maxLoc?: Loc;
}
```

**Изменить `packages/core/src/grammar/parser.ts`** — `parseSlot` (строки ~160-242) возвращает вдобавок `minLoc: minTok.loc, maxLoc: maxTok.loc`. Сериализатор не трогается (`formatLiteral` читает только `min/max`), значит round-trip не меняется.

**Создать `packages/core/src/transform/scale.ts`** (новый каталог `transform/`), экспорт через `src/index.ts`:

```ts
export type ScalableKind = 'freq' | 'time';

export interface ScaleResult {
  /** Переписанный текст; равен входу, когда литералов этого kind нет. */
  readonly source: string;
  /** Сколько литералов затронуто — UI по нулю прячет/глушит слайдер. */
  readonly touched: number;
}

/** Умножить каждый литерал данного kind на ratio, переписав текст по спанам. */
export function scaleKind(source: string, kind: ScalableKind, ratio: number): ScaleResult;

/** Сдвинуть cutoff lp/hp на ratio; слоям без lp/hp дописать `>> lp <cutoff>`. */
export function scaleBrightness(source: string, ratio: number): ScaleResult;
```

Механика (то же решение, что в `optimizer/src/slots.ts`, — **кандидат это текст**, и его комментарий-шапка объясняет почему):

- Внутри `parse(source)` (парс — микросекунды, тот же аргумент, что у оптимизатора). Обход зеркалит `collectSlots`: header `ast.duration` (kind `time`), для каждого слоя — `layer.source.args`, `layer.chain[i].args`, `layer.envelope.args`; kind каждого аргумента берётся из `lookupSignature(node.name).params` / `ENVELOPE.params` — **никогда не хардкодить список имён параметров**, только сигнатуры (правило «never hand-write a table»). Ramp: `segment.to` наследует kind головного параметра, `segment.time` всегда `time`.
- Для каждого литерала нужного kind: правка спана `lit.loc` текстом `formatNumber(roundLiteral(lit.value * ratio)) + lit.unit`. Значение остаётся в записанной единице (kHz умножается как kHz — умножение единицу не ломает).
- Для литерала со слотом дополнительно правки `slot.minLoc` / `slot.maxLoc` текстом `formatNumber(roundLiteral(bound * ratio))` **без единицы** (голая граница — каноническая форма, см. комментарий парсера `parser.ts:196-201`; заодно это нормализует редкие `[200ms..1s]`, что честнее, чем воспроизводить неканоничную запись). Внимание: `slot.min/max` в AST уже приведены к единице головы, а исходный токен мог быть в другой — писать через `minLoc.length`-замену это учитывает.
- **Защита от округления** (пункт 0.3): после округления `value` клампится в `[roundedMin, roundedMax]`; если `roundedMin >= roundedMax` — границы этого слота не масштабируются (оставить как были). Обе защиты с комментарием-«почему».
- Все правки применяются одним проходом от последнего спана к первому (тот же приём и с тем же обоснованием, что `applyVector` в `optimizer/src/slots.ts:141-160`). Выделить приватный помощник `replaceSpans(source, edits: readonly { loc: Loc; text: string }[]): string` внутри `scale.ts`. **Не рефакторить** `optimizer/src/slots.ts` и `apps/web/src/lib/slots.ts` под него в этом же изменении — оба покрыты тестами и работают; вынос общего кода в core — отдельный follow-up (зафиксировать в `.plans` как открытый вопрос).

`scaleBrightness`:
- Для каждого слоя: если в `layer.chain` есть эффекты `lp`/`hp` — масштабировать их параметр `freq` (голову, ramp-цели и границы слота) на `ratio`, с клампом в `[spec.min, spec.max]` этой сигнатуры (20..20000, читать из `EFFECTS['lp']`, не хардкодить).
- Если в цепочке нет ни `lp`, ни `hp` — вставить перед `layer.envelope.loc.offset` текст `` `>> lp ${formatNumber(clampedCutoff)}Hz ` ``, где `clampedCutoff = clamp(round(OPEN_CUTOFF_HZ * ratio))`. Константа `OPEN_CUTOFF_HZ = 12000` с комментарием происхождения: при 44.1 кГц lp на 12 кГц практически прозрачен для материала этих категорий (центроиды референсов < 8 кГц, см. docs/ACOUSTIC_PROFILE.md), так что при ratio=1 вставка не слышна, а при ratio<1 честно темнит. Вставленный текст обязан совпадать с тем, что напишет сериализатор (` >> lp NNNNHz`) — это условие сохранения канона.
- `bp` сознательно не трогаем и его наличие **не** считаем фильтром: центр полосового фильтра — это воспринимаемая высота слоя (`bp` «turns flat noise into a pitched-sounding snap»), его двигает pitch-мастер (kind `freq`), а не brightness. Записать это в шапку модуля как отвергнутую альтернативу (конвенция «comment why»).

**Тесты — создать `packages/core/test/scale.test.ts`:**
- на каждом из 10 `examples/` (через существующий `test/helpers` loadExamples): `scaleKind(src,'freq',2)` и `'time'` — результат парсится, все литералы нужного kind умножены (сверка по повторному `collectSlots`-подобному обходу), литералы других kind и комментарии/имена нетронуты;
- **round-trip**: для канонического входа `serialize(parse(result)) === result` (для обоих kind и для brightness);
- слоты: границы масштабированы вместе со значением, `parse` не бросает `slot.start-outside`/`slot.range-order` (включая специально сконструированный краевой случай на округление);
- brightness: сдвиг существующего lp (`explosion`), вставка lp в слой без фильтров (`laser`/`coin`), кламп cutoff на границах сигнатуры;
- «нулевая» операция: `scaleKind(src, k, 1).source === src` — не обязана быть строго (округление), поэтому семантика UI строится на базовом тексте (см. ниже); тест фиксирует фактическое поведение при ratio=1 для канонических примеров (там числа уже в точности roundLiteral — равенство держится).

### 1.2. Семантика «нуля» слайдера — решение

**Jog-слайдер: базовый текст + текущий ratio, commit при отпускании, слайдер возвращается в 1.0.**

- В момент начала перетаскивания (первый `onChange` после покоя / `onPointerDown`) запоминается `base = source`.
- Каждое движение: `setSource(scaleKind(base, kind, ratio).source)` — одно умножение от базы, live-рендер идёт через существующий конвейер (`RENDER_DEBOUNCE_MS`/автоплей в App.tsx уже это делают для слотов).
- Отпускание (`onPointerUp` + `onKeyUp` для клавиатуры): финальный текст уже в редакторе, `base` сбрасывается, контролируемое значение слайдера возвращается к 1.0.

Обоснование: (а) ошибка округления не накапливается — в пределах одного жеста всегда `round(base × ratio)`, а не цепочка `round(round(...)×δ)`; (б) между жестами источник правды — текст (правило App.tsx «the source text is the state»), пользователь мог отредактировать рецепт руками, и «вечный» ratio от замороженной базы начал бы врать; (в) повторные жесты компонуются как у любого джога (2× затем 2× ≈ 4× с точностью roundLiteral — слышимой разницы нет by construction, см. комментарий `roundLiteral`).

### 1.3. UI

**Создать `apps/web/src/lib/master.ts`:**

```ts
export type MasterKind = 'pitch' | 'length' | 'brightness';
/** Позиция ползунка 0..1 -> ratio по лог-кривой, центр = 1.0. */
export function positionToRatio(position: number): number;   // RANGE = 4: ratio ∈ [1/4..4]
export function ratioToPosition(ratio: number): number;
/** Применить мастер к тексту. Возвращает ScaleResult из core. */
export function applyMaster(source: string, kind: MasterKind, ratio: number): ScaleResult;
```

`RANGE = 4` (±2 октавы / ×4 по времени) с комментарием: частота и время воспринимаются как отношения — та же лог-кривая, что у слотов (`lib/slots.ts:isLogarithmic`); ±2 октавы покрывают осмысленный диапазон правки, дальше рецепт меняет идентичность и это работа для текста.

**Изменить `apps/web/src/components/SlotsCard.tsx`:** блок из трёх слайдеров над списком слотов (та же разметка `.slider`), новые пропсы:

```ts
readonly masters: Readonly<Record<MasterKind, number>>;      // текущая позиция (0.5 в покое)
readonly onMaster: (kind: MasterKind, position: number) => void;
readonly onMasterCommit: (kind: MasterKind) => void;
```

pitch/brightness глушатся (`disabled` + title), когда `applyMaster(...).touched === 0` — честнее скрытия. length активен всегда (header duration есть у любого рецепта).

**Изменить `apps/web/src/App.tsx`:** состояние `masterBase = useRef<string | null>(null)` и `masterPos`, обработчики по семантике 1.2 (через `setSource` — попадает в edits/dirty/session как любая правка). Валидатор уже гоняется на каждый ввод (`issues = validate(ast)`, App.tsx:360) и hints показываются в `SoundlineCard`, ничего не блокируя, — ровно требуемое поведение «за инварианты вывело — hint честно виден, слушать можно».

**i18n:** ключи `master.title`, `master.pitch`, `master.length`, `master.brightness`, `master.noFreq`, `master.noFilters` в `locales/en.ts` + `locales/ru.ts`.

**Порядок шагов фазы:** shared types → parser → scale.ts + тесты (гейт) → master.ts → SlotsCard → App → i18n (гейт).

**Критерий готовности:** три слайдера в студии; движение слышно live; отпускание коммитит текст и возвращает ползунок в центр; `serialize(parse(result)) === result` на канонических рецептах покрыт тестом; рецепт с нарушенным после масштабирования инвариантом играет и показывает hint.

---

## Фаза 2 — кнопка «Variation»

**Создать `apps/web/src/lib/variation.ts`:**

```ts
/** Случайные значения всех ~слотов внутри их [min..max] по лог-кривой. Детерминирован по seed. */
export function vary(source: string, seed: number): string;
```

Реализация: `collectSlots` + `applyVector` + `positionToValue` **импортом из `@txt2sfx/optimizer`** (уже экспортированы, `optimizer/src/index.ts:54-60`; web уже зависит от optimizer) — позиции = вектор `random()` из маленького xorshift32 по seed (константы с комментарием-источником). Лог-кривая приходит бесплатно из `positionToValue`. Это буквально «existing механизм слотов» из требования.

**UI:** кнопка `⚄ {t('slots.variation')}` в шапке `SlotsCard` рядом с Fit; `disabled` при `slots.length === 0` (пустое состояние карточки уже учит писать `~`). В App: `onVariation = () => setSource(vary(source, Math.floor(Math.random()*0xffffffff)))` — обычная правка, авто-плей сработает сам.

**Тест — `apps/web/test/variation.test.ts`:** детерминизм по seed; каждый новый литерал внутри своих границ; результат парсится; не-слотовые литералы и структура нетронуты; на рецепте без слотов возвращает вход.

**Критерий готовности:** кнопка работает без ключа и без банка; два нажатия дают два разных слышимых варианта; тесты зелёные.

---

## Фаза 3 — промпт без ключа через retrieval

**Создать `apps/web/src/lib/retrieval.ts`:**

```ts
export interface RetrievalHit {
  readonly name: string;
  readonly soundline: string;
  /** Промпт, на который рецепт отвечал в банке, — показывается рядом с честной пометкой. */
  readonly prompt: string;
  readonly origin: 'bank' | 'bundled';
}
/** Лучший ответ банка (GET /api/retrieve?k=3 через RecipeSource), иначе локальный поиск по вшитым рецептам. */
export async function retrieveForPrompt(prompt: string, bank: RecipeSource | null): Promise<RetrievalHit | null>;
```

- Банк: `bank.retrieve(prompt, 3)` (`@txt2sfx/agent` `httpBank` уже умеет и уже проброшен как `bank.recipes` в `lib/bank.ts:360`). **Решение про `fallback: true`:** ответ с этим флагом — это «ничего не совпало, вот топ по рейтингу»; загружать такой рецепт как ответ на промпт было бы ровно тем размыванием границы, за которое убили demo mode (`lib/agent.ts:10-28`) → трактуется как промах, идём в локальный фолбэк.
- Локальный фолбэк: скоринг токен-пересечения промпта с `name + leading-комментарии` из `bundledRecipes()` (`lib/examples.ts`) **плюс** `bundledPresets()` после фазы 5 (у пресетов есть prompt/tags — качество фолбэка резко растёт). Нулевое пересечение → `null`, не «лучший из несвязанных».

**Изменить `apps/web/src/lib/useGenerate.ts`:** в `start()` ветка `provider === null` вместо `setError(NO_MODEL())` (строки 201-207) запускает retrieval:
- лог: `⌕ no model attached and no key — searching the bank instead`;
- при попадании: `onGenerated({ name: recipeName(hit.soundline, prompt, takenNames), source, prompt })` + завершающая строка лога `● loaded from the bank — retrieved, not generated` (для `bundled` — своя формулировка); рецепт открывается в редакторе обычным путём (composing снимается, авто-плей сработает);
- при промахе: `setError(t('run.retrieveNothing'))` — с подсказкой вставить ключ или подключить агента.

**Изменить `apps/web/src/components/PromptRow.tsx`:** на виде `sound` `model === null` больше не блокирует кнопку (строка 107); label кнопки при `model === null` меняется на `t('prompt.find')` («Find in bank») — честная замена, кнопка **не** притворяется генерацией; tooltip `prompt.runsRetrieve` объясняет; шестерёнка остаётся янтарной с точкой (ключа по-прежнему нет — это правда). Model/Search вкладки не трогаются.

**Изменить `apps/web/src/App.tsx`:** `generateFromGallery` уже зовёт `generation.start` — работает без правок; hero-кнопка галереи перестаёт быть тупиком без ключа автоматически.

**i18n:** `run.retrieved`, `run.retrievedLocal`, `run.retrieveNothing`, `prompt.find`, `prompt.runsRetrieve` (en+ru).

**Тест — `apps/web/test/retrieval.test.ts`:** инжектированный `RecipeSource` (как `staticBank`): попадание → hit c `origin:'bank'`; `fallback:true` → идём в локальный поиск; банк `null`/пустой → локальный фолбэк по вшитым примерам; полный промах → `null`.

**Критерий готовности:** свежая вкладка без ключа: промпт «laser zap» → в студии открыт рецепт из банка (или из вшитых), лог явно говорит «retrieved, not generated»; ни одна строка UI не называет это генерацией.

---

## Фаза 4 — домашний экран = поиск по банку

Минимальная перестройка, не переписывание: Gallery уже имеет строку поиска, чипы и play-в-списке; меняется **источник** результатов.

**Изменить `apps/web/src/lib/bank.ts`:** `BankClient.list` получает параметры:

```ts
list(options?: { readonly q?: string; readonly category?: string; readonly limit?: number }): Promise<BankListing>;
```

— собирает query string на существующий `GET /api/recipes` (сервер уже умеет `q` через FTS5 и `category`, `routes/recipes.ts:151-173`; API не трогаем).

**Изменить `apps/web/src/App.tsx`:**
- новый debounce-эффект (константа `SEARCH_DEBOUNCE_MS = 300` с комментарием: темп набора текста; тот же класс решений, что `RENDER_DEBOUNCE_MS`) на `[query, filter, bankHealth]`: при живом банке — `bank.list({ q, category })` → `setBankList(bankEntries(...))`; со счётчиком/флагом отмены как в соседних эффектах;
- **состояние поиска остаётся в React state** (решение): роутера в приложении нет, экраны — `useState<Screen>`, а URL уже занят share-payload и auth-exchange (`code`, `return`) — параметр `?q=` рисковал бы столкнуться с ними ради фичи, которую никто не просил. Зафиксировать выбор комментарием.
- Клиентский фильтр `matches()` в Gallery для bank-записей при активном серверном поиске отключается (FTS матчит по prompt/tags, которых нет в подстроке `name+source`): пометить записи серверного поиска или передать в Gallery проп `serverFiltered: boolean` и в `visible` пропускать `origin === 'bank'` без needle-проверки. Session/examples/presets продолжают фильтроваться локально — фолбэк при недоступном банке остаётся текущим (механизм уже есть).
- Чипы: при живом банке показывать все `SOUND_CATEGORIES` (после фазы 5 пустых почти не будет), выбранная категория уходит в серверный запрос; оффлайн — текущее поведение «только присутствующие».

**Изменить `apps/web/src/screens/Gallery.tsx`:** проп `serverFiltered`, опционально счётчик «найдено в банке N»; пустое состояние с «Generate it instead» сохраняется (после фазы 3 работает и без ключа).

**Тест — дополнить `apps/web/test/bank.test.ts`:** `list({ q, category })` строит правильный URL (инжектированный fetch), пустые параметры не попадают в строку.

**Критерий готовности:** ввод в поиске главной с живым банком даёт серверные FTS-результаты с дебаунсом; прослушивание и «Open in Studio» работают из списка (уже работают); банк выключен → всё как сейчас на вшитом снапшоте.

---

## Фаза 5 — пресеты

### 5.1. Контракт `presets/`

Каталог `presets/` в корне, по файлу на пресет. Лёгкий контракт (НЕ контракт examples: без строки в ACOUSTIC_PROFILE.md, без участия в count-тестах):

```
# prompt: sci-fi laser pistol zap, quick and thin
# tags: laser, pistol, zap, weapon
sound "laser pistol" 160ms laser
  ...
```

- канонический вид: `serialize(parse(src)) === src` (leading-комментарии сериализатор сохраняет — `serializer.ts:104`, так что мета-строки канону не мешают);
- `# prompt:` обязателен, `# tags:` обязателен (comma-separated);
- `validate` без ошибок (строже examples — helicopter-исключение остаётся уникальным для examples и не воспроизводится);
- рендер-контракт (проверяет сидер): рендерится, не клиппит, `peak <= GLOBAL_LIMITS.maxPeak` (0.95), не тишина.

**Создать `packages/core/src/grammar/meta.ts`** (zero-dep, работает по `ast.leading`; нужен и серверу, и web):

```ts
export interface RecipeMeta { readonly prompt: string | null; readonly tags: readonly string[]; }
/** Читает маркеры `prompt:` / `tags:` из leading-комментариев AST. */
export function recipeMeta(ast: SoundAST): RecipeMeta;
```

Экспорт из `core/src/index.ts`.

### 5.2. Сидер

**Изменить `apps/server/src/seed.ts`:**
- `SeedOptions.directory` → `directories?: readonly string[]` (дефолт `[EXAMPLES_DIR, PRESETS_DIR]`, `PRESETS_DIR` через `new URL('../../../presets', import.meta.url)`); обратную совместимость одиночного `directory` сохранить или мигрировать оба вызова (index.ts/CI);
- мета: `PROMPTS[name] ?? recipeMeta(ast) ?? { prompt: name.replace(/-/g,' '), tags: [name] }` — таблица PROMPTS остаётся только для examples;
- отчёт: для пресетов добавить в `SeedEntry` измеренный `peak`/`clipped` (данные `measure()` уже под рукой) и предупреждать в `formatReport`, если `peak > GLOBAL_LIMITS.maxPeak` — это рабочий инструмент автора пресетов; `--strict` для каталога presets означает «ошибки валидации и клиппинг блокируют» (пресеты обязаны быть чистыми — это отличие от examples задокументировать в шапке).

### 5.3. Вшивание в плейграунд

**Создать `apps/web/src/lib/presets.ts`** (по образцу `examples.ts`, только чтение):

```ts
export interface Preset { readonly name: string; readonly source: string; readonly prompt: string; readonly tags: readonly string[]; readonly category: string; }
export function bundledPresets(): Preset[];   // import.meta.glob('../../../../presets/*.soundline', { query:'?raw', import:'default', eager:true }) + parse + recipeMeta
```

**Изменить `apps/web/src/lib/catalog.ts`:** `Origin` += `'preset'`; `presetEntries()`; порядок слияния: `session` > `examples` > `bank` > `preset` (при живом банке пресет уже там как bank-запись с id/лайками — дубликат по имени выпадает; оффлайн пресеты видны). Проверить пункт 0.5 (использования origin).

**App.tsx / Gallery:** пресеты попадают в `entries` — карточки, поиск-фолбэк и локальный retrieval (фаза 3) получают их автоматически; `prompt` карточки берётся из меты (существующий `ast.leading`-фолбэк в `items` начал бы показывать `prompt: ...`-маркер — в `items` для origin `preset` брать `entry.prompt`, он уже заполнен).

### 5.4. Тест

**Создать `test/presets.test.ts`** (repo-level, без аудио — рендер проверяет сидер):
- каждый `presets/*.soundline`: `parse` ок; `validate` без ошибок; `serialize(parse(src)) === src`; `recipeMeta` даёт непустой prompt и ≥2 тегов; категория из `SOUND_CATEGORIES`;
- количество файлов равно длине манифеста (список ниже) — точное число, как у examples, чтобы пресет не потерялся молча.

### 5.5. Список 50 пресетов (имя · категория soundline · prompt · tags)

Исполнитель пишет сами рецепты; контракт качества — §5.1. Имена не пересекаются с `examples/`.

**UI (ui):**
1. `ui-hover` — "soft menu hover tick" — ui, hover, menu, tick
2. `ui-confirm` — "positive confirm blip for a dialog" — ui, confirm, ok, blip
3. `ui-error` — "short harsh error buzz for a rejected action" — ui, error, deny, buzz
4. `ui-toggle-on` — "switch toggled on, snappy click with a rising blip" — ui, toggle, switch, on
5. `ui-toggle-off` — "switch toggled off, falling blip" — ui, toggle, switch, off
6. `ui-typewriter-key` — "single mechanical keypress for a typing effect" — ui, key, typewriter, click

**pickup (pickup):**
7. `pickup-gem` — "sparkling gem pickup, glassy arpeggio" — gem, pickup, sparkle, reward
8. `pickup-heart` — "warm health pickup, soft rising chime" — health, heart, pickup, heal
9. `pickup-key` — "small metallic key pickup jingle" — key, pickup, metal, jingle
10. `pickup-ammo` — "mechanical ammo pickup clack" — ammo, pickup, reload, clack
11. `levelup-fanfare` — "short level-up fanfare, three rising notes" — levelup, fanfare, reward, jingle

**weapon/laser (laser):**
12. `laser-pistol` — "small sci-fi pistol zap, quick and thin" — laser, pistol, zap, weapon
13. `laser-rifle` — "heavy laser rifle shot with a resonant tail" — laser, rifle, shot, weapon
14. `laser-charge` — "laser charging up, rising whine" — laser, charge, rise, whine
15. `plasma-bolt` — "plasma bolt, wet electric zap" — plasma, bolt, zap, scifi
16. `beam-burst` — "short energy beam burst" — beam, energy, burst, scifi
17. `zap-electric` — "electric spark zap, crackly" — zap, spark, electric, crackle

**impact / explosion (impact ×4, explosion ×3):**
18. `impact-metal-clang` (impact) — "heavy metal clang, resonant" — metal, clang, impact, hit
19. `impact-wood-thud` (impact) — "dull wooden thud" — wood, thud, impact, hit
20. `impact-stone-crack` (impact) — "stone cracking hit" — stone, crack, impact, rock
21. `punch-body` (impact) — "boxing body punch, meaty thump" — punch, body, hit, combat
22. `explosion-small` (explosion) — "small grenade blast, sharp crack" — grenade, blast, explosion, crack
23. `explosion-distant` (explosion) — "distant rumbling explosion" — explosion, distant, rumble, war
24. `explosion-firework` (explosion) — "firework burst with a crackle tail" — firework, burst, crackle, festive

**footstep / foley (foley):**
25. `footstep-wood` — "footstep on a wooden floor" — footstep, wood, walk, foley
26. `footstep-snow` — "footstep crunching in snow" — footstep, snow, crunch, winter
27. `footstep-water` — "splashy footstep in a puddle" — footstep, water, splash, puddle
28. `cloth-rustle` — "short cloth rustle" — cloth, rustle, fabric, foley
29. `paper-flip` — "page flip, papery flick" — paper, page, flip, book
30. `chest-open` — "wooden chest creaking open" — chest, open, creak, loot
31. `lock-click` — "lock clicking open" — lock, click, unlock, mechanism

**whoosh (misc):**
32. `whoosh-fast` — "fast air whoosh, sword swing" — whoosh, swing, air, fast
33. `whoosh-deep` — "deep slow whoosh, heavy object passing" — whoosh, deep, pass, heavy
34. `whoosh-transition` — "airy UI transition swipe" — whoosh, transition, swipe, ui
35. `dash-whoosh` — "quick dash whoosh with a doppler feel" — dash, whoosh, doppler, movement
36. `arrow-flyby` — "arrow flying past, whistling" — arrow, flyby, whistle, projectile

**jump / land (misc ×3, impact ×2):**
37. `jump-8bit` (misc) — "retro 8-bit jump, rising square blip" — jump, retro, 8bit, platformer
38. `jump-soft` (misc) — "soft cartoon hop" — jump, hop, cartoon, soft
39. `trampoline-boing` (misc) — "cartoon boing, springy bounce" — boing, spring, bounce, cartoon
40. `land-thump` (impact) — "character landing on dirt, soft thump" — land, thump, dirt, platformer
41. `land-heavy` (impact) — "heavy armored landing, metallic clatter" — land, heavy, armor, clatter

**alarm / notification (ui ×3, cycle ×1):**
42. `notify-ping` (ui) — "gentle notification ping" — notification, ping, message, soft
43. `notify-double` (ui) — "two-tone message notification" — notification, message, twotone, chat
44. `alarm-beep` (ui) — "urgent short alarm beep" — alarm, beep, urgent, warning
45. `alarm-klaxon` (cycle, loop) — "sci-fi alarm klaxon, two alternating tones" — alarm, klaxon, siren, loop

**ambient / loop (cycle, все с `loop`):**
46. `engine-idle` — "car engine idling loop" — engine, idle, car, loop
47. `wind-loop` — "steady wind loop" — wind, loop, ambient, weather
48. `rain-loop` — "rain on a roof loop" — rain, loop, ambient, weather
49. `machine-hum` — "electric machine room hum loop" — machine, hum, electric, loop
50. `campfire-loop` — "crackling campfire loop" — fire, campfire, crackle, loop

(категории соблюдают `CATEGORY_LIMITS`: например, `laser-charge` укладывается в 300 мс laser; `cycle`-пресеты несут флаг `loop` — `requiresLoop`.)

**Порядок шагов:** meta.ts + тест → контракт/README в presets/ → 50 рецептов пачками с прогоном сидера как линтера (`corepack pnpm --filter @txt2sfx/server seed` на локальном банке, смотреть отчёт по peak) → seed.ts → lib/presets.ts + catalog → test/presets.test.ts (гейт).

**Критерий готовности:** сидер грузит examples+presets, отчёт чистый (`--strict` проходит по presets); домашний поиск оффлайн находит пресеты из бандла; все тесты и typecheck зелёные.

---

## Фаза 6 — запись с микрофона → Fit

**Создать `apps/web/src/lib/record.ts`:**

```ts
export interface Recorder {
  /** Остановить и получить файл; дорожки микрофона гасятся здесь же (индикатор в табе). */
  stop(): Promise<File>;
  cancel(): void;
}
/** Выбор контейнера вынесен чистой функцией — тестируется в node без MediaRecorder. */
export function pickMimeType(isSupported: (type: string) => boolean): string; // webm;codecs=opus → mp4 (Safari)
export async function startRecording(): Promise<Recorder>;
```

- `getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })` — с комментарием: обработка браузера искажает именно то, что fit пытается сматчить;
- декодирование — существующим `decodeAudioFile` (`lib/analysis.ts`), та же дорога, что у файла (одно место, которое знает, что такое B — принцип уже записан в `App.loadReference`);
- копирование сэмплов не требуется в record.ts: оно происходит там, где сэмплы извлекаются — `targetFromBuffer` (`lib/agent.ts:187-193`) уже делает `Float32Array.from`, правило CLAUDE.md соблюдено на существующем пути.

**Изменить `apps/web/src/components/ComparePanel.tsx`:**
- `BKind` += `'record'`; чип «record» в ряду B-источников (`ComparePanel.tsx:449-477`): клик стартует запись, чип пульсирует и меняет подпись на «stop», повторный клик останавливает и грузит B; `B_HINT` += `record: 'compare.hintRecord'`;
- в `compare-actions` рядом с Fit — кнопка `● {t('compare.recordFit')}` («record → Fit»): первый клик пишет, второй останавливает **и сразу запускает fit** — одно действие;
- новые пропсы: `recording: boolean; onRecord: (thenFit: boolean) => void;` (реализация в App, панель — только кнопки).

**Изменить `apps/web/src/App.tsx`:**
- `recorder = useRef<Recorder | null>(null)`, состояние `recording`;
- **сигнатуру `fit` расширить** `fit(refOverride?: { name: string; buffer: AudioBuffer })` — record→Fit передаёт декодированный буфер напрямую, минуя гонку с ещё-не-закоммиченным state `reference` (та же ловушка stale-closure, о которой предупреждает шапка bridge-секции App.tsx); обычный вызов без аргумента читает `b` как раньше;
- поток: stop → `File` → `decodeAudioFile` → `setReference({name:'mic recording', buffer})`, `setBKind('record')` → при `thenFit` — `fit({...})`;
- отказ в доступе к микрофону → через существующий канал `referenceError` (честное сообщение, не пустой B).

**i18n:** `compare.record`, `compare.recordStop`, `compare.recordFit`, `compare.hintRecord`, `warn.micDenied` (en+ru).

**Тест — `apps/web/test/record.test.ts`:** только `pickMimeType` с застабленным `isSupported` (node-среда без MediaRecorder — пункт 0.4); остальное покрывается typecheck и ручной проверкой в браузере (зафиксировать в `.plans`, как делалось для похожих UI-проверок в §25.1).

**Критерий готовности:** в Compare можно записать голос/стук по столу и одной кнопкой получить fit рецепта под запись; повторная запись заменяет B; микрофонный индикатор гаснет после stop/cancel.

---

## Риски и открытые решения

1. **Округление при масштабировании** — единственный способ уронить парсер из трансформа (`slot.start-outside`, `slot.range-order`); закрыт клампом и guard'ом в фазе 1, обязателен тест на краевой случай.
2. **Brightness — не чистый ratio одного kind**: решение «lp/hp масштабируются, bp — нет, слой без lp/hp получает `lp` от 12 кГц» задокументировать в шапке `scale.ts` как принятое с отвергнутыми альтернативами. Если UX покажет, что вставленный lp пугает пользователей появлением строки в редакторе — это фича (текст = состояние), но стоит упомянуть в `.plans`.
3. **Length-мастер масштабирует и attack** — на ratio 4 перкуссия «размякнет»; это честная семантика отношения, валидатор подскажет; альтернатива (не трогать attack) отвергается как скрытая магия.
4. **Retrieval и честность**: три места, где граница проговаривается — label кнопки («Find in bank»), строка лога («retrieved, not generated»), и трактовка `fallback:true` как промаха. Ревьюеру сверяться с комментарием `lib/agent.ts:10-28`.
5. **Расширение `Origin`/`BKind`** — ripple по switch'ам; закрывается typecheck'ом (union exhaustiveness), но проверить рендер бейджей Rail/SoundCard глазами.
6. **50 пресетов — основной объём ручной работы**; инструмент контроля — отчёт сидера (peak/clipped/issues per file). Рекомендованный конвейер: писать пачками по категории, гонять `seed --strict` на локальном банке.
7. **Дубликаты имён presets↔bank** при живом банке: слияние отдаёт приоритет bank-записи (у неё id/лайки) — проверить, что оффлайн-переход не «раздваивает» карточки.
8. **Не трогать**: `packages/bridge` и его release-процедуру, `.github/workflows/deploy-server.yml`, инварианты helicopter (сидер examples по-прежнему нестрогий; строгость — только для `presets/`). `docs/` в этом плане содержательно не меняются (ни новых примитивов, ни категорий), поэтому `test/docs.test.ts` затронут не будет; если исполнитель добавит упоминание в README — только с валидными относительными ссылками.
9. **Фиксация**: по завершении — раздел в `.plans/txt2sfx-v0.md` (даты, отклонения, что проверено в браузере, состояние переводов).
