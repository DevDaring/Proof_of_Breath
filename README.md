# Proof of Breath

A physiological approval gate for destructive developer commands. Routine commands pass untouched. When an AI coding agent tries something it cannot undo, such as `terraform destroy` or `DROP TABLE`, the command is held and a window opens with a breathing pattern that is different every time. It runs only if a live person's breathing, measured from a webcam by the Presage SmartSpectra SDK, follows that pattern and a live pulse is present.

![Abstract waves of light](assets/generated/art/hero.webp)

**Live demo:** <https://pob.koushikdeb.com>. The login page is filled in with jury details: press **Sign in**. You get a private sandbox that can never approve a real command. In it you can use **your own webcam** for a real Presage SDK reading, or the clearly labelled simulated sensor.

**Case study.** Open **Case study** for real SDK output from a recorded person (numbers only, no frames), challenged with fresh patterns by the real verifier. Rebuild it with `scripts/build_case_study.py`; the results are in [docs/sdk-notes.md](docs/sdk-notes.md).

**Live reading.** Open **Live reading** to see the SDK's pulse rate, breathing rate and breathing movement from your camera for one minute, with its own confidence values. Nothing is recorded.

## Why

AI coding agents have destroyed production data, and "are you sure? [y/N]" prompts fail because approval becomes a reflex. A breath signature cannot be produced by the agent, cannot be satisfied by a reflexive keypress, and cannot be replayed, because the pattern is new each time.

**It proves that a live, attentive person followed a fresh pattern. It is an attention gate, not identity authentication.**

## How it works

```
 Hook, git, or CLI  --->  FastAPI + PostgreSQL  <--- Desktop bridge (Node + SmartSpectra SDK)
 sees the command         rules, challenges,          on the owner's machine. Video stays there.
 and waits                verifier, receipts
                               |      ^
                               |      +------------ Camera relay slots (Node + SmartSpectra SDK)
                               v                    on the server, one capture per process.
                        React gate window  -------> Frames from the browser camera, decoded in
                        pacer, live curves,         memory for the SDK and dropped. Never stored.
                        camera, SDK readings
```

There are three sensors. **Your camera** runs the SDK on the server from frames your browser sends for that one check, using the SDK's custom frame input (`useCustomInput` and `sendFrame`). The **desktop bridge** runs the SDK next to the webcam, so video never leaves that machine. The **simulated** sensor replays synthetic signals and is only offered in sandboxes.

1. **Fixed rules decide what is gated.** Regular expressions only. No AI ever decides this.
2. **The server issues a signed, random challenge**, plus 20 decoy patterns that stay on the server.
3. **The sensor streams SDK metrics** only while the check runs. The camera is off otherwise. A browser camera joins a capture with a signed ticket that is good for one capture on one relay slot.
4. **The server scores the attempt.** The browser only renders.
5. **A pass issues one token**, valid for 30 seconds and bound to the SHA-256 of that exact command.
6. **A receipt joins a tamper-evident hash chain.**

### The research parts

- **Active challenge-response.** The system issues a random pattern and verifies the response, rather than passively watching.
- **Decoy discrimination.** Does the breathing match *this* pattern better than 20 others from the same distribution? This is the anti-replay core.
- **Cardiorespiratory coupling.** Does the pulse move with the pattern? Reported only. It becomes a gate only if live trials support it (AUC of at least 0.8). The SDK's pulse rate is a 12-second average, so this uses a beat-to-beat series from the arterial pressure trace when available.

Results: [docs/evaluation-results.md](docs/evaluation-results.md). **No live trials have been run yet, so that page currently holds simulated checks of the verifier only.** Real-video findings are in [docs/sdk-notes.md](docs/sdk-notes.md).

## Signals used

| SDK signal | Used for |
| --- | --- |
| Chest breathing trace | Pattern match, timing, breath count, decoy margin |
| Pulse rate and confidence | Live-pulse check |
| Arterial pressure trace | Coupling score (reported only) |
| Validation status | Face in view, plus the hints shown to the person |
| Breathing rate and confidence | Shown to the person only. Never part of a decision |

## Setup on Windows 10

