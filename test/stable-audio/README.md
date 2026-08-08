# Stable Audio Open Small — reference baseline

A/B harness for txt2sfx: render the same prompt with a diffusion model so the procedural
result has something to be judged against. Nothing here is part of the build, the tests or
the shipped packages — it is a comparison tool that happens to live in the repo.

```bash
python test/stable-audio/run.py "glass bottle shattering on concrete"
```

The first run provisions everything it needs; later runs go straight to generation.
Output lands in `test/stable-audio/out/` as 44.1 kHz stereo **MP3 at 320 kbps** — a quarter
of the size of the WAV, and these files are reference targets, not masters. The distance
metric they feed is scale-normalized and onset-aligned, so neither the encoder's gain nor its
leading delay reaches it; what lossy coding does cost is the top of the spectrum, hence the
highest bitrate LAME offers. `--format wav` gives the bit-exact render back.

## From the playground

This script is not only run by hand: the playground's **Model** tab drives it, and so does
`window.txt2sfx.target(…)`. The renders go to the same place a dropped file does — the B
side of Compare — so the diffusion take is one click from the A/B player, the spectrogram
diff, `⌖ Fit to reference`, and the **match reference** box on a generate run.

**The bridge is what drives it for anyone who does not have this repository.**
`npx txt2sfx-bridge` carries its own copy of `run.py` and `requirements.txt` (packed into
the published tarball by `packages/bridge/scripts/pack-assets.mjs`), writes them to
`~/.txt2sfx/stable-audio/`, and provisions there. Run from a checkout it uses *this*
directory instead, so a venv built from a terminal and one built from the Model tab are
the same venv and nobody ends up with two five-gigabyte copies. `TXT2SFX_STABLE_AUDIO_DIR`
overrides both. The implementation is `packages/bridge/src/stable-audio.ts`, and the
dev-only Vite endpoint (`apps/web/plugins/stable-audio.ts`, `apply: 'serve'`) is now a thin
HTTP shim over that same module — kept only so `pnpm dev` needs no second terminal.

**The Model tab will provision.** That used to be refused, and the reversal is narrow: the
objection was to a 1.7 GB download and a licence gate behind a *spinner*, not to the
download. The tab now shows what will be fetched, where it will land, the licence link,
the token field, and every line this script prints while it works — so there is nothing
left to hide. It runs `run.py --provision`, which builds the venv and downloads the
weights and renders nothing.

A render started from the page **is not saved**: it runs `run.py --stdout` and the audio
comes back inside the answer, ~130 KB of base64. A target is consumed once, by the
reference slot, and a session of clicking that button should not leave a directory to
sweep up. Renders a *terminal* run left in `out/` are a different thing and are still
listed in the status — re-rendering yesterday's prompt is waste.

Two things can live in the environment of whichever process drives this — the bridge or
the dev server — rather than in the page:

```powershell
$env:HF_TOKEN = "hf_..."                                    # gated weights
$env:STABLE_AUDIO_REPO = "someone/stable-audio-open-small"  # optional: default repo
npx txt2sfx-bridge      # or: pnpm dev
```

Neither is required any more: the Model tab has a token field and a repo field, and the
token it sends is used for that one request and never written down. `HF_TOKEN` still has
to be exported *before* the process starts if you prefer it there, and a token left by
`huggingface-cli login` is found too. If the gate is in the way, the repo field is the
`--repo` flag: point it at a mirror your Hugging Face cache already holds and no token is
needed.

## What the first run does

