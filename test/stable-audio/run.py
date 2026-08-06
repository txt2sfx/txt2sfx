#!/usr/bin/env python3
"""Reference baseline for txt2sfx: generate the same prompt with Stable Audio Open Small.

    python test/stable-audio/run.py "glass bottle shattering on concrete"

First run provisions an isolated CPython 3.10 venv (stable-audio-tools pins
>=3.10,<3.11 and torch 2.7.1) next to this file, picks the CPU or CUDA torch wheels
depending on whether nvidia-smi finds a device, and downloads ~1.7 GB of weights
into the Hugging Face cache. Every run after that is offline apart from the model
cache lookup. Nothing here is part of the txt2sfx build — it exists so a diffusion
render can be A/B'd against the procedural one.

Output is MP3 (`out/<slug>-<seed>.mp3`) — a quarter of the size of the same render as
WAV, and these files are reference targets kept around for comparison, not masters.
The distance metric they feed is scale-normalized and onset-aligned, so
neither the encoder's gain nor its leading delay reaches it; what lossy coding does
cost is the top of the spectrum, which is why the bitrate defaults to the highest
LAME offers. `--format wav` gives the bit-exact render back, and `--stdout` writes
the encoded bytes to stdout instead of the directory — that is how the playground
gets a render without leaving a file behind.

The weights are gated: accept the Stability Community License at
https://huggingface.co/stabilityai/stable-audio-open-small and put a read token in
HF_TOKEN (or run `huggingface-cli login`) before the first run.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
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
# Holds the provisioned torch variant ("cpu" or a CUDA tag) so a later run can tell that the
# venv is there but built for the wrong device, plus a fingerprint of requirements.txt so a
# new pin is picked up. Older venvs wrote a single "ok" line — treated as unknown.
STAMP = VENV / ".deps-installed"
REQUIREMENTS = HERE / "requirements.txt"
OUT_DIR = HERE / "out"
PY_VERSION = "3.10"

# Progress goes to stderr under --stdout, because stdout is then the audio itself. Every
# message in this file goes through say() for that one reason.
LOG = sys.stdout

# The real stdout, once --stdout has claimed it — see claim_stdout().
AUDIO_OUT = None


def say(text: str = "") -> None:
    print(text, file=LOG, flush=True)


def claim_stdout() -> None:
    """Take stdout for the audio alone and point every other writer at stderr.

    Redirecting our own prints is not enough: stable-audio-tools prints "flash_attn not
    installed, disabling Flash Attention" to stdout while its modules import, which lands
    187 bytes of English in front of the first MP3 frame. Doing it at the file descriptor
    rather than by rebinding sys.stdout also covers anything a native extension writes,
    which is exactly the kind of thing that would show up as a corrupt render once.
    """
    global AUDIO_OUT
    sys.stdout.flush()
    fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    AUDIO_OUT = os.fdopen(fd, "wb")


def write_audio(data: bytes) -> None:
    if AUDIO_OUT is None:
        raise RuntimeError("stdout was never claimed")
    AUDIO_OUT.write(data)
    AUDIO_OUT.flush()

# requirements.txt gets the CPU wheels (that is what PyPI serves on Windows/macOS). When an
# NVIDIA GPU is present the three torch packages are swapped for the CUDA build from
# download.pytorch.org. Versions must stay exactly the ones stable-audio-tools pins — only the
# local version tag changes. cu128 covers every card torch 2.7 supports, sm_60 through sm_120.
CUDA_TAG = "cu128"
TORCH_PACKAGES = {"torch": "2.7.1", "torchaudio": "2.7.1", "torchvision": "0.22.1"}

# MPEG-1 Layer III at 44.1 kHz defines exactly these bitrates. 320 kbps is the ceiling and the
# default: a reference render is compared spectrally, and the first thing a lower one gives up
# is the top of the band. 16-bit stereo at 44.1 kHz is 1411 kbps, so it still saves ~77%.
MP3_BITRATES = (32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)


def torch_index(tag: str) -> str:
    return f"https://download.pytorch.org/whl/{tag}"


def torch_pins(tag: str) -> list[str]:
    return [f"{name}=={version}+{tag}" for name, version in TORCH_PACKAGES.items()]

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
    say("+ " + " ".join(cmd))
    code = subprocess.call(cmd)
    if code != 0:
        sys.exit(code)


def requirements_fingerprint() -> str:
    return hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()[:12]


def read_stamp() -> tuple[str, str]:
    """The torch variant and the requirements fingerprint the last provisioning run recorded."""
    if not STAMP.exists():
        return "", ""
    tag, reqs = "", ""
    for line in STAMP.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("reqs="):
            reqs = line[len("reqs=") :]
        elif line:
            tag = line
    if tag and tag != CUDA_TAG:
        tag = "cpu"  # the CPU wheels, or a venv from before this stamp meant anything
    return tag, reqs


def write_stamp(tag: str, reqs: str) -> None:
    STAMP.write_text(f"{tag}\nreqs={reqs}\n", encoding="utf-8")


def has_nvidia_gpu() -> bool:
    """True when nvidia-smi reports at least one device. CUDA torch is a 3 GB download, so it
    is worth one cheap probe rather than installing it speculatively."""
    if sys.platform == "darwin":
        return False
    smi = shutil.which("nvidia-smi")
    if smi is None:
        return False
    try:
        out = subprocess.run([smi, "-L"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    return out.returncode == 0 and out.stdout.lstrip().startswith("GPU")


def install_torch(tag: str, uv: str | None) -> None:
    """Replace the provisioned torch wheels with the ones from the `tag` index."""
    say(f"installing torch/{tag} wheels (~3 GB for a CUDA build, once)")
    if uv is not None:
        # uv treats 2.7.1+cpu as satisfying ==2.7.1 and would do nothing, so name the
        # packages to reinstall explicitly.
        reinstall = [f"--reinstall-package={name}" for name in TORCH_PACKAGES]
        run([uv, "pip", "install", "--python", str(VENV_PY), "--index-url", torch_index(tag),
             *reinstall, *torch_pins(tag)])
    else:
        run([str(VENV_PY), "-m", "pip", "install", "--index-url", torch_index(tag),
             "--force-reinstall", "--no-deps", *torch_pins(tag)])


def bootstrap(argv: list[str], reinstall: bool, cpu_torch: bool) -> "int":
    """Create ./.venv on CPython 3.10 with the pinned deps, then re-run this script in it."""
    if reinstall and VENV.exists():
        say(f"removing {VENV}")
        shutil.rmtree(VENV)

    stamp, reqs = read_stamp()
    want_reqs = requirements_fingerprint()
    uv = shutil.which("uv")

    # A changed requirements.txt syncs the venv rather than rebuilding it: the resolver run
    # over an already-satisfied environment costs about a second, and rebuilding would mean
    # re-downloading the ~3 GB CUDA wheels for the sake of one new pin. torch survives it —
    # both pip and uv read the installed 2.7.1+cu128 as satisfying stable-audio-tools' ==2.7.1.
    if VENV_PY.exists() and stamp and reqs != want_reqs:
        say("requirements.txt changed since this venv was built — syncing")

    if not (VENV_PY.exists() and stamp) or reqs != want_reqs:
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
        # A fresh venv has the CPU wheels from requirements.txt; the swap below decides if they
        # stay. A synced one keeps whatever torch it already had, for the reason above.
        stamp = stamp or "cpu"
        write_stamp(stamp, want_reqs)

    # Probing is skipped once the CUDA build is in place, and costs nothing on a box with no
    # nvidia-smi at all — so the only run that shells out is the one that might need the swap.
    if cpu_torch:
        want = "cpu"
    elif stamp == CUDA_TAG or has_nvidia_gpu():
        want = CUDA_TAG
    else:
        want = "cpu"

    if want != stamp:
        install_torch(want, uv)
        write_stamp(want, want_reqs)

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


def pcm16(audio) -> tuple[bytes, int]:
    """Interleaved 16-bit PCM for `audio`, a float tensor [channels, samples] in [-1, 1].

    Returns the samples and the channel count, which both encoders have to be told.
    """
    import numpy as np

    data = (audio.clamp(-1, 1) * 32767).to("cpu").numpy().astype(np.int16)
    return data.T.reshape(-1).tobytes(), data.shape[0]  # .T interleaves channels


def encode_wav(pcm: bytes, sample_rate: int, channels: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buffer.getvalue()


def encode_mp3(pcm: bytes, sample_rate: int, channels: int, bitrate: int) -> bytes:
    """Encode with LAME, in-process, falling back to the ffmpeg CLI.

    `lameenc` is a ~300 KB wheel with libmp3lame inside and no system library to find, which
    is why it is the pinned encoder rather than torchaudio: torchaudio's MP3 support needs
    ffmpeg's *shared libraries*, and the wheels do not carry them (`ffmpeg_utils` raises
    ImportError on a plain install). The fallback exists for a venv provisioned before
    requirements.txt grew the pin — a terminal run syncs it, but the playground spawns the
    venv's interpreter directly and never reaches the bootstrap.
    """
    try:
        import lameenc
    except ImportError:
        return ffmpeg_mp3(pcm, sample_rate, channels, bitrate)

    encoder = lameenc.Encoder()
    encoder.set_bit_rate(bitrate)
    encoder.set_in_sample_rate(sample_rate)
    encoder.set_channels(channels)
    # 0 is LAME's slowest/best psychoacoustic path and 9 its fastest; 2 is the "high quality"
    # setting the lame CLI itself defaults to, and costs a fraction of one diffusion step.
    encoder.set_quality(2)
    return bytes(encoder.encode(pcm) + encoder.flush())


def ffmpeg_mp3(pcm: bytes, sample_rate: int, channels: int, bitrate: int) -> bytes:
    exe = shutil.which("ffmpeg")
    if exe is None:
        sys.exit(
            "\nno MP3 encoder: `lameenc` is not installed in this venv and no `ffmpeg` is on PATH.\n"
            '  python test/stable-audio/run.py "a test sound"   # from a terminal: syncs requirements.txt\n'
            "or render uncompressed instead:  --format wav\n"
        )
    result = subprocess.run(
        [exe, "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", str(sample_rate),
         "-ac", str(channels), "-i", "pipe:0", "-b:a", f"{bitrate}k", "-f", "mp3", "pipe:1"],
        input=pcm,
        stdout=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        sys.exit(f"ffmpeg exited with {result.returncode} while encoding")
    return result.stdout


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
        say(f"! preset '{args.model}' is experimental: {preset['note']}")

    torch.set_num_threads(args.threads or os.cpu_count() or 4)
    device = "cuda" if (torch.cuda.is_available() and not args.cpu) else "cpu"

    if device == "cuda":
        # The DiT runs in fp32, and on Ampere and later its matmuls are ~4x faster in TF32 for
        # a mantissa difference no diffusion sampler can hear. The autoencoder is fp16 anyway.
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        free, total = torch.cuda.mem_get_info()
        say(
            f"device {torch.cuda.get_device_name(0)} (sm_{''.join(map(str, torch.cuda.get_device_capability(0)))}), "
            f"{free / 2**30:.1f} of {total / 2**30:.1f} GiB free"
        )
    elif torch.cuda.is_available():
        say("device cpu (--cpu given; CUDA is available)")

    say(f"model  {repo}")
    model_dir = download_model(repo, args.revision)

    t0 = time.perf_counter()
    model, model_config = load_model(model_dir)
    model = model.to(device).eval().requires_grad_(False)
    say(f"loaded in {time.perf_counter() - t0:.1f}s on {device}")

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
        say(f"! {seconds}s requested, model renders {max_seconds:.1f}s - clamping")
        seconds = max_seconds

    cond = conditioning_for(model_config, args.prompt, seconds)
    if not args.stdout:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
    slug = slugify(args.prompt)

    codec = "wav" if args.format == "wav" else f"mp3 {args.bitrate}k"
    say(
        f"prompt \"{args.prompt}\"\n"
        f"steps  {steps} | sampler {sampler} | cfg {cfg} | {seconds:g}s @ {sample_rate} Hz | {codec}"
    )

    # Sampling and decoding are split so both halves are visible: the progress bar below
    # covers the 8 sampling steps only, and on CPU the decode is the longer half.
    pretransform = getattr(model, "pretransform", None)
    ratio = getattr(pretransform, "downsampling_ratio", 0) if pretransform is not None else 0

    # CUDA kernels are queued, not run, so every timing below has to be fenced or the sampling
    # cost silently lands in whatever syncs next (here: the copy to host inside pcm16).
    def sync() -> None:
        if device == "cuda":
            torch.cuda.synchronize()

    for i in range(args.count):
        seed = args.seed if args.seed >= 0 else random.randrange(2**32 - 1)
        if device == "cuda":
            torch.cuda.reset_peak_memory_stats()
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
        sync()
        t_sample = time.perf_counter() - t0

        if ratio > 0:
            # The model always samples its full window, but decoding is linear in length
            # and is the expensive half — so decode only the latents we are keeping.
            keep = min(sampled.shape[-1], int(seconds * sample_rate / ratio) + 2)
            say(f"  sampled in {t_sample:.1f}s, decoding {seconds:g}s")
            t0 = time.perf_counter()
            with torch.inference_mode():
                audio = pretransform.decode(sampled[..., :keep])
            sync()
            t_decode = time.perf_counter() - t0
        else:
            audio, t_decode = sampled, 0.0

        audio = audio[0].to(torch.float32)[:, : int(seconds * sample_rate)]
        peak = audio.abs().max()
        if peak > 0:
            # WAV keeps the -0.2 dBFS this always had. MP3 gets -1 dBFS instead, because a
            # lossy decoder reconstructs transients with overshoot of up to about a decibel —
            # and the sounds here are impacts, which is exactly where that shows up. Clipping
            # in a decoder would be an artefact of the container, not of the render.
            audio = audio / peak * (0.98 if args.format == "wav" else 0.89)

        pcm, channels = pcm16(audio)
        if args.format == "wav":
            data = encode_wav(pcm, sample_rate, channels)
        else:
            data = encode_mp3(pcm, sample_rate, channels, args.bitrate)

        name = f"{slug}-{seed}.{args.format}"
        total = t_sample + t_decode
        vram = ""
        if device == "cuda":
            vram = f"  peak {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB"
        timing = f"sample {t_sample:.1f}s + decode {t_decode:.1f}s = {total:.1f}s  seed {seed}{vram}"

        if args.stdout:
            write_audio(data)
            say(f"  stdout  {human_bytes(len(data))}  {timing}")
            # One machine-readable line for a caller that has the bytes but not the name: the
            # filename rule lives in slugify() and reimplementing it on the other side would
            # be a second definition of the same thing, wrong the first time either moves.
            say(
                "txt2sfx-result "
                + json.dumps(
                    {
                        "name": name,
                        "mime": "audio/wav" if args.format == "wav" else "audio/mpeg",
                        "bytes": len(data),
                        "seed": seed,
                        "seconds": round(seconds, 6),
                        "sample_rate": sample_rate,
                    }
                )
            )
        else:
            path = OUT_DIR / name
            path.write_bytes(data)
            say(f"  {path.relative_to(HERE.parent.parent)}  {human_bytes(len(data))}  {timing}")

    if not args.stdout:
        say(
            "\nfor comparison: the same prompt through txt2sfx is a soundline recipe and a few\n"
            "hundred bytes of Web Audio code - `pnpm dev`, or see README.md."
        )
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="run.py",
        description="Generate a reference sound with Stable Audio Open Small (CUDA if present).",
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
    p.add_argument("--format", choices=("mp3", "wav"), default="mp3",
                   help="output encoding (default: mp3)")
    p.add_argument("--bitrate", type=int, default=320, choices=MP3_BITRATES, metavar="KBPS",
                   help="mp3 bitrate in kbps (default: 320)")
    p.add_argument("--stdout", action="store_true",
                   help="write the encoded audio to stdout and nothing to out/ (progress goes to stderr)")
    p.add_argument("--threads", type=int, help="torch CPU threads (default: all cores)")
    p.add_argument("--cpu", action="store_true", help="force CPU even if CUDA is available")
    p.add_argument("--cpu-torch", action="store_true",
                   help="provision the CPU-only torch wheels even with an NVIDIA GPU present")
    p.add_argument("--no-chunked", action="store_true", help="decode the render in one piece (needs RAM)")
    p.add_argument("--reinstall", action="store_true", help="rebuild the venv, then run")
    return p.parse_args(argv)


def main() -> int:
    global LOG
    argv = sys.argv[1:]
    args = parse_args(argv)

    if args.stdout:
        # Before anything is printed, and before the re-exec below: provisioning output on
        # stdout would sit in the middle of the audio.
        LOG = sys.stderr
        if args.count != 1:
            sys.exit("--stdout writes one sound to one stream; drop --count")

    if not running_in_venv():
        if not (args.reinstall or args.cpu_torch) and not args.prompt:
            parse_args(["--help"])
        skip = {"--reinstall", "--cpu-torch"}
        # Deliberately *not* claiming stdout here: the re-exec below inherits fd 1, and the
        # child is the process that renders. Provisioning output is on stderr already.
        return bootstrap([a for a in argv if a not in skip], args.reinstall, args.cpu_torch)

    if not args.prompt:
        parse_args(["--help"])
    if args.stdout:
        claim_stdout()
    return generate(args)


if __name__ == "__main__":
    sys.exit(main())
