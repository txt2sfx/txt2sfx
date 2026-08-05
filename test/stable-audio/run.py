#!/usr/bin/env python3
"""Reference baseline for txt2sfx: generate the same prompt with Stable Audio Open Small.

    python test/stable-audio/run.py "glass bottle shattering on concrete"

First run provisions an isolated CPython 3.10 venv (stable-audio-tools pins
>=3.10,<3.11 and torch 2.7.1) next to this file and downloads ~1.7 GB of weights
into the Hugging Face cache. Every run after that is offline apart from the model
cache lookup. Nothing here is part of the txt2sfx build — it exists so a diffusion
render can be A/B'd against the procedural one.

The weights are gated: accept the Stability Community License at
https://huggingface.co/stabilityai/stable-audio-open-small and put a read token in
HF_TOKEN (or run `huggingface-cli login`) before the first run.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENV = HERE / ".venv"
VENV_PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
STAMP = VENV / ".deps-installed"
REQUIREMENTS = HERE / "requirements.txt"
OUT_DIR = HERE / "out"
PY_VERSION = "3.10"

# Sampling defaults come from the Stable Audio Open Small model card: 8 steps with the
# ping-pong sampler and no classifier-free guidance, because the ARC post-training makes
# the model few-step and CFG-free. Anything else is a knob, not a default.
PRESETS = {
    "small": {
        "repo": "stabilityai/stable-audio-open-small",
        "steps": 8,
        "cfg": 1.0,
        "sampler": "pingpong",
        "seconds": 11.0,
        "note": "341M params, ~1.7 GB of weights, 44.1 kHz stereo, 11 s maximum.",
        "experimental": False,
    },
    # Stable Audio 3 Small (SFX) is the closer subject-matter match — a text-to-SFX model
    # rather than a music/loop one — but its sampling recipe is not the one above and it
    # needs a stable-audio-tools new enough to know the `stable-audio-3` config. Treat a
    # failure here as "not supported by the pinned toolkit", not as a broken script.
    "sfx3": {
        "repo": "stabilityai/stable-audio-3-small-sfx",
        "steps": 8,
        "cfg": 1.0,
        "sampler": "pingpong",
        "seconds": 11.0,
        "note": "experimental: ships its own t5gemma text encoder, recipe unverified.",
        "experimental": True,
    },
}


# --------------------------------------------------------------------------------------
# bootstrap: re-exec inside a provisioned venv
# --------------------------------------------------------------------------------------

def running_in_venv() -> bool:
    try:
        return Path(sys.prefix).resolve() == VENV.resolve()
    except OSError:
        return False


def run(cmd: list[str]) -> None:
    print("+ " + " ".join(cmd), flush=True)
    code = subprocess.call(cmd)
    if code != 0:
        sys.exit(code)


def bootstrap(argv: list[str], reinstall: bool) -> "int":
    """Create ./.venv on CPython 3.10 with the pinned deps, then re-run this script in it."""
    if reinstall and VENV.exists():
        print(f"removing {VENV}", flush=True)
        shutil.rmtree(VENV)

    if not (VENV_PY.exists() and STAMP.exists()):
        uv = shutil.which("uv")
        if uv is not None:
            if not VENV_PY.exists():
                run([uv, "venv", "--python", PY_VERSION, str(VENV)])
            run([uv, "pip", "install", "--python", str(VENV_PY), "-r", str(REQUIREMENTS)])
        elif sys.version_info[:2] == (3, 10):
            if not VENV_PY.exists():
                run([sys.executable, "-m", "venv", str(VENV)])
            run([str(VENV_PY), "-m", "pip", "install", "-U", "pip"])
            run([str(VENV_PY), "-m", "pip", "install", "-r", str(REQUIREMENTS)])
        else:
            sys.exit(
                f"stable-audio-tools needs CPython 3.10 (this is {sys.version.split()[0]}) and\n"
                "no `uv` was found to provision one. Either install uv\n"
                "  winget install --id astral-sh.uv        # or: pip install uv\n"
                "or run this script with a 3.10 interpreter."
            )
        STAMP.write_text("ok\n", encoding="utf-8")

    return subprocess.call([str(VENV_PY), str(Path(__file__).resolve()), *argv])


# --------------------------------------------------------------------------------------
# generation
# --------------------------------------------------------------------------------------

def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (slug[:48].rstrip("-")) or "sfx"


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.2f} {unit}"
        n /= 1024
    return f"{n:.2f} GB"


def download_model(repo: str, revision: str | None) -> Path:
    """Snapshot the repo into the HF cache (a no-op once it is there) and return the path."""
    from huggingface_hub import snapshot_download
    from huggingface_hub.utils import GatedRepoError, LocalEntryNotFoundError

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    try:
        return Path(
            snapshot_download(
                repo_id=repo,
                revision=revision,
                token=token,
                # `model.ckpt` is the same weights as `model.safetensors`, and `base_model.*`
                # is the pre-ARC checkpoint — another 1.7 GB each, neither of them needed.
                ignore_patterns=["*.ckpt", "*.png", "*.md", "LICENSE*", "NOTICE"],
            )
        )
    except GatedRepoError:
        sys.exit(
            f"\n{repo} is gated.\n"
            f"  1. open https://huggingface.co/{repo} and accept the licence\n"
            "  2. create a read token at https://huggingface.co/settings/tokens\n"
            "  3. set HF_TOKEN=<token> (or run `huggingface-cli login`) and re-run\n"
        )
    except LocalEntryNotFoundError as exc:
        sys.exit(f"\ncould not reach huggingface.co and the model is not cached: {exc}\n")


@contextlib.contextmanager
def chdir(path: Path):
    prev = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(prev)


def load_model(model_dir: Path):
    from stable_audio_tools.models.factory import create_model_from_config
    from stable_audio_tools.models.utils import load_ckpt_state_dict

    with open(model_dir / "model_config.json", encoding="utf-8") as f:
        model_config = json.load(f)

    weights = model_dir / "model.safetensors"
    if not weights.exists():
        weights = model_dir / "model.ckpt"
    if not weights.exists():
        sys.exit(f"no model.safetensors or model.ckpt under {model_dir}")

    # Some configs point at a bundled text encoder by relative path.
    with chdir(model_dir):
        model = create_model_from_config(model_config)
        model.load_state_dict(load_ckpt_state_dict(str(weights)))
    return model, model_config


def conditioning_for(model_config: dict, prompt: str, seconds: float) -> dict:
    """Only feed the conditioners this checkpoint actually declares."""
    configs = model_config.get("model", {}).get("conditioning", {}).get("configs", [])
    ids = {c.get("id") for c in configs}
    cond: dict = {"prompt": prompt}
    if "seconds_start" in ids:
        cond["seconds_start"] = 0
    if "seconds_total" in ids:
        cond["seconds_total"] = seconds
    return cond


def write_wav(path: Path, audio, sample_rate: int) -> None:
    """audio: float tensor [channels, samples] in [-1, 1]."""
    import numpy as np

    data = (audio.clamp(-1, 1) * 32767).to("cpu").numpy().astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(data.shape[0])
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(data.T.reshape(-1).tobytes())  # interleave channels


def generate(args: argparse.Namespace) -> int:
    import torch
    from stable_audio_tools.inference.generation import generate_diffusion_cond

    preset = PRESETS[args.model]
    repo = args.repo or preset["repo"]
    steps = args.steps if args.steps is not None else preset["steps"]
    cfg = args.cfg if args.cfg is not None else preset["cfg"]
    sampler = args.sampler or preset["sampler"]
    seconds = args.seconds if args.seconds is not None else preset["seconds"]

    if preset["experimental"]:
        print(f"! preset '{args.model}' is experimental: {preset['note']}", flush=True)

    torch.set_num_threads(args.threads or os.cpu_count() or 4)
    device = "cuda" if (torch.cuda.is_available() and not args.cpu) else "cpu"

    print(f"model  {repo}", flush=True)
    model_dir = download_model(repo, args.revision)

    t0 = time.perf_counter()
    model, model_config = load_model(model_dir)
    model = model.to(device).eval().requires_grad_(False)
    print(f"loaded in {time.perf_counter() - t0:.1f}s on {device}", flush=True)

    if getattr(model, "pretransform", None) is not None:
        # The checkpoint asks for a half-precision autoencoder, which is right on a GPU and
        # ruinous on a CPU: there are no fp16 oneDNN convolutions, so every layer falls back
        # to aten::slow_conv_* reference kernels — measured here at ~50x slower than the same
        # decode in fp32. Cost of undoing it is ~700 MB of RAM.
        if device == "cpu" and getattr(model.pretransform, "model_half", False):
            model.pretransform.model_half = False
            model.pretransform.model.float()
        # Chunked decode bounds the activation memory of a long render.
        if not args.no_chunked:
            model.pretransform.chunked = True

    sample_rate = model_config["sample_rate"]
    sample_size = model_config["sample_size"]
    max_seconds = sample_size / sample_rate
    if seconds > max_seconds + 1e-6:
        print(f"! {seconds}s requested, model renders {max_seconds:.1f}s - clamping", flush=True)
        seconds = max_seconds

    cond = conditioning_for(model_config, args.prompt, seconds)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    slug = slugify(args.prompt)

    print(
        f"prompt \"{args.prompt}\"\n"
        f"steps  {steps} | sampler {sampler} | cfg {cfg} | {seconds:g}s @ {sample_rate} Hz",
        flush=True,
    )

    # Sampling and decoding are split so both halves are visible: the progress bar below
    # covers the 8 sampling steps only, and on CPU the decode is the longer half.
    pretransform = getattr(model, "pretransform", None)
    ratio = getattr(pretransform, "downsampling_ratio", 0) if pretransform is not None else 0

    for i in range(args.count):
        seed = args.seed if args.seed >= 0 else random.randrange(2**32 - 1)
        t0 = time.perf_counter()
        with torch.inference_mode():
            sampled = generate_diffusion_cond(
                model,
                steps=steps,
                cfg_scale=cfg,
                conditioning=[cond],
                sample_size=sample_size,
                sampler_type=sampler,
                seed=seed,
                device=device,
                return_latents=ratio > 0,
            )
        t_sample = time.perf_counter() - t0

        if ratio > 0:
            # The model always samples its full window, but decoding is linear in length
            # and is the expensive half — so decode only the latents we are keeping.
            keep = min(sampled.shape[-1], int(seconds * sample_rate / ratio) + 2)
            print(f"  sampled in {t_sample:.1f}s, decoding {seconds:g}s", flush=True)
            t0 = time.perf_counter()
            with torch.inference_mode():
                audio = pretransform.decode(sampled[..., :keep])
            t_decode = time.perf_counter() - t0
        else:
            audio, t_decode = sampled, 0.0

        audio = audio[0].to(torch.float32)[:, : int(seconds * sample_rate)]
        peak = audio.abs().max()
        if peak > 0:
            audio = audio / peak * 0.98

        path = OUT_DIR / f"{slug}-{seed}.wav"
        write_wav(path, audio, sample_rate)
        size = path.stat().st_size
        total = t_sample + t_decode
        print(
            f"  {path.relative_to(HERE.parent.parent)}  {human_bytes(size)}  "
            f"sample {t_sample:.1f}s + decode {t_decode:.1f}s = {total:.1f}s  seed {seed}",
            flush=True,
        )

    print(
        "\nfor comparison: the same prompt through txt2sfx is a soundline recipe and a few\n"
        "hundred bytes of Web Audio code - `pnpm dev`, or see README.md.",
        flush=True,
    )
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="run.py",
        description="Generate a reference sound with Stable Audio Open Small (CPU).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='example:\n  python run.py "wooden crate smashing" --count 3\n',
    )
    p.add_argument("prompt", nargs="?", help="text prompt")
    p.add_argument("--model", choices=sorted(PRESETS), default="small", help="preset (default: small)")
    p.add_argument("--repo", help="override the Hugging Face repo id")
    p.add_argument("--revision", help="model revision/branch")
    p.add_argument("--seconds", type=float, help="render length, capped by the model")
    p.add_argument("--steps", type=int, help="diffusion steps")
    p.add_argument("--cfg", type=float, help="classifier-free guidance scale")
    p.add_argument("--sampler", help="sampler type (pingpong, dpmpp-3m-sde, euler, ...)")
    p.add_argument("--seed", type=int, default=-1, help="fixed seed, or -1 for random (default)")
    p.add_argument("--count", type=int, default=1, help="how many variations to render")
    p.add_argument("--threads", type=int, help="torch CPU threads (default: all cores)")
    p.add_argument("--cpu", action="store_true", help="force CPU even if CUDA is available")
    p.add_argument("--no-chunked", action="store_true", help="decode the render in one piece (needs RAM)")
    p.add_argument("--reinstall", action="store_true", help="rebuild the venv, then run")
    return p.parse_args(argv)


def main() -> int:
    argv = sys.argv[1:]
    args = parse_args(argv)

    if not running_in_venv():
        if not args.reinstall and not args.prompt:
            parse_args(["--help"])
        return bootstrap([a for a in argv if a != "--reinstall"], args.reinstall)

    if not args.prompt:
        parse_args(["--help"])
    return generate(args)


if __name__ == "__main__":
    sys.exit(main())