1. **Provisions a venv** at `test/stable-audio/.venv` on **CPython 3.10** — `stable-audio-tools`
   requires `>=3.10,<3.11` and pins `torch==2.7.1`. The interpreter is fetched by
   [uv](https://docs.astral.sh/uv/) (`winget install --id astral-sh.uv`, or `pip install uv`);
   no system Python is touched. Without uv, run the script with a 3.10 interpreter yourself.
2. **Picks the torch build for the machine** — if `nvidia-smi` reports a device, the three torch
   packages are reinstalled from `download.pytorch.org/whl/cu128` (a ~3 GB download, once);
   otherwise the CPU wheels from `requirements.txt` stay. The choice is recorded in
   `.venv/.deps-installed`, so later runs neither re-probe nor re-download, and `--reinstall`
   lands on the same build rather than silently dropping back to CPU. `--cpu-torch` forces the
   CPU wheels on a GPU box. That file also holds a fingerprint of `requirements.txt`: change a
   pin and the next terminal run syncs the venv (~1 s when nothing moved) instead of needing a
   rebuild that would re-download 3 GB of CUDA wheels. torch survives the sync — pip and uv
   both read the installed `2.7.1+cu128` as satisfying stable-audio-tools' `==2.7.1`.
3. **Downloads the weights** — ~1.7 GB of `model.safetensors` into the shared Hugging Face
   cache (`%USERPROFILE%\.cache\huggingface`), plus `t5-base` for the text conditioner.
   `run.py --reinstall` rebuilds the venv; the model cache is left alone.

The weights are **gated**. Before the first run:

1. accept the Stability AI Community License at
   <https://huggingface.co/stabilityai/stable-audio-open-small>
2. create a read token at <https://huggingface.co/settings/tokens>
3. `$env:HF_TOKEN = "hf_..."` (or `huggingface-cli login`)

If the gate is in the way, `--repo <id>` points at any repo holding the same
`model_config.json` + `model.safetensors` pair — community mirrors of this checkpoint exist
and are byte-identical, though the licence still governs what you do with the audio.

## Usage

```bash
python test/stable-audio/run.py "wooden crate smashing" --count 3      # three variations
python test/stable-audio/run.py "sci-fi door whoosh" --seconds 2       # trim the render
python test/stable-audio/run.py "coin pickup" --seed 42                # reproducible
python test/stable-audio/run.py "rain on a tin roof" --steps 16        # more steps
python test/stable-audio/run.py "coin pickup" --format wav             # uncompressed
python test/stable-audio/run.py "coin pickup" --stdout > target.mp3    # nothing in out/
```

| flag | default | note |
| --- | --- | --- |
| `--seconds` | `11` | the model always renders its full 11 s window; this trims the tail |
| `--steps` | `8` | from the model card — ARC post-training makes it a few-step model |
| `--cfg` | `1.0` | ditto: the distilled model is CFG-free, higher values are a knob to play with |
| `--sampler` | `pingpong` | `dpmpp-3m-sde`, `euler`, `rk4` also exist |
| `--seed` | random | printed and baked into the filename |
| `--count` | `1` | variations per invocation, one file each |
| `--format` | `mp3` | `wav` for the bit-exact render |
| `--bitrate` | `320` | kbps, MP3 only; the MPEG-1 ladder down to 32 |
| `--stdout` | — | write the encoded audio to stdout, nothing to `out/`; progress goes to stderr |
| `--threads` | all cores | torch CPU threads |
| `--cpu-torch` | — | provision the CPU-only wheels even on a GPU box (see below) |
| `--model` | `small` | `sfx3` = `stable-audio-3-small-sfx`, experimental (see below) |
| `--repo` | — | any Hugging Face repo id in stable-audio-tools layout |
| `--no-chunked` | — | decode in one piece; needs several GB free, and pages on a 16 GB box |
| `--reinstall` | — | delete and rebuild the venv |
| `--provision` | — | build the venv and download the weights, then exit; what the Model tab's install button runs |

`--model sfx3` points at [`stabilityai/stable-audio-3-small-sfx`][sfx3], which is a
text-to-SFX model rather than a music one and therefore the more interesting comparison —
but its sampling recipe is not the one baked in above and it needs a `stable-audio-tools`
new enough to build its config. Treat a failure there as "not supported by the pinned
toolkit", not as a broken script.

[sfx3]: https://huggingface.co/stabilityai/stable-audio-3-small-sfx

## What you are comparing

|  | Stable Audio Open Small | txt2sfx |
| --- | --- | --- |
| artifact | 44.1 kHz stereo audio, ~450 KB of MP3 (~2 MB as WAV) per sound | a soundline recipe → 300–1000 B of Web Audio JS |
| dependency at runtime | 1.7 GB of weights, torch | none |
| generation | ~0.5 s per 11 s render on an RTX 3080, ~22 s on 8 CPU cores | synthesis at play time, sub-millisecond |
| editing | re-prompt and re-roll | change a number, or move a slider the recipe declares |
| length | fixed 11 s window | whatever the envelopes say |

That is the honest framing: the diffusion model is far better at "what does a real rainstorm
sound like", and cannot give you a 900-byte asset you can diff in a pull request. Use these
renders as the target, not as the competitor.

## Speed, and the one thing that matters for it

### CUDA

Nothing to configure: `nvidia-smi` decides the wheels at provisioning time and
`torch.cuda.is_available()` decides the device at render time, so a GPU box just gets used.
`--cpu` renders on the CPU without touching the install; `--cpu-torch` goes further and
provisions the CPU wheels, which is what you want if the GPU is busy with something else and
you would rather not have 3 GB of CUDA libraries on disk.

Measured on an RTX 3080 (10 GB, sm_86, driver 591.74), `torch 2.7.1+cu128`:

```
loaded in 9.5s on cuda
sample 1.0s + decode 0.3s = 1.3s   peak 2.27 GiB   # first render of the process
sample 0.3s + decode 0.1s = 0.5s   peak 2.28 GiB   # every one after it
sample 0.3s + decode 0.0s = 0.3s   peak 2.05 GiB   # --seconds 2
```

So ~0.5 s against the 22 s of the CPU baseline below, and the shape of the cost changes with
it. The first render in a process pays ~0.8 s of cuDNN autotuning and allocator warm-up, which
is why `--count 3` is much cheaper per sound than three invocations. Weight loading now
dominates a single render, and it is host-side work — 1.7 GB of safetensors and the T5
conditioner — that no GPU makes faster.

The decode also stops being the expensive half: 0.1 s against 13.9 s on the CPU. That makes
`--seconds` a trimming convenience rather than the optimisation it is on the CPU path, and it
makes `--no-chunked` nearly free — 2.57 GiB peak instead of 2.28 GiB, same 0.1 s, and no
crossfade seams between decoder chunks. On a 10 GB card it is the better default for a
reference render; it stays opt-in because the memory bound is what matters on CPU.

Two GPU-only details are in `run.py`:

- **TF32 is enabled.** The diffusion transformer runs in fp32 and on Ampere and later its
  matmuls are ~4x faster in TF32, for a mantissa difference well below the noise floor of an
  8-step sample. The autoencoder is left in the fp16 the checkpoint asks for — on a GPU
  `model_half` is the right call, and only the CPU path undoes it.
- **The timers are fenced.** CUDA queues kernels instead of running them, so without an
  explicit `torch.cuda.synchronize()` the sampling cost would land in whichever call syncs
  next — here the copy to host inside `pcm16` — and the printed split would be a fiction.

### CPU

Measured on a Snapdragon X Plus (8 cores, 16 GB), CPU only:

```
loaded in 10.1s on cpu
sample 8.1s + decode 13.9s = 22.0s     # 11 s of 44.1 kHz stereo
sample 8.8s + decode  3.0s = 11.8s     # --seconds 2
```

Two things get you there, both in `run.py`:

- **The autoencoder is forced back to fp32 on CPU.** The checkpoint sets `model_half`, which
  is right on a GPU and ruinous on a CPU: there are no fp16 oneDNN convolutions, so every
  layer of the decoder falls back to `aten::slow_conv_dilated2d` and friends — the reference
  kernels. Before the fix, decoding 2 s took **121 s**; after, **3.0 s**. Same audio, ~700 MB
  more RAM. The diffusion transformer was fp32 already, which is why sampling looked fine
  while the decode did not.
- **Only the kept latents are decoded.** The model always samples its full 11 s window, but
  the decode is linear in length and is the expensive half, so `--seconds 2` decodes 2 s.

## Notes

- CUDA is used whenever `torch.cuda.is_available()`; `--cpu` forces the render onto the CPU and
  `--cpu-torch` provisions the CPU wheels in the first place. Both paths are supported — the
  fp32 autoencoder fallback and the chunked decode exist for the CPU one.
- On Windows/ARM the venv is x86_64 CPython under Prism emulation — PyPI ships no `win_arm64`
  torch wheels, and the native ARM64 builds on download.pytorch.org start at torch 2.10 /
  CPython 3.11, while stable-audio-tools pins torch 2.7.1 on CPython 3.10. Emulation is not
  the bottleneck it looks like: matmul measures ~237 GFLOPS and conv1d ~75 GFLOPS here.
- The Hexagon NPU is not reachable from torch. It would take an ONNX export of the DiT, the
  T5 conditioner and the autoencoder plus int8/int16 quantisation for the ONNX Runtime QNN
  execution provider; no such export of this model is published, and the snake activations
  (`sin`) and weight-normed convs are exactly the ops that fall back to CPU per node.
- `numpy<2` is pinned: `PyWavelets==1.4.1`, which stable-audio-tools requires, is built
  against the numpy 1.x ABI and import fails otherwise. `pytorch_lightning` is pinned in
  because the inference path imports it even though it is declared a training extra.
- MP3 is encoded by `lameenc` — libmp3lame in a ~300 KB wheel, in-process, with no system
  library to find. torchaudio cannot do it: its MP3 path needs ffmpeg's *shared* libraries and
  the wheels do not carry them, so `torchaudio.utils.ffmpeg_utils` raises `ImportError` on a
  plain install. If `lameenc` is missing (a venv provisioned before the pin, driven straight
  from the playground so the bootstrap never ran) the `ffmpeg` CLI is used instead, and failing
  that the error names the one command that fixes it.
- `--stdout` takes fd 1 for the audio and points every other writer at stderr. Rebinding
  `sys.stdout` would not be enough: stable-audio-tools prints `flash_attn not installed` while
  its modules import, and those 187 bytes of English would sit in front of the first MP3 frame.
- `flash_attn not installed` on startup is expected and harmless on CPU.
