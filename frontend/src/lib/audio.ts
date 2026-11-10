// Voice cues and soft sounds. Generated clips are used when present; otherwise short browser
// tones, so the app works with no assets at all. Everything here is local to the browser.
type Cue = 'inhale' | 'exhale' | 'pause' | 'follow' | 'approved' | 'retry' | 'declined' | 'tick' | 'chime' | 'deny' | 'camera';

const FILES: Record<Cue, string> = {
  inhale: 'breathe-in', exhale: 'breathe-out', pause: 'pause', follow: 'follow-the-circle', approved: 'approved',
  retry: 'not-matched', declined: 'check-declined', tick: 'tick', chime: 'chime', deny: 'deny', camera: 'camera-on',
};
const TONES: Partial<Record<Cue, [number, number]>> = {
  tick: [660, 0.06], chime: [880, 0.35], deny: [220, 0.3], camera: [520, 0.12], inhale: [523, 0.12], exhale: [392, 0.12], pause: [440, 0.08],
};

let available: Set<string> | null = null;
let context: AudioContext | null = null;
let muted = false;
try {
  muted = localStorage.getItem('pob-muted') === '1';
} catch {
  muted = false;
}

async function manifest(): Promise<Set<string>> {
  if (available) return available;
  try {
    const reply = await fetch('/cues/manifest.json');
    const data = reply.ok ? await reply.json() : { files: [] };
    available = new Set<string>(data.files ?? []);
  } catch {
    available = new Set();
  }
  return available;
}

function tone(frequency: number, seconds: number) {
  try {
    context ??= new AudioContext();
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + seconds);
    osc.connect(gain).connect(context.destination);
    osc.start();
    osc.stop(context.currentTime + seconds);
  } catch {
    // Sound is optional.
  }
}

export async function play(cue: Cue) {
  if (muted) return;
  const files = await manifest();
  const name = FILES[cue];
  if (files.has(`${name}.mp3`)) {
    new Audio(`/cues/${name}.mp3`).play().catch(() => undefined);
    return;
  }
  const spec = TONES[cue];
  if (spec) tone(spec[0], spec[1]);
}

export function isMuted() {
  return muted;
}

export function setMuted(next: boolean) {
  muted = next;
  try {
    localStorage.setItem('pob-muted', next ? '1' : '0');
  } catch {
    // Only a convenience.
  }
}