You need PostgreSQL 16 (or Docker), Python 3.11+, Node 20+, and a Presage API key from [physiology.presagetech.com](https://physiology.presagetech.com/auth/login).

```powershell
copy .env.example .env      # then fill in the values
docker compose up -d        # or use a local PostgreSQL

cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
$env:POB_ENV_FILE = "..\.env"
.venv\Scripts\alembic upgrade head
.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8765

cd ..\frontend
npm ci
npm run dev

cd ..\bridge
npm ci
npm run check               # lists cameras
npm start
```

Set `POB_BACKEND_WS=ws://127.0.0.1:8765` for the bridge, and `POB_PUBLIC_URL=http://127.0.0.1:5173` for the backend. macOS (Apple Silicon) and Linux are the same apart from paths. Everything except the live webcam path has been run on Linux. Windows has not been tested yet.

### Using the hosted backend

Run only the bridge and the hooks on your machine. Set `POB_BRIDGE_TOKEN` and `POB_BACKEND_WS=wss://pob.koushikdeb.com` in `bridge/.env`, then sign in as owner.

### Camera framing

**Keep your face and upper chest in view.** The SDK gives no readings at all, not even pulse, until the chest is visible. Put the camera on a stand, use even light on your face, sit still, do not talk, and prefer plain, lighter clothing.

### Install the hooks

Set `POB_URL` and `POB_INTERCEPTOR_TOKEN` in your environment, or put them in `~/.pob/config.json` as `{"url": "...", "token": "..."}`. Keep this token out of the agent's working directory.

**Claude Code:** merge [interceptors/claude-code/settings.example.json](interceptors/claude-code/settings.example.json) into your settings and fix the path. `onFailure: block` needs Claude Code 2.1.295 or later.

**Git:** copy `interceptors/git/pre-push` into a repository's `.git/hooks/`, and put `interceptors/common` at `~/.pob/common`.

**CLI:** `pob run -- <command>`, `pob status`, `pob receipts`, `pob verify-chain`.

**PowerShell (optional):** dot-source `interceptors/powershell/pob-wrappers.ps1` to route `terraform`, `kubectl` and `psql` through `pob run`.

## Judge quick test

No key or install needed. Open the live demo and press **Sign in**. Then:

1. Accept the consent notice.
2. Open **Live reading**, keep your face and upper chest in view, and press **Start a 60 second reading**. The first pulse value arrives after about 12 seconds.
3. Press **Run it through the gate**. Choose **Your camera** to follow the pattern for real (the first time asks for one slow breath to calibrate), or **Simulated**, pick a scenario and press **Start check**.
4. With the simulated sensor, try **Follows the pacer**, then **A photo**, **Replays a recorded session** and **Ignores the pacer**.
5. Try **Use fallback** for the accessible path.
6. See **Receipts** for the verified chain, and **Evaluation** for an instant synthetic batch or live trials with your camera.
7. Open **Case study**: 330 s of a real recorded person read by the SDK on the server, with framing gaps shaded. Press **Draw a pattern** to challenge that real trace with the real verifier. The person never followed a pacer, and 0 of 200 patterns passed.

Simulated mode replays synthetic signals, not a human recording. It is labelled on every screen and is refused real commands in two separate places on the server.

## Accessible fallback

For people who cannot do paced breathing or who decline the camera: type the exact target name (for example, the database or branch), wait 20 seconds, and the receipt records `method=fallback`. The delay is enforced on the server.

## Consent, data and threat model

- [Consent and data handling](docs/consent-and-data.md): video is never stored, browser-camera frames are decoded in memory and dropped, and receipts hold a hash of the command, not its text, by default.
- [Threat model](docs/threat-model.md). In short: this stops an agent approving itself and a person rubber-stamping. It does not stop someone with admin rights who removes the hooks or forges bridge traffic.

## Limitations

- **No person has followed a pattern through the live SDK yet**, so false reject rates on real people are unknown. Thresholds are provisional. The browser camera path is tested end to end with real Chrome and a recorded real face, which gives real SDK readings but cannot follow a pattern.
- With the browser camera, frames cross the network to the server. They are never stored, but this is a weaker privacy position than the desktop bridge, which keeps video on the device.
- Three relay slots run on the demo server, so at most three camera checks run at once. A fourth waits.
- The exact breath count may be too strict on real traces. See [docs/sdk-notes.md](docs/sdk-notes.md).
- Regular expressions can be evaded by scripts on disk and encoded payloads.
- The default `S_decoy` threshold differs from the original design, for measured reasons recorded in the notes.

## Tests

```bash
cd backend && POB_TEST_ENV_FILE=test.env POB_ENV_FILE=test.env .venv/bin/pytest
cd bridge && npm test
cd e2e && npx playwright test    # clicks every button on the deployed site
```

`test_language.py` fails the build if banned wording appears outside the one disclaimer sentence.

## Credits

[Presage SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra). Voice cues and sounds by ElevenLabs. Images and draft text by NanoGPT, listed in [assets/manifest.json](assets/manifest.json). Real-video testing used public research datasets from Kaggle, which are not redistributed here. The case study's numbers come from the SDK run on subject 1 of the [rPPG Dataset](https://www.kaggle.com/datasets/ashfakyeafi/rppg-dataset) by Ashfak Yeafi; no frame of it is included.
