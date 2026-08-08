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
  'gallery.all': 'all',
  'gallery.trash': 'trash',
  'gallery.emptyTrash': 'Trash is empty.',
  'gallery.emptyCategory': 'Nothing in the catalog is a {category}.',
  'gallery.emptyQuery': 'Nothing in the catalog matches “{query}”.',
  'gallery.generateInstead': 'Generate it instead',

  /* --- a card in the gallery --------------------------------------------- */

  'card.trash': 'trash',
  'card.restore': 'restore',
  'card.trashTitle': 'hide it from the gallery — the file is not touched',
  'card.restoreTitle': 'put it back in the gallery',
  'card.play': 'play',
  'card.stop': 'stop',
  'card.noPrompt': 'no prompt recorded',
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
  'rail.trash': 'Trash',
  'rail.trashCount': 'Trash · {count}',
  'rail.groupRecent': 'recent',
  'rail.groupTrash': 'trash',
  'rail.emptyTrash': 'Trash is empty.',
  'rail.emptyRecent': 'Nothing here yet.',
  'rail.unsaved': 'unsaved edits',
  'rail.restore': 'restore',
  'rail.moveToTrash': 'move to trash',

  /* --- the studio -------------------------------------------------------- */

  'studio.soundline': 'Soundline',
  'studio.model': 'Model',
  'studio.search': 'Search',
  'studio.compare': 'Compare A / B',
  'studio.viewAria': 'view',
  'studio.hintCompare': 'numeric, not perceptual — it ranks candidates, it does not judge them',
  'studio.hintModel': 'rendered audio from the same prompt — no recipe, nothing to tune',
  'studio.hintSearch': 'recordings somebody already made — a target to aim at, not something to ship',
  'studio.edited': ' · edited {when}',
  'studio.unsaved': ' · unsaved',

  /* --- the prompt row and the provider popover ---------------------------- */

  'prompt.placeholder': 'a heavy metal door slamming shut in a corridor',
  'prompt.describeAria': 'describe the sound',
  'prompt.providerTitle': 'which model answers, and with which key',
  'prompt.noAgentDot': 'no agent attached',
  'prompt.model': 'model',
  'prompt.modelId': 'model id',
  'prompt.modelIdAria': 'model id',
  'prompt.key': 'key',
  'prompt.keyPlaceholder': 'your {provider} key — this tab only',
  'prompt.keyAria': '{provider} API key',
  'prompt.remember': 'remember this key',
  'prompt.rememberTitle':
    'Encrypted with a non-extractable key in IndexedDB — not localStorage. Any script on this origin could still use it: see lib/keystore.ts.',
  'prompt.forget': 'forget',
  'prompt.match': 'fit the numbers to the reference',
  'prompt.matchTitle': 'load a reference in Compare A / B first',
  'prompt.stop': 'Stop',
  'prompt.stopping': 'stopping…',
  'prompt.make': 'Make sound',
  /* The button runs whichever tab is open, so what it will do is said on hover rather
     than guessed from the accent colour. */
  'prompt.runsSoundline': 'writes a new recipe for this prompt and fits its numbers',
  'prompt.runsModel': 'renders this prompt with the diffusion model, on this machine',
  'prompt.modelMissing': 'the model is not installed yet — the Model tab has the button',
  'prompt.runsSearch': 'searches freesound.org for a recording of this',
  'prompt.searchMissing': 'paste a freesound.org API key in the Search tab first',
  'prompt.noteMock':
    'answers from the recipes in the catalog — no network, no key, and the validator, render, optimizer and export all still run',
  'prompt.noteAgentReady':
    'the request goes to your coding agent over the local bridge — no key, and nothing leaves this machine',
  'prompt.noteAgentMissing':
    'no agent is attached to the bridge yet — open the badge in the header for the two commands',
  'prompt.noteBridge': 'the request waits for window.txt2sfx.reply(id, text) in devtools — no network',
  'prompt.noteKey': 'the key lives in this tab only and goes nowhere but {provider}',
  'prompt.noteKeySource': ' · get one at {url}',

  /* --- the run strip ------------------------------------------------------ */

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
  'sound.trash': 'Trash',
  'sound.trashTitle': 'hide it from the gallery',
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
  'model.render': 'Render target',
  'model.compare': 'Compare with the recipe',
  'model.caption':
    'Rendered audio from the same prompt — no recipe, nothing to tune, and one to two megabytes where the recipe is under a kilobyte. It is here to be a target: A/B it, and tick “fit the numbers to the reference” to point the optimizer at it.',
  'model.promptFirst': 'type a prompt first — the model answers the same sentence our loop does',
  'model.captionLabel': 'caption',
  'model.captionRewrite': 'Rewrite',
  'model.captionHint':
    'What this model actually reads: English, and at most 64 t5 tokens — about {limit} characters. Written from your prompt when you press Render, and yours to edit.',
  'model.captionWriting': 'writing the caption…',
  'model.captionNoProvider':
    'No model here can write one: pick Gemini or Anthropic in the prompt row, or attach your coding agent over the bridge. Until then the prompt is sent as written.',
  'model.captionCount': '{count}/{limit} characters',
  'model.captionByModel': 'written by the model',
  'model.captionByHand': 'edited by hand',
  'model.captionFailed': 'no caption written ({reason}) — sending the prompt as it is',
  'model.captionScript':
    'This model reads no script but Latin — every other one tokenizes into holes and renders as noise. Write the caption in English.',
  'model.captionLength': 'Past {limit} characters the text encoder drops the rest without saying so.',

  /* --- the search view ---------------------------------------------------- */

  'search.keyLabel': 'freesound.org key',
  'search.keyPlaceholder': 'API key',
  'search.keyAria': 'freesound.org API key',
  'search.remember': 'remember',
  'search.rememberTitle': 'encrypted in this browser under a key that cannot be exported',
  'search.forget': 'forget',
  'search.getKey': 'get a key ↗',
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
  'search.needsKey': 'Paste a freesound.org key above. Requests go from this tab to the library and nowhere else.',
  'search.idle': 'Describe the sound in the box above and press Make sound.',
  'search.nothing': 'Nothing matched. Try “all licences”, a longer length, or plainer words.',
  'search.play': 'play the preview',
  'search.stop': 'stop',
  'search.playFail': 'the preview for {name} would not play',
  'search.useTitle': 'load it as the B side and compare',
  'search.downloadTitle': 'download the preview (mp3)',
  'search.creditTitle': 'copy the credit line',
  'search.credit': 'the credit line',
  'search.pageTitle': 'open its page on freesound.org',
  'search.saved': 'saved {file} · {size}',
  'search.downloads': '{count} downloads',
  'search.licenceFree': 'public domain — no obligation',
  'search.licenceBound': 'must be credited wherever this ends up — the © button copies the line',
  'search.errKey': 'freesound.org refused the key. Check it, or get a new one from the link above.',
  'search.errThrottled': 'freesound.org is throttling this key. Wait a minute and search again.',
  'search.errNetwork': 'Could not reach freesound.org. Check the connection and try again.',
  'search.errHttp': 'freesound.org refused the search.',
  'search.caption':
    'A target, not a deliverable: the button downloads the preview (mp3), and the original lives on the sound’s own page under the licence on its badge.',

  /* --- the compare view --------------------------------------------------- */

  'compare.bIs': 'B is a',
  'compare.model': 'Model render',
  'compare.library': 'Library',
  'compare.file': 'File',
  'compare.take': 'Another take',
  'compare.modelBlocked': 'needs the local diffusion model — install it from the Model tab',
  'compare.nothingLoaded': 'nothing loaded',
  'compare.hintModel': 'rendered by a diffusion model from the same prompt — a target, not a competitor',
  'compare.hintLibrary': 'a recording from freesound.org — preview quality, under the licence its row states',
  'compare.hintUpload': 'your own file, onset-aligned and peak-normalized on load',
  'compare.hintTake': 'the same recipe with a different seed — how much of this sound is the design?',
  'compare.colour': 'COLOUR',
  'compare.dropzone':
    'Nothing to compare against yet. Drop an audio file here, pick “{take}” to render this recipe with a new seed, or {model}.',
  'compare.dropzoneModelReady': 'let the local model render a target',
  'compare.dropzoneModelMissing': 'install the local model in the Model tab',
  'compare.dropzoneLibrary': 'or find a recording of it in the Search tab',
  'compare.candidate': 'candidate',
  'compare.alignment':
    'both onsets shifted to {onset} ms · peak-normalized · log frequency {min} Hz – {max}',
  'compare.numeric':
    'Numeric, not perceptual — it ranks candidates, it does not judge them. Both signals are peak-normalized and onset-aligned, so the distance cannot tell “this sound, closer” from “a different sound that scores well”.',
  'compare.metric': 'METRIC',
  'compare.copyPicture': 'Copy picture',
  'compare.copyNumbers': 'Copy numbers',
  'compare.fitSlots': 'Fit slots to B',
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

  /* --- the bridge dialog -------------------------------------------------- */

  'dialog.bridgeAria': 'local agent bridge',
  'dialog.close': 'close',
  'dialog.bridgeTitle': 'Local agent bridge',
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
  'dialog.agentAria': 'agent',
  'dialog.copyPrompt': 'Copy agent prompt',
  'dialog.copyPromptTitle': 'Paste it into your agent — it registers the server itself and makes the first sound',
  'dialog.recheck': 'Re-check',
  'dialog.checking': 'Checking…',
  'dialog.daemon': 'daemon',
  'dialog.daemonAria': 'bridge daemon URL',
  'dialog.copyWhat': 'copy {what}',
  'dialog.setupOf': 'the {client} setup',
  'dialog.firstAsk': 'the first ask',
  'dialog.agentPrompt': 'the agent prompt',
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
  'app.save': 'Save',
  'app.saveTitle': 'write examples/<name>.soundline',
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

  /* --- download and clipboard verdicts ------------------------------------- */

  'dl.saved': 'saved {file}',
  'dl.savedSize': 'saved {file} · {size}',
  'dl.noCompile': 'the recipe does not compile — nothing to export',
  'dl.nothingRendered': 'nothing rendered yet',
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
