#!/usr/bin/env python3
"""Build-time asset generation (spec section 9). No user data ever goes to these services.

Voice and sound: ElevenLabs. Images and text drafts: NanoGPT.
Keys are read by name from the env file and never printed. Existing files are skipped
unless --force is passed. --dry-run shows the plan and makes no paid calls.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT / "assets" / "generated"
MANIFEST = ROOT / "assets" / "manifest.json"
PUBLIC = ROOT / "frontend" / "public"
ELEVEN = "https://api.elevenlabs.io"
NANO_IMAGE_URL = "https://api.nano-gpt.com/v1/images/generations"
NANO_CHAT_URL = "https://api.nano-gpt.com/api/v1/chat/completions"
NANO_MODELS_URL = "https://api.nano-gpt.com/api/v1/image-models"
UA = "proof-of-breath-assets/0.1"

VOICE = {
    "breathe-in": "Breathe in", "breathe-out": "Breathe out", "pause": "Pause", "follow-the-circle": "Follow the circle",
    "approved": "Approved", "not-matched": "Not matched, new pattern", "check-declined": "Check declined",
}
SOUND = {
    "tick": ("A very soft single wooden tick, subtle and quiet", 0.5),
    "chime": ("A gentle warm two-note chime, soft and reassuring", 1.0),
    "deny": ("A soft low muted tone, subtle and non-alarming", 0.7),
    "camera-on": ("A soft short rising electronic tone, quiet and subtle", 0.5),
}
STYLE = "Original abstract digital illustration, dark teal and charcoal palette, soft light, calm, minimal, no text, no letters, no logos, no people, no faces."
IMAGES = {
    "logo": ("A single glowing soft teal circle with a thin concentric ring on a near-black background, centred. " + STYLE, "1024x1024", None),
    "app-icon": ("A simple rounded abstract breath wave forming a circle in teal on charcoal, centred, icon composition. " + STYLE, "1024x1024", None),
    "hero": ("A wide abstract landscape of slow luminous breathing waves rising and falling across a dark horizon. " + STYLE, "1536x1536", (1376, 774)),
    "dev-cover": ("A wide abstract composition of concentric expanding rings of soft teal light with one slow wave passing through. " + STYLE, "1536x1536", (1000, 420)),
    "explainer-agent": ("An abstract glowing geometric cube sending a thin beam of light toward a closed arch. " + STYLE, "1024x1024", None),
    "explainer-gate": ("An abstract softly lit arch with a thin line of light held still in front of it. " + STYLE, "1024x1024", None),
    "explainer-breath": ("Abstract soft expanding rings of light breathing outward from a centre point. " + STYLE, "1024x1024", None),
    "explainer-receipt": ("An abstract chain of small glowing linked squares receding into the distance. " + STYLE, "1024x1024", None),
}
DRAFTS = {
    "dev-post-draft": ("Draft a DEV.to post for a project called Proof of Breath, for the Presage SmartSpectra SDK Challenge. It holds destructive commands from AI coding agents until a live person follows a random breathing pattern measured by a webcam using the SDK. Use these exact sections: What I Built, Demo, Code, How It Responds to Human Signals, Prize Categories, Consent and Data Handling, Agent Session. "
                       "Rules: describe it only as checking presence and attention, and say plainly it is not identity authentication. Make no statements about wellbeing or the body beyond 'a live pulse signal is present'. Do not invent any results or numbers: write [RESULTS PENDING] wherever evaluation numbers belong. Write in plain, direct English."),
    "demo-video-script": ("Write a 2 to 3 minute demo video script for Proof of Breath. Beats: a headline about an AI agent deleting a production database; Claude Code tries terraform destroy and is blocked and a gate window opens; consent screen, camera-on indicator, random pattern, target and measured curves converging, live pulse indicator, pass and the command proceeds; attack montage of a photo, a replayed video and ignoring the pacer, all rejected; the typed fallback for accessibility; the receipts page with the chain verified and an evaluation chart. "
                          "Close with: Proves a live, attentive human. Never stores video. Do not invent numbers: write [RESULTS PENDING] where numbers belong. Describe it only as checking presence and attention."),
}
BANNED = re.compile(r"\b(stress\w*|anxiety|health\w*|diagnos\w*|treat\w*|medical\w*|heart condition|calm down)\b", re.I)


def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text(errors="replace").splitlines():
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if m:
            out[m.group(1)] = m.group(2).strip("\"'")
    return out


def http(url: str, key_header: dict, body: dict | None = None, timeout: int = 180) -> bytes:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET",
                                     headers={"Content-Type": "application/json", "User-Agent": UA, **key_header})
    with urllib.request.urlopen(request, timeout=timeout) as reply:
        return reply.read()


class Failover:
    """Try keys in order. A key that is refused or out of credit is not tried again."""

    def __init__(self, names: list[str], env: dict[str, str]):
        self.keys = [(n, env[n]) for n in names if env.get(n)]

    def call(self, make_header, url, body=None):
        last = None
        while self.keys:
            name, key = self.keys[0]
            try:
                return http(url, make_header(key), body), name
            except urllib.error.HTTPError as exc:
                detail = exc.read()[:300].decode(errors="replace")
                last = f"HTTP {exc.code}: {detail}"
                if exc.code in (401, 402, 403, 429):
                    print(f"  key {name} refused ({exc.code}), trying the next one")
                    self.keys.pop(0)
                    continue
                raise RuntimeError(last) from exc
        raise RuntimeError(f"no working key left. Last error: {last}")


class Manifest:
    def __init__(self):
        self.data = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"assets": {}}

    def record(self, name, **fields):
        self.data["assets"][name] = {"date": date.today().isoformat(), **fields}
        MANIFEST.write_text(json.dumps(self.data, indent=2, sort_keys=True) + "\n")


def normalise_audio(src: Path, dest: Path, max_seconds: float | None) -> float:
    """Level loudness and report the final length. Speech also has its silence trimmed.

    Sound effects are not trimmed: they are quiet enough that a silence filter removes them whole.
    """
    level = "loudnorm=I=-20:TP=-2"
    trim = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse," + level
    args = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-af", level if max_seconds else trim, "-ar", "44100", "-b:a", "96k"]
    if max_seconds:
        args += ["-t", str(max_seconds)]
    subprocess.run(args + [str(dest)], check=True)
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(dest)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def pick_voice(eleven: Failover, env: dict[str, str]) -> str:
    if env.get("ELEVENLABS_VOICE_ID"):
        return env["ELEVENLABS_VOICE_ID"]
    raw, _ = eleven.call(lambda k: {"xi-api-key": k}, f"{ELEVEN}/v1/voices")
    voices = json.loads(raw)["voices"]
    premade = [v for v in voices if v.get("category") == "premade"] or voices
    for v in premade:
        labels = " ".join(str(x) for x in (v.get("labels") or {}).values()).lower()
        if "calm" in labels or "soft" in labels or "warm" in labels:
            return v["voice_id"]
    return premade[0]["voice_id"]


def run_audio(args, env, manifest, budget) -> None:
    eleven = Failover(["ELeven_Lab_2009_API_KEY", "ElevenLab_88_API_Key"], env)
    cues = GENERATED / "cues"
    cues.mkdir(parents=True, exist_ok=True)
    voice_id = None
    jobs = [("voice", n, t) for n, t in VOICE.items()] + [("sound", n, s) for n, s in SOUND.items()]
    for kind, name, spec in jobs:
        dest = cues / f"{name}.mp3"
        if dest.exists() and not args.force:
            print(f"skip {name} (exists)")
            continue
        if args.dry_run:
            print(f"would generate {kind} {name}")
            continue
        if not budget.take():
            return
        raw_path = cues / f".{name}.raw.mp3"
        if kind == "voice":
            voice_id = voice_id or pick_voice(eleven, env)
            body = {"text": spec, "model_id": "eleven_multilingual_v2", "voice_settings": {"stability": 0.7, "similarity_boost": 0.7, "speed": 0.95}}
            data, used = eleven.call(lambda k: {"xi-api-key": k}, f"{ELEVEN}/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128", body)
            prompt, model = spec, "eleven_multilingual_v2"
        else:
            body = {"text": spec[0], "duration_seconds": spec[1], "prompt_influence": 0.5}
            data, used = eleven.call(lambda k: {"xi-api-key": k}, f"{ELEVEN}/v1/sound-generation?output_format=mp3_44100_128", body)
            prompt, model = spec[0], "eleven_text_to_sound_v2"
        raw_path.write_bytes(data)
        seconds = normalise_audio(raw_path, dest, 1.2 if kind == "sound" else None)
        raw_path.unlink()
        note = "" if seconds < 1.2 or name == "not-matched" else " (longer than 1.2 s)"
        print(f"made {name}: {seconds:.2f} s{note}")
        manifest.record(f"cues/{name}.mp3", provider="ElevenLabs", model=model, prompt=prompt, seconds=round(seconds, 2), key_used=used,
                        licence="Generated under the account's ElevenLabs plan terms")




def run_images(args, env, manifest, budget) -> None:
    nano = Failover(["NanoGPT_2009_API_KEY", "Nano_GPT_API_KEY", "NanoGPT_88_API_Key"], env)
    art = GENERATED / "art"
    art.mkdir(parents=True, exist_ok=True)
    for name, (prompt, size, crop) in IMAGES.items():
        dest = art / f"{name}.webp"
        if dest.exists() and not args.force:
            print(f"skip {name} (exists)")
            continue
        if args.dry_run:
            print(f"would generate image {name} {size} with {args.image_model}")
            continue
        if not budget.take():
            return
        raw, used = nano.call(lambda k: {"Authorization": f"Bearer {k}"}, NANO_IMAGE_URL,
                              {"model": args.image_model, "prompt": prompt, "n": 1, "size": size, "response_format": "b64_json"})
        reply = json.loads(raw)
        item = reply["data"][0]
        png = base64.b64decode(item["b64_json"]) if item.get("b64_json") else urllib.request.urlopen(urllib.request.Request(item["url"], headers={"User-Agent": UA}), timeout=120).read()
        tmp = art / f".{name}.raw"
        tmp.write_bytes(png)
        scale = f"scale={crop[0]}:-2,crop={crop[0]}:{crop[1]}" if crop else "scale='min(1024,iw)':-2"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(tmp), "-vf", scale, "-q:v", "82", str(dest)], check=True)
        tmp.unlink()
        print(f"made {name}: {dest.stat().st_size // 1024} KB, cost {reply.get('cost')}")
        manifest.record(f"art/{name}.webp", provider="NanoGPT", model=args.image_model, prompt=prompt, size=size, key_used=used,
                        licence="Generated under NanoGPT and upstream model terms. Original abstract style.")


def run_drafts(args, env, manifest, budget) -> None:
    nano = Failover(["NanoGPT_2009_API_KEY", "Nano_GPT_API_KEY", "NanoGPT_88_API_Key"], env)
    folder = GENERATED / "drafts"
    folder.mkdir(parents=True, exist_ok=True)
    for name, prompt in DRAFTS.items():
        dest = folder / f"{name}.md"
        if dest.exists() and not args.force:
            print(f"skip {name} (exists)")
            continue
        if args.dry_run:
            print(f"would draft {name} with {args.text_model}")
            continue
        if not budget.take():
            return
        raw, used = nano.call(lambda k: {"Authorization": f"Bearer {k}"}, NANO_CHAT_URL,
                              {"model": args.text_model, "max_tokens": 3000, "temperature": 0.5, "messages": [{"role": "user", "content": prompt}]})
        text = json.loads(raw)["choices"][0]["message"]["content"].strip()
        dest.write_text("<!-- AI draft. A person must review this before use. -->\n\n" + text + "\n")
        words = sorted({m.group(0).lower() for m in BANNED.finditer(text)})
        print(f"made {name}: {len(text)} chars" + (f". REVIEW banned words: {words}" if words else ""))
        manifest.record(f"drafts/{name}.md", provider="NanoGPT", model=args.text_model, prompt=prompt, key_used=used, licence="Draft only. Needs human review.")


class Budget:
    def __init__(self, cap: int):
        self.left = cap

    def take(self) -> bool:
        if self.left <= 0:
            print("item cap reached, stopping")
            return False
        self.left -= 1
        return True


def install() -> None:
    """Copy finished assets into the frontend, plus the list the UI reads at run time."""
    cues = PUBLIC / "cues"
    art = PUBLIC / "art"
    for folder, source in ((cues, GENERATED / "cues"), (art, GENERATED / "art")):
        folder.mkdir(parents=True, exist_ok=True)
        for path in source.glob("*"):
            if not path.name.startswith("."):
                (folder / path.name).write_bytes(path.read_bytes())
    (cues / "manifest.json").write_text(json.dumps({"files": sorted(p.name for p in cues.glob("*.mp3"))}, indent=2))
    (art / "manifest.json").write_text(json.dumps({"files": sorted(p.name for p in art.glob("*.webp"))}, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, default=ROOT / ".env")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--max-items", type=int, default=25, help="Hard cap on paid calls in one run")
    parser.add_argument("--only", choices=["audio", "images", "drafts"], action="append")
    parser.add_argument("--image-model", default="blackforestlabs/flux-3/klein/text-to-image")
    parser.add_argument("--text-model", default="gemini-2.5-flash")
    args = parser.parse_args()
    env = read_env(args.env)
    manifest = Manifest()
    budget = Budget(args.max_items)
    only = set(args.only or ["audio", "images", "drafts"])
    failed = False
    for name, runner in (("audio", run_audio), ("images", run_images), ("drafts", run_drafts)):
        if name not in only:
            continue
        try:
            runner(args, env, manifest, budget)
        except (RuntimeError, urllib.error.URLError, KeyError, ValueError, subprocess.CalledProcessError) as exc:
            print(f"{name} stopped: {exc}", file=sys.stderr)
            failed = True
    if not args.dry_run:
        install()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
