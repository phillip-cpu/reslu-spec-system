const FATAL_SPEECH_RECOGNITION_ERRORS = new Set([
  "audio-capture",
  "bad-grammar",
  "language-not-supported",
  "not-allowed",
  "phrases-not-supported",
  "service-not-allowed",
]);

export function isFatalSpeechRecognitionError(error: string): boolean {
  return FATAL_SPEECH_RECOGNITION_ERRORS.has(error.toLowerCase());
}

export function speechRecognitionErrorMessage(error: string): string {
  switch (error.toLowerCase()) {
    case "notallowederror":
    case "not-allowed":
      return "Safari cannot use the microphone. Tap the page menu in Safari’s address bar, open Website Settings, set Microphone to Allow, then try again.";
    case "service-not-allowed":
      return "Speech recognition is unavailable. Open RESLU directly in Safari—not from a Home Screen icon or another app—and make sure Siri is enabled in Settings.";
    case "audio-capture":
      return "Safari cannot access an iPhone microphone. Check this site’s Microphone permission in Safari’s Website Settings, then try again.";
    case "language-not-supported":
      return "Australian English speech recognition is unavailable on this iPhone. Make sure Siri is enabled, then try again.";
    default:
      return "Voice could not start on this iPhone. Open RESLU directly in Safari, allow microphone access, and make sure Siri is enabled.";
  }
}

/**
 * Safari can reject an otherwise minimal WebRTC microphone or SDP setup with
 * an OverconstrainedError whose only useful detail is "Invalid constraint".
 * The legacy Safari speech path is slower, but it is a working recovery path
 * and is preferable to leaving the call screen interrupted.
 */
export function shouldFallbackToLegacyVoice(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const candidate = reason as { name?: unknown; message?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name.toLowerCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  return name === "overconstrainederror" || message.includes("invalid constraint");
}
