import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_DURATION_MS = 120_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** Sends a recording, base64-encoded, for transcription; the reply's text is the transcript. */
export type TranscribeAudio = (audio: { audio: string; format: string }, options: { signal: AbortSignal }) => Promise<{ text?: unknown } | null | undefined>;
export type VoiceStatus = 'idle' | 'requesting' | 'recording' | 'transcribing';
type Support = { mime: string; format: string; reason?: undefined } | { reason: string; mime?: undefined; format?: undefined };
interface Recording {
  mime: string; format: string; onTranscribe: TranscribeAudio; onTranscript: (text: string) => void;
  phase: 'requesting' | 'recording' | 'stopping' | 'transcribing'; controller: AbortController; chunks: Blob[]; bytes: number;
  stream?: MediaStream | null; recorder?: MediaRecorder | null; timeout?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval>; started?: number;
}

const RECORDING_TYPES: [mime: string, format: string][] = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/webm', 'webm'],
  ['audio/mp4', 'm4a'],
  ['audio/ogg;codecs=opus', 'ogg'],
  ['audio/ogg', 'ogg'],
  ['audio/wav', 'wav'],
];

function recordingSupport(): Support {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { reason: 'Voice input is unavailable in this browser.' };
  }
  if (window.isSecureContext === false) {
    return { reason: 'Open this app on localhost or HTTPS to use the microphone.' };
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== 'function' || typeof window.MediaRecorder.isTypeSupported !== 'function') {
    return { reason: 'Voice input is unavailable here. Open the app in Chrome or Safari.' };
  }
  const type = RECORDING_TYPES.find(([mime]) => window.MediaRecorder.isTypeSupported(mime));
  return type ? { mime: type[0], format: type[1] } : { reason: 'This browser cannot record a supported audio format.' };
}

function microphoneError(error: { name?: string } | null | undefined) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return 'Microphone access was denied. Allow access in your browser or system settings, then retry.';
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'No microphone found. Connect a microphone, then retry.';
  }
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
    return 'The microphone is unavailable. Close other recording apps, then retry.';
  }
  return 'Could not start recording. Check microphone access, then retry.';
}

function releaseRecording(operation: Recording) {
  clearTimeout(operation.timeout);
  clearInterval(operation.interval);
  const recorder = operation.recorder;
  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* The device may have stopped already. */ }
    }
  }
  operation.stream?.getTracks().forEach(track => track.stop());
  operation.stream = null;
  operation.recorder = null;
}

function encodeAudio(blob: Blob, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const aborted = () => new DOMException('Transcription canceled.', 'AbortError');
    const finish = <T>(callback: (value: T) => void, value: T) => {
      signal.removeEventListener('abort', abort);
      reader.onload = reader.onerror = reader.onabort = null;
      callback(value);
    };
    const abort = () => {
      reader.abort();
      finish(reject, aborted());
    };
    if (signal.aborted) return reject(aborted());
    signal.addEventListener('abort', abort, { once: true });
    reader.onload = () => {
      const value = String(reader.result || '');
      const separator = value.indexOf(',');
      if (separator < 0) return finish(reject, new Error('Could not read the recording. Please retry.'));
      finish(resolve, value.slice(separator + 1));
    };
    reader.onerror = () => finish(reject, new Error('Could not read the recording. Please retry.'));
    reader.onabort = () => finish(reject, aborted());
    reader.readAsDataURL(blob);
  });
}

export function useDescriptionVoice({ onTranscribe, onTranscript }: { onTranscribe: TranscribeAudio; onTranscript: (text: string) => void }) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const active = useRef<Recording | null>(null);
  const mounted = useRef(true);
  const callbacks = useRef({ onTranscribe, onTranscript });
  callbacks.current = { onTranscribe, onTranscript };
  const support = recordingSupport();

  const cancel = useCallback(() => {
    const operation = active.current;
    active.current = null;
    if (operation) {
      operation.controller.abort();
      releaseRecording(operation);
      operation.chunks = [];
    }
    if (mounted.current) {
      setStatus('idle');
      setElapsedSeconds(0);
      setError('');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);

  const stop = useCallback(() => {
    const operation = active.current;
    if (!operation) return;
    if (operation.phase === 'requesting') return cancel();
    if (operation.phase !== 'recording' || operation.recorder?.state !== 'recording') return;
    operation.phase = 'stopping';
    clearTimeout(operation.timeout);
    clearInterval(operation.interval);
    try { operation.recorder.stop(); } catch {
      cancel();
      if (mounted.current) setError('Could not finish recording. Please retry.');
    } finally {
      operation.stream?.getTracks().forEach(track => track.stop());
    }
  }, [cancel]);

  const start = useCallback(async () => {
    if (!mounted.current || active.current) return;
    const available = recordingSupport();
    setError('');
    setElapsedSeconds(0);
    if (available.reason) {
      setError(available.reason);
      return;
    }
    const operation: Recording = {
      // Support without a reason names its recording type.
      ...(available as Extract<Support, { mime: string }>),
      ...callbacks.current,
      phase: 'requesting',
      controller: new AbortController(),
      chunks: [],
      bytes: 0,
    };
    active.current = operation;
    setStatus('requesting');
    const current = () => mounted.current && active.current === operation;
    const fail = (message: string) => {
      if (!current()) return;
      cancel();
      setError(message);
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!current()) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      operation.stream = stream;
      const recorder = new window.MediaRecorder(stream, { mimeType: operation.mime });
      operation.recorder = recorder;
      recorder.ondataavailable = event => {
        if (!current() || !event.data?.size) return;
        operation.bytes += event.data.size;
        if (operation.bytes > MAX_AUDIO_BYTES) {
          fail('Recording is too large. Please record a shorter description.');
          return;
        }
        operation.chunks.push(event.data);
      };
      recorder.onerror = () => fail('Recording stopped unexpectedly. Check your microphone, then retry.');
      recorder.onstop = async () => {
        if (!current()) return;
        releaseRecording(operation);
        if (!operation.bytes) {
          fail('The recording was empty. Please try again.');
          return;
        }
        operation.phase = 'transcribing';
        setStatus('transcribing');
        try {
          const blob = new Blob(operation.chunks, { type: operation.mime });
          operation.chunks = [];
          const audio = await encodeAudio(blob, operation.controller.signal);
          if (!current()) return;
          const result = await operation.onTranscribe({ audio, format: operation.format }, { signal: operation.controller.signal });
          if (!current()) return;
          const text = typeof result?.text === 'string' ? result.text.trim() : '';
          if (!text) {
            fail('No speech detected. Please try again.');
            return;
          }
          active.current = null;
          setStatus('idle');
          setElapsedSeconds(0);
          operation.onTranscript(text);
        } catch (failure) {
          const error = failure as Error | undefined;
          fail(error?.name === 'AbortError' ? 'Transcription canceled. Please retry.' : error?.message || 'Could not transcribe the recording. Please retry.');
        }
      };
      recorder.start(500);
      operation.phase = 'recording';
      operation.started = performance.now();
      setStatus('recording');
      operation.interval = setInterval(() => {
        if (current()) setElapsedSeconds(Math.min(120, Math.floor((performance.now() - operation.started!) / 1000)));
      }, 500);
      operation.timeout = setTimeout(() => { if (current()) stop(); }, MAX_DURATION_MS);
    } catch (failure) {
      fail(microphoneError(failure as Error | undefined));
    }
  }, [cancel, stop]);

  const clearError = useCallback(() => setError(''), []);
  return { status, error, start, stop, cancel, supported: !support.reason, unsupportedReason: support.reason || '', elapsedSeconds, clearError };
}
