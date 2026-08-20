export interface MicrophoneHealthMonitor {
  stop(): void;
}

export interface MicrophoneHealthOptions {
  timeoutMs?: number;
  activityThreshold?: number;
  onActivity(): void;
  onSilence(): void;
}

export function microphoneSamplesAreActive(samples: Uint8Array, threshold = 0.012) {
  if (samples.length === 0) return false;
  let energy = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    energy += normalized * normalized;
  }
  return Math.sqrt(energy / samples.length) >= threshold;
}

/**
 * Confirms that a live MediaStream contains audible microphone samples.
 * Merely receiving a live track is not sufficient on iOS: WebKit can expose
 * a track while its audio session is producing silence.
 */
export function monitorMicrophoneHealth(
  stream: MediaStream,
  options: MicrophoneHealthOptions,
): MicrophoneHealthMonitor | null {
  if (typeof window === "undefined") return null;
  const AudioContextConstructor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;

  const context = new AudioContextConstructor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let stopped = false;
  let frame = 0;
  let timer = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    source.disconnect();
    analyser.disconnect();
    void context.close();
  };
  const inspect = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(samples);
    if (microphoneSamplesAreActive(samples, options.activityThreshold)) {
      stop();
      options.onActivity();
      return;
    }
    frame = window.requestAnimationFrame(inspect);
  };
  timer = window.setTimeout(() => {
    stop();
    options.onSilence();
  }, options.timeoutMs ?? 12_000);
  void context.resume().finally(() => {
    if (!stopped) frame = window.requestAnimationFrame(inspect);
  });
  return { stop };
}
