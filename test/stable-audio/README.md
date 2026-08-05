# Stable Audio Open Small — reference baseline

A/B harness for txt2sfx: render the same prompt with a diffusion model so the procedural
result has something to be judged against. Nothing here is part of the build, the tests or
the shipped packages — it is a comparison tool that happens to live in the repo.

```bash
python test/stable-audio/run.py "glass bottle shattering on concrete"
```

The first run provisions everything it needs; later runs go straight to generation.
Output lands in `test/stable-audio/out/` as 44.1 kHz stereo WAV.

## What the first run does

1. **Provisions a venv** at `test/stable-audio/.venv` on **CPython 3.10** — `stable-audio-tools`
   requires `>=3.10,<3.11` and pins `torch==2.7.1`. The interpreter is fetched by
   [uv](https://docs.astral.sh/uv/) (`winget install --id astral-sh.uv`, or `pip install uv`);
   no system Python is touched. Without uv, run the script with a 3.10 interpreter yourself.
2. **Downloads the weights** — ~1.7 GB of `model.safetensors` into the shared Hugging Face
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
```

| flag | default | note |
| --- | --- | --- |
| `--seconds` | `11` | the model always renders its full 11 s window; this trims the tail |
| `--steps` | `8` | from the model card — ARC post-training makes it a few-step model |
| `--cfg` | `1.0` | ditto: the distilled model is CFG-free, higher values are a knob to play with |
| `--sampler` | `pingpong` | `dpmpp-3m-sde`, `euler`, `rk4` also exist |
| `--seed` | random | printed and baked into the filename |
| `--count` | `1` | variations per invocation, one file each |
| `--threads` | all cores | torch CPU threads |
| `--model` | `small` | `sfx3` = `stable-audio-3-small-sfx`, experimental (see below) |
| `--repo` | — | any Hugging Face repo id in stable-audio-tools layout |
| `--no-chunked` | — | decode in one piece; needs several GB free, and pages on a 16 GB box |
| `--reinstall` | — | delete and rebuild the venv |

`--model sfx3` points at [`stabilityai/stable-audio-3-small-sfx`][sfx3], which is a
text-to-SFX model rather than a music one and therefore the more interesting comparison —
but its sampling recipe is not the one baked in above and it needs a `stable-audio-tools`
new enough to build its config. Treat a failure there as "not supported by the pinned
toolkit", not as a broken script.

[sfx3]: https://huggingface.co/stabilityai/stable-audio-3-small-sfx

## What you are comparing

|  | Stable Audio Open Small | txt2sfx |
| --- | --- | --- |
| artifact | 44.1 kHz stereo WAV, ~1–2 MB per sound | a soundline recipe → 300–1000 B of Web Audio JS |
| dependency at runtime | 1.7 GB of weights, torch | none |
| generation | ~22 s per 11 s render on 8 CPU cores | synthesis at play time, sub-millisecond |
| editing | re-prompt and re-roll | change a number, or move a slider the recipe declares |
| length | fixed 11 s window | whatever the envelopes say |

That is the honest framing: the diffusion model is far better at "what does a real rainstorm
sound like", and cannot give you a 900-byte asset you can diff in a pull request. Use these
renders as the target, not as the competitor.

## Speed, and the one thing that matters for it

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

- CPU only by default. CUDA is used if `torch.cuda.is_available()`; `--cpu` forces it off.
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
- `flash_attn not installed` on startup is expected and harmless on CPU.
