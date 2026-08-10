/**
 * English — the source of truth for every key in the playground.
 *
 * This file is the *only* place a key is invented. `Key` is derived from it, every other
 * locale is typed as a partial of that, and `t()` falls back here when a translation is
 * missing — so a half-finished locale degrades to English word by word instead of showing
 * a raw key, and a key deleted here fails to compile in all nine languages at once.
 *
 * ## What is translated, and what deliberately is not
 *
 * Chrome: buttons, headings, placeholders, tooltips, empty states and the instructional
 * captions. Those are the reason someone who does not read English is stuck.
 *
 * Not translated: the soundline language itself, recipe and layer names, category names
 * (`pop`, `cycle` — they are the validator's vocabulary and appear verbatim in the text
 * the user writes), units, and the diagnostics that come out of `@txt2sfx/core` and
 * `@txt2sfx/agent`. A validator hint is the same sentence the model is given; translating
 * one half of that pair would make the two disagree.
 *
 * Placeholders are `{name}`, substituted by `t()`. Anything already inside a key — a
 * glyph like `▶`, a number, a recipe name — stays out of the dictionary.
 *
 * @packageDocumentation
 */

export const en = {
  /* --- the top bar ------------------------------------------------------- */

  'nav.sounds': 'Sounds',
  'nav.studio': 'Studio',
  /* Not "Model", which named the technology and said nothing about what the screen is
     for. This one says what comes out of it: audio a neural model rendered from the
     prompt — a target to aim at, not a recipe. */
  'nav.render': 'AI Render',
  'nav.loop': 'NeurosLoop',
  'nav.screenAria': 'screen',

  'bridge.title': 'agent bridge & MCP status',
  'bridge.offline': 'bridge offline',
  'bridge.live': 'bridge live',
  'bridge.attached': 'agent attached',
  'bridge.notConnected': 'not connected',
  'bridge.noAgent': 'no agent yet',
  'bridge.tools': '{client} · {count} tools',

  'repo.label': 'GitHub',
  'repo.title': 'Read the source — the pipeline, the validator, the optimizer and the tests',
  'repo.star': 'Star',
  'repo.starTitle': 'Opens the repository on GitHub, where the star button is',

  'lang.aria': 'interface language',
  'lang.title': 'Interface language',

  /* --- the gallery ------------------------------------------------------- */

  'gallery.title': 'Describe a sound. Get code that plays it.',
  'gallery.lede': 'Nothing to ship but a few hundred bytes of Web Audio JavaScript.',
  'gallery.placeholder': 'rusty gate opening slowly, then a heavy latch',
  'gallery.describeAria': 'describe the sound',
  'gallery.generate': 'Generate',
  'gallery.step1': 'Type what you hear',
  'gallery.step2': 'Play it, tweak the wording',
  'gallery.step3': 'Copy the JavaScript into your game',
  'gallery.gotIt': 'Got it',
  'gallery.searchPlaceholder': 'search names, prompts and recipes',
  'gallery.searchAria': 'search the catalog',
  /* The second answer to the same box, under the first. Headed rather than mixed into
     the grid: a recipe is a few hundred bytes you can ship and a recording is somebody
     else's file under somebody else's licence, and one list would claim otherwise. */
  'gallery.freesoundHeading': 'Also on freesound.org',
  'gallery.freesoundHint': 'recordings somebody already made — a target to aim at, not something to ship',
  'gallery.all': 'all',
  'gallery.favorites': 'starred',
  'gallery.emptyCategory': 'Nothing in the catalog is a {category}.',
  'gallery.emptyFavorites': 'Nothing starred yet. The ★ on a card keeps it one click away in the studio.',
  'gallery.emptyQuery': 'Nothing in the catalog matches “{query}”.',
  'gallery.generateInstead': 'Generate it instead',
  /* Shown in place of the two Generate labels when nothing on the page can write a
     recipe: the press searches the bank and the bundled catalog instead, and the button
     says which of the two it is about to do. */
  'gallery.find': 'Find in bank',
  'gallery.findInstead': 'Find one in the bank instead',

  /* --- a card in the gallery --------------------------------------------- */

  'card.play': 'play',
  /* The star is this browser's own — the heart in the social row is the one other
     people see, and saying so here is what keeps the two from reading as one control. */
  'card.favorite': 'keep it — starred sounds get their own tab in the studio',
  'card.unfavorite': 'take the star back',
  'card.stop': 'stop',
  'card.noPrompt': 'no prompt recorded',
  'card.open': 'Open',
  'card.openTitle': 'open it in the studio — the editor, the sliders and the export',
  'card.downloadTitle': 'download {name} — pick a format',
  'time.justNow': 'just now',
  'card.edited': 'edited {when}',

  /* --- the social row on a published card, and the account behind it ------ */

  'card.likeTitle': 'like it — likes decide which recipes a model is shown as examples',
  'card.unlikeTitle': 'take the like back',
  'card.commentsTitle': 'read and answer — a reply can carry a sound',

  'account.signIn': 'sign in',
  'account.signInTitle': 'GitHub, for publishing, liking and replying. Accounts must be at least {days} days old.',
  'account.signOut': 'sign out',
  'account.left': '{count} left today',
  'account.standing': '{count} like(s) received; {left} more recipes today',
  'account.signedInAs': 'signed in as {login}',
  'account.signedOut': 'signed out',
  'account.errorTooNew': 'That GitHub account is too new to write here. The age limit is the whole spam defence; nothing else about the account matters.',
  'account.errorBanned': 'This account may read the bank but not write to it.',
  'account.errorCancelled': 'Sign-in cancelled.',
  'account.errorGeneric': 'Sign-in failed ({code}).',

  'comments.title': 'discussion — {name}',
  'comments.close': 'close',
  'comments.loading': 'reading the thread…',
  'comments.empty': 'Nothing here yet. A reply can carry a sound — that is the interesting kind.',
  'comments.placeholder': 'what would you change?',
  'comments.attach': 'reply with a version',
  'comments.attachedAria': 'the soundline attached to this reply',
  'comments.detach': 'drop the attached sound',
  'comments.rule': 'No links. Refer to a recipe as #12. An attached soundline is parsed, validated and rendered like any published recipe.',
  'comments.send': 'reply',
  'comments.sending': 'sending…',
  'comments.openInStudio': 'open in studio',
  'comments.signInFirst': 'Reading is open to everyone. Replying needs an account.',

  /* --- the studio rail ---------------------------------------------------- */

  'rail.new': 'New sound',
  'rail.recent': 'Recent',
  'rail.categories': 'Categories',
  'rail.favorites': 'Starred',
  'rail.favoritesCount': 'Starred · {count}',
  'rail.groupRecent': 'recent',
  'rail.groupFavorites': 'starred',
  'rail.emptyFavorites': 'Nothing starred yet. The ★ beside a name keeps it here across sessions.',
  'rail.emptyRecent': 'Nothing open yet. Pick a sound in the gallery, or start a new one.',
  'rail.unsaved': 'unsaved edits',

  /* --- NeurosLoop --------------------------------------------------------- */

  'loop.new': 'New soundtrack',
  'loop.soundtracks': 'soundtracks',
  'loop.bpm': '{bpm} bpm',
  'loop.compose': 'Compose',
  'loop.composing': 'Composing…',
  'loop.add': 'Add tracks',
  'loop.adding': 'Adding…',
  'loop.modeNew': 'New track',
  'loop.modeAdd': 'Add tracks',
  'loop.placeholderNew': 'describe the soundtrack, or build it from the chips below',
  'loop.placeholderMore': 'add anything the chips do not say',
  'loop.placeholderAdd': 'what should the new lanes add — e.g. counter-melody and light percussion',
  'loop.describeAria': 'describe the soundtrack',
  'loop.hintNew': 'chips add words to the brief; the brief decides tempo, key, register and lanes',
  'loop.hintAdd': 'existing lanes stay frozen — one or two new ones arrive to audition',
  /* With a model the prompt is a brief, not three keywords. Saying so is the difference
     between "why did it ignore my words" and knowing what the words can do. */
  'loop.hintNewModel': '{model} writes the score from the brief — tempo, key, parts and every note',
  'loop.hintAddModel': '{model} reads what is already playing and answers it — existing lanes stay frozen',
  'loop.byModel': 'composed by {model} · {attempts} trip(s) through the model',
  'loop.bySeed': 'composed by the built-in seeded composer',
  'loop.fellBack': 'the model’s score was not usable ({reason}) — this take is the seeded composer’s',
  'loop.authorModel': 'model-composed',
  'loop.authorSeed': 'seeded',
  /* The rows of chips. Each is the question that row answers. */
  'loop.group.mood': 'MOOD',
  'loop.group.motion': 'MOTION',
  'loop.group.texture': 'TEXTURE',
  'loop.group.kit': 'PARTS',
  'loop.group.place': 'PLACE',
  'loop.dropTag': 'take “{tag}” back out of the brief',
  /* The four phases. Present participles, because each one is a thing happening now — a
     phase named as a noun reads as a step in a diagram rather than as work in flight. */
  'loop.phase.writing': 'writing the score',
  'loop.phase.checking': 'checking it against the rules',
  'loop.phase.voicing': 'building the instruments',
  'loop.phase.mixing': 'mixing the loop',
  'loop.phase.trip': 'trip {attempt} of {trips}',
  'loop.phase.repairing': 'last score broke {rule} — asking for a fix',
  'loop.phase.chars': '{chars} characters back',
  'loop.meta': '{bars} bars · {length} loop · {lanes} lanes',
  'loop.play': 'Play loop',
  'loop.stop': 'Stop',
  'loop.seamless': '∞ seamless loop',
  /* Dev-only, and worded as what it is rather than as a feature: `GM bank` is the comparison,
     `synth` is the product. Neither label promises the bank can be exported. */
  'loop.bankOff': 'GM bank',
  'loop.bankOn': 'GM bank · on',
  'loop.stems': 'Export stems · {count}×',
  'loop.stemsSaved': 'saved {count} stems of {name}',
  'loop.mute': 'mute this lane',
  'loop.unmute': 'unmute this lane',
  'loop.laneNew': 'new',
  'loop.keep': 'keep',
  'loop.retryTitle': 'compose this lane again',
  'loop.discardTitle': 'discard this lane',
  'loop.progress': '{done}/{total} lanes',
  'loop.facts': '{voices} voices · {notes} hits · peak {peak}',
  'loop.headroom': 'mix turned down {db} dB to fit',
  'loop.noSpare': 'Every lane this track can be offered is already here. Compose a new track instead.',

  /* One line per lane, because these seconds are when you find out whether what is
     being built is what you asked for. */
  'loop.msg.drums': 'laying the drum grid…',
  'loop.msg.perc': 'sprinkling percussion…',
  'loop.msg.bass': 'voicing the bass…',
  'loop.msg.chords': 'spreading the chords…',
  'loop.msg.keys': 'comping the keys…',
  'loop.msg.epiano': 'warming the electric piano…',
  'loop.msg.organ': 'pulling the drawbars…',
  'loop.msg.stabs': 'cutting the stabs…',
  'loop.msg.guitar': 'plugging in the guitar…',
  'loop.msg.riff': 'chugging out the riff…',
  'loop.msg.brass': 'lining up the brass…',
  'loop.msg.lead': 'writing the lead line…',
  'loop.msg.arp': 'winding the arp…',
  'loop.msg.bells': 'hanging the bells…',
  'loop.msg.fx': 'placing the fx hits…',
  'loop.msg.pads': 'stretching the pads…',
  'loop.msg.strings': 'bowing the strings…',
  'loop.msg.choir': 'raising the choir…',
  'loop.msg.drone': 'settling the drone…',
  'loop.msg.air': 'letting the air in…',
  'loop.msg.generic': 'writing {lane}…',

  /* --- the studio -------------------------------------------------------- */

  'studio.soundline': 'Soundline',
  'studio.compare': 'Compare A / B',
  'studio.viewAria': 'view',
  'studio.hintCompare': 'numeric, not perceptual — it ranks candidates, it does not judge them',

  /* --- the AI Render screen ----------------------------------------------- */

  'render.title': 'AI Render',
  'render.hint': 'the same prompt answered by a diffusion model, on this machine — a target for Compare, not a deliverable',
  /* The studio with no recipe in it yet — a run started from the gallery. */
  'studio.composing': 'Writing a recipe for this prompt. The editor, the sliders and the export appear here as soon as one exists.',
  'studio.composingIdle': 'Nothing came back from that run. Press Make sound to try again, or pick a recipe from the list on the left.',
  'studio.edited': ' · edited {when}',
  'studio.unsaved': ' · unsaved',

  /* --- the prompt row ----------------------------------------------------- */

  'prompt.placeholder': 'a heavy metal door slamming shut in a corridor',
  'prompt.describeAria': 'describe the sound',
  /* The gear beside the button. Who answers is on hover; the one state that has to be
     visible without hovering is nobody answering, and the icon goes amber for that. */
  'prompt.settingsAria': 'model settings',
  'prompt.modelTitleAgent': 'your coding agent answers this prompt — click for the settings',
  'prompt.modelTitleGemini': 'Gemini answers this prompt, with your key — click for the settings',
  'prompt.noModelTitle': 'attach a coding agent or paste a Gemini key — click to set it up',
  'prompt.stop': 'Stop',
  'prompt.stopping': 'stopping…',
  'prompt.make': 'Make sound',
  /* The button runs whichever screen it is on, so what it will do is said on hover
     rather than guessed from the accent colour. */
  'prompt.runsSoundline': 'writes a new recipe for this prompt and fits its numbers',
  'prompt.runsModel': 'renders this prompt with the diffusion model, on this machine',
  'prompt.modelMissing': 'the model is not installed yet — the button for that is below',
  /* With nothing able to write a recipe, the button searches for one instead — and says
     so in the label rather than promising a sound that will not be made. The gear stays
     amber beside it: there is still no model, which is the fact it reports. */
  'prompt.find': 'Find in bank',
  'prompt.runsRetrieve':
    'searches the bank and the bundled catalog for a recipe that already answers this — it does not write a new one',

  /* --- the run strip ------------------------------------------------------ */

  /* The three sentences that keep retrieval from reading as generation. `retrieved, not
     generated` is not a caveat in small print — it is the whole difference. */
  'run.retrieveSearching': '⌕ no model attached and no key — searching the bank instead',
  'run.retrieved': '● “{name}” loaded from the bank — retrieved, not generated',
  'run.retrievedLocal': '● “{name}” loaded from the bundled catalog — retrieved, not generated',
  'run.retrieveMissed': '● nothing matched — nothing was retrieved, and nothing was generated',
  'run.retrieveNothing':
    'Nothing in the bank or the bundled catalog answers that. Attach a coding agent to the bridge, or paste a Gemini key, to have a recipe written for it — the gear beside the button opens both.',

  'run.accepted': 'accepted',
  'run.notAccepted': 'not accepted — {outcome}',
  'run.distance': ' · distance {distance}',
  'run.distanceToRef': ' · distance {distance} to reference',
  'run.noExamples': ' · no few-shot examples',
  'run.examples': ' · {count} example(s)',
  'run.fallback': ' (fallback, unrelated)',
  'run.hide': 'hide',
  'run.steps': '{count} steps',

  /* --- the fit preview ---------------------------------------------------- */

  'fit.leader': 'leader',
  'fit.leaderTitle': 'play the candidate on screen',
  'fit.take': 'take it',
  'fit.takeTitle': 'stop the search and edit this candidate by hand',
  'fit.waiting': 'the search runs on this thread — the picture lands between generations',
  'fit.asRendered': '{ms} ms as rendered',
  'fit.rendering': 'rendering the leader…',

  /* --- the sound panel ---------------------------------------------------- */

  'sound.master': 'master',
  'sound.play': 'Play',
  'sound.loop': 'Loop',
  'sound.loopTitle': 'loop the offline render',
  'sound.favorite': 'Keep',
  'sound.share': 'Share',

  /* --- the recipe card ---------------------------------------------------- */

  'editor.aria': 'soundline source',
  'soundline.title': 'SOUNDLINE',
  'soundline.errorsOne': '{count} syntax error',
  'soundline.errorsMany': '{count} syntax errors',
  'soundline.invariant': '{count} invariant broken',
  'soundline.warningsOne': '{count} warning',
  'soundline.warningsMany': '{count} warnings',
  'soundline.clean': 'validator clean',
  'soundline.allGood': 'Every decay fits inside the declared duration and the render sits below clipping.',
  'soundline.more': 'everything else',

  /* --- the slots card ----------------------------------------------------- */

  'slots.title': 'SLOTS',
  'slots.stop': 'Stop',
  'slots.stopTitle': 'stop the search and keep the best it found',
  'slots.fit': 'Fit to B',
  'slots.fitTitle': 'fit every ~slot to the loaded reference',
  'slots.teachBefore': 'No ',
  'slots.teachAfter': ' slots here. Write a number as {example} to make it a knob and hand it to the optimizer.',
  'slots.fitting': 'fitting…',
  'slots.generation': 'generation {n}/{total} · distance {distance}',
  'slots.noSlots': ' — no ~slots to fit',
  'slots.variation': 'Variation',
  'slots.variationTitle': 'roll every ~slot inside its own range',
  'slots.variationBlocked': 'there are no ~slots to roll',

  /* --- the master sliders -------------------------------------------------- */

  'master.title': 'MASTER',
  'master.pitch': 'pitch',
  'master.length': 'length',
  'master.brightness': 'brightness',
  'master.noFreq': 'this recipe has no frequency to move',
  'master.noFilters': 'this recipe has no lp/hp filter to move',
  'master.fork': 'to a new one',
  'master.forkTitle': 'Copy this recipe, as it now sounds, into a new one of this session — the masters re-centre on it and the original keeps its numbers',
  'master.forkBlocked': 'nothing to copy',
  'master.forked': 'copied into {name}',

  /* --- the export card ---------------------------------------------------- */

  'export.title': 'EXPORT',
  'export.copyJs': 'Copy JS',
  'export.copySoundline': 'Copy soundline',
  'export.noCompile': 'The recipe does not compile, so there is nothing to size yet.',
  'export.of': '{used} of {budget}',
  'export.nodes': '{count} nodes',
  'export.buffers': '{count} buffers',
  'export.peak': 'peak {value}',
  'export.seed': 'seed {value}',
  'export.compare': 'Compare A / B ↑',

  /* --- the download split button ------------------------------------------ */

  'format.download': 'Download',
  'format.encoding': 'Encoding…',
  'format.downloadTitle': 'download {label}',
  'format.chooseAria': 'choose a format',

  /* --- the model view ----------------------------------------------------- */

  'model.looking': 'Looking for a model on this machine…',
  'model.noBridge':
    'This view renders a reference from the same prompt with Stable Audio Open Small, on your machine. Nothing here is listening yet — run {command} in a terminal and this page will find it. Under {dev} the dev server answers instead.',
  'model.noBridgeWhy':
    'The model is a local program, not a service we host: the bridge is how a page reaches one. It also installs the model for you, from the button that appears once it is running.',
  'model.recheck': 'Check again',

  'model.setupTitle': 'Install the reference model',
  'model.stage.unavailable':
    'This bridge carries no copy of the installer. Upgrade txt2sfx-bridge, or point TXT2SFX_STABLE_AUDIO_DIR at a checkout of test/stable-audio.',
  'model.stage.needsPython':
    'Nothing on this machine can build the environment yet. Install uv — `winget install --id astral-sh.uv`, or `pip install uv` — and check again; it fetches the CPython 3.10 the toolkit pins, so no system Python is touched.',
  'model.stage.needsVenv':
    'Not installed yet. One button builds an isolated CPython 3.10 environment and downloads the checkpoint. It runs once; every render after it is offline.',
  'model.stage.needsWeights':
    'The environment is ready and the weights are not on this machine yet — about 1.7 GB, into the shared Hugging Face cache.',
  'model.stage.ready': 'Installed and ready.',
  'model.licenceStep': 'Accept the Stability AI Community License at',
  'model.tokenStep': 'Create a read token at',
  'model.pasteStep': 'Paste it below. It travels with this one request and is never stored.',
  'model.token': 'Hugging Face token',
  'model.tokenFound': 'already found ({source})',
  'model.repo': 'Repo',
  'model.repoHint':
    'Leave empty for the official checkpoint. A community mirror of the same weights needs no token and no licence click — the licence still governs what you do with the audio.',
  'model.install': 'Download and install',
  'model.installCaption':
    'A few gigabytes, once, over your own connection. Every line the installer prints is shown below — including anything that stops it.',
  'model.factWeights': 'weights',
  'model.factEnv': 'environment',
  'model.factVia': 'served by',
  'model.viaBridge': 'the local bridge',
  'model.viaDev': 'the dev server',
  'model.notDownloaded': 'not downloaded',
  'model.notInstalled': 'not installed',
  'model.nothing': 'nothing rendered',
  'model.seconds': 'seconds',
  'model.seed': 'seed {value}',
  'model.play': 'Play',
  'model.stop': 'Stop',
  'model.generating': 'generating',
  'model.compare': 'Compare with the recipe',
  'model.caption':
    'Rendered audio from the same prompt — no recipe, nothing to tune, and one to two megabytes where the recipe is under a kilobyte. It is here to be a target: A/B it, and tick “fit the numbers to the reference” to point the optimizer at it.',
  'model.promptFirst': 'type a prompt first — the model answers the same sentence our loop does',
  'model.captionRewrite': 'Rewrite',
  'model.captionHint':
    'What this model actually reads: English, and at most 64 t5 tokens — about {limit} characters. Rewrite turns the prompt above into exactly that, in place, and leaves it yours to edit.',
  'model.captionWriting': 'writing the caption…',
  'model.captionNoProvider':
    'No model here can write one: pick Gemini or Anthropic in the prompt row, or attach your coding agent over the bridge. Until then the prompt is sent as written.',
  'model.captionCount': '{count}/{limit} characters',
  'model.captionFailed': 'no caption written ({reason}) — sending the prompt as it is',
  'model.named': 'named “{title}” · {file}',

  /* --- the renders this browser kept -------------------------------------- */

  'renders.title': 'RENDERS',
  'renders.empty':
    'Every render stays here — named, playable and downloadable — until you clear it. Nothing is written outside the browser.',
  'renders.unnamed': 'unnamed',
  'renders.downloadTitle': 'download {file} · {size}',
  'renders.forget': 'forget this render',
  'model.captionScript':
    'This model reads no script but Latin — every other one tokenizes into holes and renders as noise. Write the caption in English.',
  'model.captionLength': 'Past {limit} characters the text encoder drops the rest without saying so.',

  /* --- the library, on the gallery ---------------------------------------- */

  /* The label names what the click actually does. It used to say "Search on
     freesound.org", which is the purpose — but the control looked like a search field
     and pressing it left the page for an OAuth consent screen, and a button that does
     something other than what it says is worse than one that names a price. The purpose
     moved to the `?` beside it, where it is read by whoever wants it. Once connected
     the control stops being a verb and becomes the state, with the undo beside it. */
  'search.connect': 'Connect to Freesound.org',
  'search.connectHelp':
    'OAuth authorization. Freesound.org asks for your password on their own page, never here, and hands this tab a token you can revoke from either side. With an account connected you can search freesound.org alongside the catalog and use a recording as a reference to fit against.',
  'search.connectNote':
    'Sign in with your own freesound.org account. Their API answers for accounts, not for keys — and with yours connected the download button hands over the original file, not a preview. Read more at',
  'search.connected': 'freesound.org connected',
  'search.disconnect': 'disconnect',
  'search.connectedNote': 'kept in this browser until you disconnect',
  'search.noBank':
    'This bank has no freesound.org application configured, so it cannot connect an account. A bank set up for it offers the button here.',
  'search.connCancelled': 'Connection cancelled — nothing was shared.',
  'search.connFailed': 'freesound.org did not finish the connection. Try again.',
  'search.cc0': 'CC0 only',
  'search.cc0Title': 'public domain — nothing to credit, nothing to track',
  'search.anyLicence': 'all licences',
  'search.anyLicenceTitle': 'includes sounds that must be credited wherever they end up',
  'search.anyLength': 'any length',
  'search.under': '≤ {seconds}s',
  'search.searchedFor': 'searched for',
  'search.rewritten': 'written by the model',
  'search.found': '{count} in the library, {shown} here',
  'search.searching': 'searching…',
  'search.idle': 'Type in the search box above and recordings of it appear here.',
  'search.nothing': 'Nothing matched. Try “all licences”, a longer length, or plainer words.',
  'search.play': 'play the preview',
  'search.stop': 'stop',
  'search.playFail': 'the preview for {name} would not play',
  'search.useTitle': 'load it as the B side and compare',
  'search.creditTitle': 'copy the credit line',
  'search.credit': 'the credit line',
  'search.pageTitle': 'open its page on freesound.org',
  'search.saved': 'saved {file} · {size}',
  'search.savedOriginalInstead':
    'This browser cannot decode that file, so {file} was saved as uploaded instead of converted.',
  'search.licenceFree': 'public domain — no obligation',
  'search.licenceBound': 'must be credited wherever this ends up — the © button copies the line',
  'search.errToken':
    'freesound.org refused this connection. It may have expired — connect the account again.',
  'search.errThrottled': 'freesound.org is throttling this account. Wait a minute and search again.',
  'search.errNetwork': 'Could not reach freesound.org. Check the connection and try again.',
  'search.errHttp': 'freesound.org refused the search.',
  'search.caption':
    'A target, not a deliverable: what you download is somebody else’s recording under the licence on its badge, and the preview is what plays here.',

  /* --- the compare view --------------------------------------------------- */

  'compare.bIs': 'B is a',
  'compare.model': 'Model render',
  'compare.library': 'Library',
  'compare.file': 'File',
  'compare.take': 'Another take',
  'compare.record': 'Microphone',
  'compare.recordStop': 'Stop recording',
  'compare.recordFit': 'Record → Fit',
  'compare.modelBlocked': 'needs the local diffusion model — this opens AI Render, where it installs',
  'compare.nothingLoaded': 'nothing loaded',
  'compare.hintModel': 'rendered by a diffusion model from the same prompt — a target, not a competitor',
  'compare.hintLibrary': 'a recording from freesound.org — preview quality, under the licence its row states',
  'compare.hintUpload': 'your own file, onset-aligned and peak-normalized on load',
  'compare.hintTake': 'the same recipe with a different seed — how much of this sound is the design?',
  'compare.hintRecord':
    'made just now on your microphone, with the browser’s noise suppression and auto-gain off — they would filter out what the fit is trying to match',
  'compare.colour': 'COLOUR',
  'compare.dropzone':
    'Nothing to compare against yet. Drop an audio file here, pick “{take}” to render this recipe with a new seed, or {model}.',
  'compare.dropzoneModelReady': 'let the local model render a target',
  'compare.dropzoneModelMissing': 'install the local model on the AI Render tab',
  'compare.dropzoneLibrary': 'or find a recording of it on freesound.org, from the Sounds page',
  'compare.candidate': 'candidate',
  'compare.alignment':
    'both onsets shifted to {onset} ms · peak-normalized · log frequency {min} Hz – {max}',
  'compare.numeric':
    'Numeric, not perceptual — it ranks candidates, it does not judge them. Both signals are peak-normalized and onset-aligned, so the distance cannot tell “this sound, closer” from “a different sound that scores well”.',
  'compare.metric': 'METRIC',
  'compare.copyPicture': 'Copy picture',
  'compare.copyNumbers': 'Copy numbers',
  'compare.fitSlots': 'Fit slots to B',
  'compare.match': 'Generate against B',
  'compare.matchTitle':
    'Aim the next generation at this reference: the model designs, and the optimizer fits its numbers to B instead of to the design alone',
  'compare.copiedPicture': 'copied the picture',
  'compare.clipboardRefused': 'the clipboard refused an image — saved a PNG instead',

  'metric.peak': 'peak',
  'metric.duration': 'duration to −60 dB',
  'metric.attack': 'attack to peak',
  'metric.dominant': 'dominant partial',
  'metric.centroid': 'centroid',
  'metric.flatness': 'flatness',
  'metric.band': 'band {range}',

  'mode.tracks': 'Tracks',
  'mode.channels': 'Channels',
  'mode.hsv': 'HSV',
  'mode.diff': 'Diff',
  'legend.tracks': 'hue = which layer owns this point · brightness = energy',
  'legend.channels':
    'R = noisiness · G = level · B = frequency height — a fixed axis per channel, so the colour itself names the character',
  'legend.hsv': 'hue = dominant layer · saturation = tonal vs noisy · brightness = energy',
  'legend.diff': 'cyan = candidate louder than the reference · amber = quieter · grey = matched',
  'swatch.noisy': 'noisy / desaturated',
  'swatch.loudNoisy': 'loud + noisy',
  'swatch.noisyHighs': 'noisy highs',
  'swatch.loudTonalLows': 'loud tonal lows',
  'swatch.silence': 'silence',
  'swatch.aLouder': 'A louder',
  'swatch.matched': 'matched',
  'swatch.bLouder': 'B louder',

  /* --- the share screen --------------------------------------------------- */

  'share.back': '← back to studio',
  'share.copyLink': 'Copy link',
  'share.linkCaption':
    'Opens a page that plays the sound the moment it loads. The recipe travels inside the link, so nothing has to stay up for it to keep working and no key is needed to listen — which is also why it is long.',
  'share.copyJs': 'Copy JS',
  'share.copySoundline': 'Copy soundline',
  'share.copyImage': 'Copy image',
  'share.savePng': 'Save PNG',
  'share.copiedCard': 'copied the card',
  'share.pngInstead': 'the clipboard refused an image — use Save PNG',
  'share.savedPng': 'saved {file}',
  'share.moreLines': '… {count} more line(s)',

  /* --- the model dialog --------------------------------------------------- */

  'dialog.bridgeAria': 'model and local agent bridge',
  'dialog.close': 'close',
  'dialog.bridgeTitle': 'Model',
  /* The outcome first: whether the next press has a model, and which one. */
  'dialog.answersAgent': 'Your coding agent ({client}) answers, over the local bridge. No key is involved and nothing leaves this machine.',
  'dialog.answersGemini': 'Gemini answers, with your key, as {model}. Attach a coding agent below and it takes over instead.',
  'dialog.answersNobody':
    'Nothing can answer a prompt yet. Attach a coding agent to the bridge — the steps are below — or paste a Gemini key.',
  'dialog.tabsAria': 'who holds the model',
  'dialog.keyTitle': 'Gemini key, for when no agent is attached',
  'dialog.key': 'key',
  'dialog.keyPlaceholder': 'your Gemini key',
  'dialog.modelId': 'model id',
  'dialog.forget': 'forget it',
  'dialog.keyNote': 'The key goes to Google and nowhere else — no proxy, no server of ours in the path · get one at {source}',
  'dialog.keyIdle': 'It is idle right now: an attached agent always wins.',
  'dialog.keyStorage':
    'It is kept on this machine so you do not paste it again: encrypted in this browser’s IndexedDB under a key nothing can export — never in localStorage, never uploaded. Any script served from this page could still use it, which lib/keystore.ts spells out.',
  'dialog.keyStorageNone':
    'This browser cannot store it, so the key lives in this tab only and a reload will ask for it again.',
  /* The one tab whose client installs nothing. Its lede has to do the work the health
     checks do on every other tab — say what this door can and cannot do — because a chat
     has no daemon to report on and no tools to list. */
  'dialog.chatTab': 'Any chat',
  'dialog.chatTitle': 'Paste this into a chat that can fetch a URL',
  'dialog.chatLede':
    'ChatGPT, Gemini, Claude — anything with a web-fetch button can search this bank and hand you a sound. It reads its own instructions from the link, so the paste stays one line and never goes stale.',
  'dialog.chatNote':
    'It searches, links you here and repeats the soundline back — it does not design. A chat cannot hear, cannot measure and cannot be told which invariant it broke; the ear in that loop is yours.',
  'dialog.chatWhat': 'the chat prompt',
  'dialog.bridgeLedeLive':
    'The bridge runs on your machine and lets a coding agent design, render, audition and export sounds here — with no API key, because the agent already has a model. It can also answer this playground’s own Generate button.',
  'dialog.bridgeLedeDead':
    'Nothing is listening on {host}. Register the server below and your client starts the bridge itself — in either direction.',
  'dialog.checkDaemon': 'Bridge daemon',
  'dialog.checkProtocol': 'Wire protocol',
  'dialog.checkAgent': 'Agent attached',
  'dialog.checkRenderer': 'Renderer',
  'dialog.noResponse': 'no response',
  'dialog.registerBelow': 'register the MCP server below',
  'dialog.mcpClient': 'MCP client',
  'dialog.thisTab': 'this tab · 44.1 kHz',
  'dialog.rendererNone': 'none — validate only',
  'dialog.step1': 'Point your agent at the bridge',
  'dialog.step2': 'Ask the agent to introduce itself',
  'dialog.step2note':
    'sfx_contract hands over the whole grammar in one call. No API key is involved anywhere: your agent is the model.',
  'dialog.recheck': 'Re-check',
  'dialog.checking': 'Checking…',
  'dialog.daemonAria': 'bridge daemon URL',
  'dialog.copyWhat': 'copy {what}',
  'dialog.setupOf': 'the {client} setup',
  'dialog.firstAsk': 'the first ask',
  'dialog.noteClaude':
    'That is the whole install — no daemon to start first. Add `-s user` after `add` to have it in every project. Restart Claude Code afterwards: it reads its server list at startup.',
  'dialog.claudeModel': 'Or: Claude Code as the model here',
  'dialog.claudeModelWhat': 'the claude-as-model command',
  'dialog.claudeModelNote':
    'The same bridge, the other way round: this command answers this page’s Generate with the claude CLI already on your machine, so the “agent” provider works with no MCP client and no restart. Add --model opus to choose the model. Leave it running; Ctrl+C stops it.',
  'dialog.noteCodex':
    'Writes [mcp_servers.txt2sfx] into ~/.codex/config.toml and starts the bridge on first use. Restart codex afterwards.',
  'dialog.noteOpencode':
    'opencode has no add command, so the file is the interface — and its key is `mcp` with type "local", not `mcpServers`. Restart opencode afterwards.',
  'dialog.noteCursor': 'Settings → MCP → New MCP server writes the same file. Reload the window afterwards.',
  'dialog.noteOther':
    'Claude Desktop, Windsurf, Zed and most other clients take this shape; only the path to the file differs. Anything that speaks MCP over stdio can run it.',
  'dialog.fileOpencode': 'opencode.json — in the project, or ~/.config/opencode/',
  'dialog.fileCursor': '~/.cursor/mcp.json — or .cursor/mcp.json for one project',

  /* --- the session bar and its verdicts ------------------------------------ */

  'app.seed': 'seed',
  'app.rnd': 'rnd',
  'app.rndTitle': 'new random seed',
  'app.publish': 'Publish',
  'app.saved': 'saved {path}',
  'app.published': 'published as #{id}',
  'app.alreadyPublished': 'already in the bank as #{id}',
  'app.nothingRendered': 'nothing rendered yet — fix the recipe first',
  'app.doesNotParse': '{name} does not parse — open it to see why',
  'app.take': 'take · seed {seed}',

  'blocked.noB': 'pick a B side in Compare A / B first',
  'blocked.noParse': 'the recipe does not parse',
  'blocked.noSlots': 'this recipe has no ~slots to fit',

  'warn.clipped': 'mix peaks at {peak}, above the {limit} limit — lower a layer’s gain rather than normalizing',
  'warn.longer': 'sound runs ~{actual}ms but the header declares {declared}ms',
  'warn.overBudget': 'export is {bytes} B, over the {budget} B budget',
  'warn.decodeFail': 'could not decode {file}: {error}',
  'warn.micDenied': 'no recording was made: {error}',

  /* --- download and clipboard verdicts ------------------------------------- */

  'dl.saved': 'saved {file}',
  'dl.savedSize': 'saved {file} · {size}',
  'dl.noCompile': 'the recipe does not compile — nothing to export',
  'dl.nothingRendered': 'nothing rendered yet',
  'dl.renderFail': 'this recipe could not be rendered: {error}',
  'dl.encodeFail': 'this browser could not encode {format}: {error} — WAV always works',
  'dl.copied': 'copied {what}',
  'dl.clipboardRefused': 'the browser refused clipboard access — select the text instead',
  'what.js': 'the JavaScript',
  'what.soundline': 'the soundline',
  'what.link': 'the link',
  'what.numbers': 'the numbers as markdown',
} as const;

/** Every string the playground can show. Invented here and nowhere else. */
export type Key = keyof typeof en;
