# Platform Support

## Speech recognition

The app has three ASR paths:

- Windows native: uses `Windows.Media.SpeechRecognition` and is only available on Windows. This API does not expose an application-level profanity filter switch, so the app cannot reliably mirror the Win+H voice typing profanity setting.
- WebView: uses `SpeechRecognition` / `webkitSpeechRecognition` when the embedded WebView exposes it. The Web Speech API does not define a profanity filter setting, so filtering behavior is controlled by the WebView engine or its backing speech service.
- OpenAI-compatible ASR: records microphone audio and sends it to the configured transcription service. This is the recommended path when exact, unsanitized transcription matters, because filtering behavior depends on the chosen service and prompt rather than the OS/WebView speech layer.

## macOS

The desktop shell is Tauri v2 and the core pet UI can run on macOS. Windows native ASR is automatically treated as unavailable outside Windows, so macOS should use WebView ASR when supported by the system WebView, or OpenAI-compatible ASR for the most predictable behavior.

The tray integration is implemented through Tauri's cross-platform tray APIs. On macOS it appears in the menu bar; on Windows it appears in the notification area, including hidden tray icons.
