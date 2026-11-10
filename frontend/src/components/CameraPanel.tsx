import { useEffect, useRef } from 'react';
import { CameraStatus } from '../lib/camera';

const STATUS_TEXT: Record<CameraStatus, string> = {
  off: 'Camera off',
  preview: 'Preview only, nothing is sent',
  connecting: 'Connecting to the SDK…',
  streaming: 'Streaming to the SDK',
  error: 'Camera problem',
};

/** Mirrored self-view with a framing guide. The guide shows where the face and upper chest should sit. */
export function CameraPanel({ stream, status, error, fps, hint, onPreview, previewing, canPreview = true }: {
  stream: MediaStream | null; status: CameraStatus; error: string | null; fps: number; hint?: string;
  onPreview?: (on: boolean) => void; previewing?: boolean; canPreview?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) el.play().catch(() => undefined);
  }, [stream]);
  const streaming = status === 'streaming';
  return (
    <div className={`camera-panel ${stream ? 'has-video' : ''} ${streaming ? 'streaming' : ''}`} data-testid="camera-panel">
      <div className="camera-frame">
        <video ref={video} muted playsInline aria-label="Your camera" />
        {stream && (
          <svg className="frame-guide" viewBox="0 0 400 300" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
            <ellipse cx="200" cy="112" rx="58" ry="74" />
            <path d="M70 300 C 90 230, 140 205, 200 205 C 260 205, 310 230, 330 300" />
          </svg>
        )}
        {!stream && (
          <div className="camera-empty">
            <span className="camera-glyph" aria-hidden="true" />
            <p>{status === 'error' ? error : 'Face and upper chest in view, even light, sit still.'}</p>
          </div>
        )}
        <span className={`camera-chip ${status}`} data-testid="camera-status">
          <i aria-hidden="true" />{STATUS_TEXT[status]}{streaming && fps > 0 ? ` · ${fps} fps` : ''}
        </span>
      </div>
      {error && stream && <p className="hint bad" role="alert">{error}</p>}
      {hint && (status === 'streaming' || status === 'connecting') && <p className="hint" data-testid="camera-hint">{hint}</p>}
      {onPreview && canPreview && status !== 'streaming' && status !== 'connecting' && (
        <button type="button" className="link" onClick={() => onPreview(!previewing)} data-testid="camera-preview">
          {previewing ? 'Turn the preview off' : 'Check my framing'}
        </button>
      )}
    </div>
  );
}
