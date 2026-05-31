use base64::{engine::general_purpose, Engine as _};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, State, Window,
};
#[cfg(not(mobile))]
use tauri::{
    LogicalPosition, LogicalSize, PhysicalPosition, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};
#[cfg(not(mobile))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
#[cfg(windows)]
use tauri_plugin_opener::OpenerExt;
#[cfg(windows)]
use windows::{
    core::{AgileReference, Ref, HSTRING},
    Foundation::TypedEventHandler,
    Globalization::Language,
    Media::SpeechRecognition::{
        SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionMode,
        SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession,
        SpeechRecognitionConfidence, SpeechRecognitionHypothesisGeneratedEventArgs,
        SpeechRecognitionResultStatus, SpeechRecognitionScenario, SpeechRecognitionTopicConstraint,
        SpeechRecognizer, SpeechRecognizerState, SpeechRecognizerStateChangedEventArgs,
    },
};

const DEFAULT_LLM_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_LLM_TIMEOUT_SECS: u64 = 45;
const DEFAULT_TTS_TIMEOUT_SECS: u64 = 60;
const LLM_CONFIG_FILE: &str = "llm_config.json";
const TTS_CONFIG_FILE: &str = "tts_config.json";
const ASR_CONFIG_FILE: &str = "asr_config.json";
const MANAGED_GPT_SOVITS_CONFIG_FILE: &str = "managed-gpt-sovits-yua-v2.yaml";
const INTERACTION_HISTORY_FILE: &str = "interaction_history.json";
const CUSTOM_SKINS_DIR: &str = "custom_skins";
const MAX_HISTORY_RECORDS: usize = 240;
const TTS_PROVIDER_GPT_SOVITS: &str = "gptSovits";
const TTS_PROVIDER_MANAGED_GPT_SOVITS: &str = "managedGptSovits";
const TTS_PROVIDER_OPENAI_COMPATIBLE: &str = "openAiCompatible";
const TTS_PROVIDER_CUSTOM_JSON: &str = "customJson";
const ASR_PROVIDER_BROWSER: &str = "browser";
const ASR_PROVIDER_WINDOWS_NATIVE: &str = "windowsNative";
const ASR_PROVIDER_OPENAI_COMPATIBLE: &str = "openAiCompatible";
const DEFAULT_ASR_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_ASR_MODEL: &str = "whisper-1";
const DEFAULT_ASR_TIMEOUT_SECS: u64 = 45;
const DEFAULT_ASR_PROMPT: &str =
    "请按简体中文原话转写，保留口语、网络用语、脏话、成人用语和语气词，不要替换成委婉说法。";
const DEFAULT_MANAGED_GPT_SOVITS_PORT: u16 = 9880;
const DEFAULT_MANAGED_GPT_SOVITS_ROOT: &str = r"D:\pyprojects\GPT-SoVITS";
const DEFAULT_YUA_GPT_WEIGHT_REL: &str = "GPT_weights_v2/yua-s-v2-e50.ckpt";
const DEFAULT_YUA_SOVITS_WEIGHT_REL: &str = "SoVITS_weights_v2/yua-s-v2_e24_s672.pth";
const DEFAULT_YUA_REF_AUDIO_REL: &str =
    "logs/yua-s-v2/5-wav32k/ua23102619.mp3_0144998912_0145146368.wav";
const DEFAULT_YUA_PROMPT_TEXT: &str = "然后再盛两杯小果汁儿.";
const MANAGED_GPT_SOVITS_STARTUP_TIMEOUT_SECS: u64 = 180;
const TTS_ASSET_SCAN_LIMIT_PER_KIND: usize = 500;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(not(mobile))]
const PET_INPUT_SHORTCUT_LABEL: &str = "Ctrl+Alt+Space";
const SETTINGS_WINDOW_WIDTH: f64 = 980.0;
#[cfg(not(mobile))]
const SETTINGS_WINDOW_HEIGHT: f64 = 760.0;
const DEFAULT_PET_INTERACTION_SYSTEM_PROMPT: &str = "你是银白发桌宠，正在和用户互动。用户会先选择一个交互控件，例如手指、手掌、嘴、脚、羽毛、梳子或零食，再点击桌宠的具体部位。请参考控件、部位、坐标和最近交互历史，用中文给出一句自然、温柔、俏皮的桌宠回应。回复不超过 42 个汉字，不要解释，不要加引号。";

#[derive(Debug, Clone, Deserialize, Serialize)]
struct LlmMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmChatRequest {
    messages: Vec<LlmMessage>,
    model: Option<String>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmChatResponse {
    content: String,
    model: String,
    finish_reason: Option<String>,
    usage: Option<LlmUsage>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredLlmConfig {
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    timeout_secs: Option<u64>,
    pet_interaction_system_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLlmConfigRequest {
    api_key: Option<String>,
    clear_api_key: bool,
    base_url: String,
    model: String,
    timeout_secs: u64,
    #[serde(default)]
    pet_interaction_system_prompt: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmConfigView {
    has_api_key: bool,
    masked_api_key: Option<String>,
    base_url: String,
    model: String,
    timeout_secs: u64,
    pet_interaction_system_prompt: String,
    default_pet_interaction_system_prompt: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredTtsConfig {
    enabled: Option<bool>,
    provider: Option<String>,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    voice: Option<String>,
    media_type: Option<String>,
    text_lang: Option<String>,
    ref_audio_path: Option<String>,
    prompt_lang: Option<String>,
    prompt_text: Option<String>,
    speed_factor: Option<f32>,
    timeout_secs: Option<u64>,
    managed_root: Option<String>,
    managed_python: Option<String>,
    managed_port: Option<u16>,
    gpt_weight_path: Option<String>,
    sovits_weight_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveTtsConfigRequest {
    enabled: bool,
    provider: String,
    endpoint: String,
    api_key: Option<String>,
    clear_api_key: bool,
    model: Option<String>,
    voice: Option<String>,
    media_type: String,
    text_lang: Option<String>,
    ref_audio_path: Option<String>,
    prompt_lang: Option<String>,
    prompt_text: Option<String>,
    speed_factor: f32,
    timeout_secs: u64,
    managed_root: Option<String>,
    managed_python: Option<String>,
    managed_port: Option<u16>,
    gpt_weight_path: Option<String>,
    sovits_weight_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsConfigView {
    enabled: bool,
    provider: String,
    endpoint: String,
    has_api_key: bool,
    masked_api_key: Option<String>,
    model: String,
    voice: String,
    media_type: String,
    text_lang: String,
    ref_audio_path: String,
    prompt_lang: String,
    prompt_text: String,
    speed_factor: f32,
    timeout_secs: u64,
    managed_root: String,
    managed_python: String,
    managed_port: u16,
    gpt_weight_path: String,
    sovits_weight_path: String,
}

#[derive(Default)]
struct ManagedGptSovitsState {
    child: Mutex<Option<Child>>,
}

#[cfg(windows)]
#[derive(Default)]
struct NativeSpeechState {
    session: Mutex<Option<NativeSpeechSession>>,
}

#[cfg(windows)]
struct NativeSpeechSession {
    recognizer: SpeechRecognizer,
    session: SpeechContinuousRecognitionSession,
    result_token: i64,
    completed_token: i64,
    hypothesis_token: i64,
    state_token: i64,
    _result_handler: AgileReference<
        TypedEventHandler<
            SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionResultGeneratedEventArgs,
        >,
    >,
    _completed_handler: AgileReference<
        TypedEventHandler<
            SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionCompletedEventArgs,
        >,
    >,
    _hypothesis_handler: AgileReference<
        TypedEventHandler<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>,
    >,
    _state_handler:
        AgileReference<TypedEventHandler<SpeechRecognizer, SpeechRecognizerStateChangedEventArgs>>,
}

#[cfg(windows)]
impl Drop for NativeSpeechState {
    fn drop(&mut self) {
        if let Ok(slot) = self.session.get_mut() {
            if let Some(session) = slot.take() {
                stop_native_speech_session(session);
            }
        }
    }
}

impl Drop for ManagedGptSovitsState {
    fn drop(&mut self) {
        if let Ok(slot) = self.child.get_mut() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TtsSynthesisRequest {
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsSynthesisResponse {
    audio_data_url: String,
    content_type: String,
    provider: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PickTtsPathRequest {
    kind: String,
    current_path: Option<String>,
    root_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListTtsAssetsRequest {
    root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsAssetOption {
    label: String,
    path: String,
    prompt_text: Option<String>,
    duration_secs: Option<f32>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredAsrConfig {
    provider: Option<String>,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    language: Option<String>,
    prompt: Option<String>,
    timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAsrConfigRequest {
    provider: String,
    endpoint: String,
    api_key: Option<String>,
    clear_api_key: bool,
    model: Option<String>,
    language: Option<String>,
    prompt: Option<String>,
    timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AsrConfigView {
    provider: String,
    endpoint: String,
    has_api_key: bool,
    masked_api_key: Option<String>,
    model: String,
    language: String,
    prompt: String,
    timeout_secs: u64,
    default_prompt: String,
    native_speech_available: bool,
    native_speech_filter_configurable: bool,
    browser_speech_filter_configurable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrTranscriptionRequest {
    audio_data_url: String,
    mime_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AsrTranscriptionResponse {
    text: String,
    provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSpeechRecognitionEvent {
    transcript: String,
    confidence: f64,
    provider: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsAssetCatalog {
    gpt_weights: Vec<TtsAssetOption>,
    sovits_weights: Vec<TtsAssetOption>,
    ref_audios: Vec<TtsAssetOption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowPosition {
    x: f64,
    y: f64,
    window_width: Option<f64>,
    physical_x: Option<f64>,
    physical_y: Option<f64>,
}

#[cfg(all(not(mobile), target_os = "windows"))]
#[repr(C)]
struct WinPoint {
    x: i32,
    y: i32,
}

#[cfg(all(not(mobile), target_os = "windows"))]
#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(point: *mut WinPoint) -> i32;
}

#[cfg(all(not(mobile), target_os = "windows"))]
fn global_cursor_position_physical() -> Option<(f64, f64)> {
    let mut point = WinPoint { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok == 0 {
        None
    } else {
        Some((f64::from(point.x), f64::from(point.y)))
    }
}

#[cfg(all(not(mobile), not(target_os = "windows")))]
fn global_cursor_position_physical() -> Option<(f64, f64)> {
    None
}

#[derive(Debug, Clone)]
struct EffectiveLlmConfig {
    api_key: String,
    base_url: String,
    model: String,
    timeout_secs: u64,
    pet_interaction_system_prompt: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InteractionRecord {
    #[serde(default)]
    id: u64,
    #[serde(default, alias = "timestamp_ms")]
    timestamp_ms: u64,
    #[serde(default)]
    source: String,
    #[serde(default, alias = "interaction_tool")]
    interaction_tool: Option<String>,
    #[serde(default)]
    area: Option<String>,
    #[serde(default, alias = "x_percent")]
    x_percent: Option<f64>,
    #[serde(default, alias = "y_percent")]
    y_percent: Option<f64>,
    #[serde(default, alias = "user_text")]
    user_text: Option<String>,
    #[serde(default, alias = "assistant_text")]
    assistant_text: String,
    #[serde(default, alias = "llm_used")]
    llm_used: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetInteractionRequest {
    source: String,
    #[serde(default, alias = "interaction_tool")]
    interaction_tool: Option<String>,
    #[serde(default)]
    area: Option<String>,
    #[serde(default, alias = "x_percent")]
    x_percent: Option<f64>,
    #[serde(default, alias = "y_percent")]
    y_percent: Option<f64>,
    #[serde(default, alias = "user_text")]
    user_text: Option<String>,
    #[serde(default, alias = "skin_id")]
    skin_id: Option<String>,
    #[serde(default, alias = "skin_name")]
    skin_name: Option<String>,
    #[serde(default, alias = "skin_prompt")]
    skin_prompt: Option<String>,
    affection: u32,
    mood: String,
    #[serde(default, alias = "scene_mode")]
    scene_mode: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetInteractionResponse {
    content: String,
    record: InteractionRecord,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetInteractionStreamEvent {
    stream_id: String,
    phase: String,
    delta: Option<String>,
    content: Option<String>,
    record: Option<InteractionRecord>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmUsage {
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    total_tokens: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomSkinAssets {
    idle: String,
    surprised: String,
    blink: String,
    mouth_talk: String,
    mouth_o: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomSkinManifest {
    schema_version: u32,
    id: String,
    name: String,
    layout: String,
    asset_width: u32,
    asset_height: u32,
    hit_calibration_y: f64,
    assets: CustomSkinAssets,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveCustomSkinImages {
    idle_data_url: String,
    surprised_data_url: String,
    blink_data_url: String,
    mouth_talk_data_url: String,
    mouth_o_data_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveCustomSkinRequest {
    id: Option<String>,
    name: String,
    layout: String,
    asset_width: u32,
    asset_height: u32,
    hit_calibration_y: Option<f64>,
    images: SaveCustomSkinImages,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomSkinImagePaths {
    idle: String,
    surprised: String,
    blink: String,
    mouth_talk: String,
    mouth_o: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomSkinView {
    id: String,
    name: String,
    layout: String,
    asset_width: u32,
    asset_height: u32,
    hit_calibration_y: f64,
    images: CustomSkinImagePaths,
}

#[derive(Debug, Serialize)]
struct OpenAiCompatibleChatRequest<'a> {
    model: &'a str,
    messages: &'a [LlmMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct OpenAiCompatibleChatResponse {
    choices: Vec<OpenAiCompatibleChoice>,
    usage: Option<OpenAiCompatibleUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiCompatibleStreamResponse {
    choices: Vec<OpenAiCompatibleStreamChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiCompatibleChoice {
    message: OpenAiCompatibleMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiCompatibleStreamChoice {
    delta: Option<OpenAiCompatibleMessage>,
    message: Option<OpenAiCompatibleMessage>,
    text: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct OpenAiCompatibleMessage {
    content: Option<serde_json::Value>,
    text: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct OpenAiCompatibleUsage {
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    total_tokens: Option<u32>,
}

#[derive(Debug, Serialize)]
struct GptSovitsTtsRequest<'a> {
    text: &'a str,
    text_lang: &'a str,
    ref_audio_path: &'a str,
    prompt_lang: &'a str,
    prompt_text: &'a str,
    media_type: &'a str,
    speed_factor: f32,
    streaming_mode: bool,
    text_split_method: &'a str,
    batch_size: u32,
    split_bucket: bool,
    parallel_infer: bool,
    repetition_penalty: f32,
}

#[derive(Debug, Serialize)]
struct OpenAiCompatibleSpeechRequest<'a> {
    model: &'a str,
    voice: &'a str,
    input: &'a str,
    response_format: &'a str,
    speed: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomJsonSpeechRequest<'a> {
    text: &'a str,
    input: &'a str,
    model: Option<&'a str>,
    voice: Option<&'a str>,
    format: &'a str,
    media_type: &'a str,
    speed: f32,
}

impl From<OpenAiCompatibleUsage> for LlmUsage {
    fn from(usage: OpenAiCompatibleUsage) -> Self {
        Self {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
        }
    }
}

fn read_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().map(|value| value.trim().to_string()))
        .filter(|value| !value.is_empty())
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn clean_optional_str(value: &str) -> Option<String> {
    let cleaned = value.trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn clean_required(value: &str, field: &str) -> Result<String, String> {
    let cleaned = value.trim().to_string();
    if cleaned.is_empty() {
        Err(format!("{field} 不能为空。"))
    } else {
        Ok(cleaned)
    }
}

fn default_gpt_sovits_root() -> Option<PathBuf> {
    read_env(&["GPT_SOVITS_ROOT", "TTS_GPT_SOVITS_ROOT"])
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .or_else(|| {
            let path = PathBuf::from(DEFAULT_MANAGED_GPT_SOVITS_ROOT);
            path.exists().then_some(path)
        })
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn default_managed_child_path(root: &str, relative: &str) -> String {
    if root.trim().is_empty() {
        String::new()
    } else {
        path_to_string(&PathBuf::from(root).join(relative))
    }
}

fn yaml_path(path: &str) -> String {
    path.trim().replace('\\', "/")
}

fn managed_gpt_sovits_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn normalize_extension(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .trim_start_matches('.')
        .to_ascii_lowercase()
}

fn path_matches_extensions(path: &Path, extensions: &[&str]) -> bool {
    let extension = normalize_extension(path);
    extensions
        .iter()
        .any(|candidate| extension == candidate.trim_start_matches('.').to_ascii_lowercase())
}

fn scan_files_by_extension(
    root: &Path,
    relative_dirs: &[&str],
    extensions: &[&str],
    limit: usize,
) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for relative_dir in relative_dirs {
        if files.len() >= limit {
            break;
        }
        let dir = root.join(relative_dir);
        scan_dir_by_extension(&dir, extensions, limit, &mut files, 0);
    }
    files
}

fn scan_dir_by_extension(
    dir: &Path,
    extensions: &[&str],
    limit: usize,
    files: &mut Vec<PathBuf>,
    depth: usize,
) {
    if files.len() >= limit || depth > 8 || !dir.is_dir() {
        return;
    }

    let mut entries = match fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
        Err(_) => return,
    };
    entries.sort_by_key(|entry| path_priority_key(&entry.path()));

    for entry in entries {
        if files.len() >= limit {
            break;
        }

        let path = entry.path();
        if path.is_dir() {
            scan_dir_by_extension(&path, extensions, limit, files, depth + 1);
        } else if path.is_file() && path_matches_extensions(&path, extensions) {
            files.push(path);
        }
    }
}

fn relative_path_label(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn path_priority_key(path: &Path) -> (u8, String) {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    let priority = if lower.contains("yua-s-v2") {
        0
    } else if lower.contains("yua") {
        1
    } else if lower.contains("ua") {
        2
    } else {
        3
    };
    (priority, lower)
}

fn truncate_label(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn asset_sort_key(option: &TtsAssetOption) -> (u8, String) {
    let (priority, _) = path_priority_key(Path::new(&option.path));
    (priority, option.label.to_ascii_lowercase())
}

fn sort_tts_assets(options: &mut [TtsAssetOption]) {
    options.sort_by_key(asset_sort_key);
}

fn build_weight_options(root: &Path, paths: Vec<PathBuf>) -> Vec<TtsAssetOption> {
    let mut options = paths
        .into_iter()
        .map(|path| TtsAssetOption {
            label: relative_path_label(root, &path),
            path: path_to_string(&path),
            prompt_text: None,
            duration_secs: None,
        })
        .collect::<Vec<_>>();
    sort_tts_assets(&mut options);
    options
}

fn read_wav_duration_secs(path: &Path) -> Option<f32> {
    let mut file = fs::File::open(path).ok()?;
    let mut header = [0_u8; 12];
    file.read_exact(&mut header).ok()?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return None;
    }

    let mut channels = None::<u16>;
    let mut sample_rate = None::<u32>;
    let mut bits_per_sample = None::<u16>;
    let mut data_size = None::<u32>;

    loop {
        let mut chunk_header = [0_u8; 8];
        if file.read_exact(&mut chunk_header).is_err() {
            break;
        }
        let chunk_id = &chunk_header[0..4];
        let chunk_size = u32::from_le_bytes([
            chunk_header[4],
            chunk_header[5],
            chunk_header[6],
            chunk_header[7],
        ]);

        if chunk_id == b"fmt " {
            let mut fmt = vec![0_u8; chunk_size as usize];
            file.read_exact(&mut fmt).ok()?;
            if fmt.len() >= 16 {
                channels = Some(u16::from_le_bytes([fmt[2], fmt[3]]));
                sample_rate = Some(u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]));
                bits_per_sample = Some(u16::from_le_bytes([fmt[14], fmt[15]]));
            }
        } else if chunk_id == b"data" {
            data_size = Some(chunk_size);
            file.seek(SeekFrom::Current(chunk_size as i64)).ok()?;
        } else {
            file.seek(SeekFrom::Current(chunk_size as i64)).ok()?;
        }

        if chunk_size % 2 == 1 {
            file.seek(SeekFrom::Current(1)).ok()?;
        }

        if channels.is_some()
            && sample_rate.is_some()
            && bits_per_sample.is_some()
            && data_size.is_some()
        {
            break;
        }
    }

    let channels = channels? as f32;
    let sample_rate = sample_rate? as f32;
    let bytes_per_sample = bits_per_sample? as f32 / 8.0;
    let data_size = data_size? as f32;
    let bytes_per_second = channels * sample_rate * bytes_per_sample;
    (bytes_per_second > 0.0).then_some((data_size / bytes_per_second * 10.0).round() / 10.0)
}

fn load_ref_audio_prompt_map(root: &Path) -> HashMap<String, String> {
    let prompt_files =
        scan_files_by_extension(root, &["logs"], &["txt"], TTS_ASSET_SCAN_LIMIT_PER_KIND);
    let mut prompt_map = HashMap::new();

    for path in prompt_files {
        if path.file_name().and_then(|name| name.to_str()) != Some("2-name2text.txt") {
            continue;
        }

        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        for line in text.lines() {
            let mut parts = line.split('\t').collect::<Vec<_>>();
            if parts.len() < 2 {
                continue;
            }
            let Some(file_name) = parts
                .first()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let prompt_text = parts.pop().unwrap_or_default().trim();
            if !prompt_text.is_empty() {
                prompt_map
                    .entry(file_name)
                    .or_insert_with(|| prompt_text.to_string());
            }
        }
    }

    prompt_map
}

fn build_ref_audio_options(root: &Path, paths: Vec<PathBuf>) -> Vec<TtsAssetOption> {
    let prompt_map = load_ref_audio_prompt_map(root);
    let mut options = paths
        .into_iter()
        .map(|path| {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            let prompt_text = prompt_map.get(file_name).cloned();
            let duration_secs = if normalize_extension(&path) == "wav" {
                read_wav_duration_secs(&path)
            } else {
                None
            };
            let prompt_label = prompt_text
                .as_deref()
                .map(|text| truncate_label(text, 28))
                .unwrap_or_else(|| relative_path_label(root, &path));
            let duration_label = duration_secs
                .map(|duration| format!("{duration:.1}s · "))
                .unwrap_or_default();

            TtsAssetOption {
                label: format!("{duration_label}{file_name} · {prompt_label}"),
                path: path_to_string(&path),
                prompt_text,
                duration_secs,
            }
        })
        .collect::<Vec<_>>();
    options.sort_by_key(|option| {
        let duration_priority = option
            .duration_secs
            .map(|duration| {
                if (3.0..=10.0).contains(&duration) {
                    0
                } else {
                    1
                }
            })
            .unwrap_or(2);
        let (path_priority, _) = path_priority_key(Path::new(&option.path));
        (
            path_priority,
            duration_priority,
            option.label.to_ascii_lowercase(),
        )
    });
    options
}

fn tts_asset_root(request_root: Option<String>) -> Result<PathBuf, String> {
    clean_optional(request_root)
        .map(PathBuf::from)
        .or_else(default_gpt_sovits_root)
        .ok_or_else(|| "还没有设置 GPT-SoVITS 根目录。".to_string())
}

fn llm_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("获取应用配置目录失败：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建应用配置目录失败：{error}"))?;
    Ok(dir.join(LLM_CONFIG_FILE))
}

fn tts_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("获取应用配置目录失败：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建应用配置目录失败：{error}"))?;
    Ok(dir.join(TTS_CONFIG_FILE))
}

fn asr_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("获取应用配置目录失败：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建应用配置目录失败：{error}"))?;
    Ok(dir.join(ASR_CONFIG_FILE))
}

fn interaction_history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("获取应用配置目录失败：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建应用配置目录失败：{error}"))?;
    Ok(dir.join(INTERACTION_HISTORY_FILE))
}

fn custom_skins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取应用数据目录失败：{error}"))?
        .join(CUSTOM_SKINS_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("创建自定义皮肤目录失败：{error}"))?;
    Ok(dir)
}

fn current_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn sanitize_skin_id(value: &str) -> String {
    let mut id = String::new();
    let mut last_was_dash = false;

    for character in value.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            id.push(character);
            last_was_dash = false;
        } else if !last_was_dash {
            id.push('-');
            last_was_dash = true;
        }
    }

    let cleaned = id.trim_matches('-').to_string();
    if cleaned.is_empty() {
        format!("custom-skin-{}", current_timestamp_ms())
    } else {
        cleaned
    }
}

fn normalize_skin_layout(value: &str) -> String {
    if value == "fullBody" {
        "fullBody".to_string()
    } else {
        "halfBody".to_string()
    }
}

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;
    let encoded = data_url
        .split_once(',')
        .map(|(_, encoded)| encoded)
        .unwrap_or(data_url)
        .trim();
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("解析图片数据失败：{error}"))?;

    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片太大了，请先压缩后再添加。".to_string());
    }

    Ok(bytes)
}

fn decode_audio_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;
    let encoded = data_url
        .split_once(',')
        .map(|(_, encoded)| encoded)
        .unwrap_or(data_url)
        .trim();
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("解析音频数据失败：{error}"))?;

    if bytes.len() > MAX_AUDIO_BYTES {
        return Err("音频片段太大了，请缩短单句时长。".to_string());
    }

    Ok(bytes)
}

fn write_skin_data_url(path: &Path, data_url: &str) -> Result<(), String> {
    let bytes = decode_data_url(data_url)?;
    fs::write(path, bytes).map_err(|error| format!("保存皮肤图片失败：{error}"))
}

fn manifest_to_custom_skin_view(skin_dir: &Path, manifest: CustomSkinManifest) -> CustomSkinView {
    let image_path = |asset: &str| skin_dir.join(asset).to_string_lossy().to_string();

    CustomSkinView {
        id: manifest.id,
        name: manifest.name,
        layout: manifest.layout,
        asset_width: manifest.asset_width,
        asset_height: manifest.asset_height,
        hit_calibration_y: manifest.hit_calibration_y,
        images: CustomSkinImagePaths {
            idle: image_path(&manifest.assets.idle),
            surprised: image_path(&manifest.assets.surprised),
            blink: image_path(&manifest.assets.blink),
            mouth_talk: image_path(&manifest.assets.mouth_talk),
            mouth_o: image_path(&manifest.assets.mouth_o),
        },
    }
}

fn load_stored_llm_config(app: &AppHandle) -> Result<StoredLlmConfig, String> {
    let path = llm_config_path(app)?;
    if !path.exists() {
        return Ok(StoredLlmConfig::default());
    }

    let text = fs::read_to_string(&path).map_err(|error| format!("读取 LLM 配置失败：{error}"))?;
    serde_json::from_str::<StoredLlmConfig>(&text)
        .map_err(|error| format!("解析 LLM 配置失败：{error}"))
}

fn load_stored_tts_config(app: &AppHandle) -> Result<StoredTtsConfig, String> {
    let path = tts_config_path(app)?;
    if !path.exists() {
        return Ok(StoredTtsConfig::default());
    }

    let text = fs::read_to_string(&path).map_err(|error| format!("读取语音配置失败：{error}"))?;
    serde_json::from_str::<StoredTtsConfig>(&text)
        .map_err(|error| format!("解析语音配置失败：{error}"))
}

fn load_stored_asr_config(app: &AppHandle) -> Result<StoredAsrConfig, String> {
    let path = asr_config_path(app)?;
    if !path.exists() {
        return Ok(StoredAsrConfig::default());
    }

    let text = fs::read_to_string(&path).map_err(|error| format!("读取识别配置失败：{error}"))?;
    serde_json::from_str::<StoredAsrConfig>(&text)
        .map_err(|error| format!("解析识别配置失败：{error}"))
}

fn load_interaction_history(app: &AppHandle) -> Result<Vec<InteractionRecord>, String> {
    let path = interaction_history_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let text = fs::read_to_string(&path).map_err(|error| format!("读取交互历史失败：{error}"))?;
    match serde_json::from_str::<Vec<InteractionRecord>>(&text) {
        Ok(history) => Ok(normalize_interaction_history(history)),
        Err(error) => {
            backup_corrupt_interaction_history(&path);
            eprintln!("Failed to parse interaction history, starting fresh: {error}");
            Ok(Vec::new())
        }
    }
}

fn normalize_interaction_history(history: Vec<InteractionRecord>) -> Vec<InteractionRecord> {
    history
        .into_iter()
        .filter_map(|mut record| {
            record.source = record.source.trim().to_string();
            if record.source.is_empty() {
                record.source = "unknown".to_string();
            }

            if record.timestamp_ms == 0 {
                record.timestamp_ms = now_ms();
            }

            record.interaction_tool = clean_optional(record.interaction_tool);
            record.area = clean_optional(record.area);
            record.user_text = clean_optional(record.user_text);
            record.assistant_text = record.assistant_text.trim().to_string();

            if record.assistant_text.is_empty() && record.user_text.is_none() {
                return None;
            }

            if record.assistant_text.is_empty() {
                record.assistant_text = "（没有记录到回应）".to_string();
            }

            Some(record)
        })
        .collect()
}

fn backup_corrupt_interaction_history(path: &Path) {
    let backup = path.with_file_name(format!(
        "{INTERACTION_HISTORY_FILE}.corrupt-{}.bak",
        now_ms()
    ));
    let _ = fs::rename(path, backup);
}

fn save_interaction_history(app: &AppHandle, history: &[InteractionRecord]) -> Result<(), String> {
    let path = interaction_history_path(app)?;
    let text = serde_json::to_string_pretty(history)
        .map_err(|error| format!("序列化交互历史失败：{error}"))?;
    let tmp_path = path.with_file_name(format!("{INTERACTION_HISTORY_FILE}.tmp-{}", now_ms()));

    fs::write(&tmp_path, text).map_err(|error| format!("保存交互历史临时文件失败：{error}"))?;

    match fs::rename(&tmp_path, &path) {
        Ok(()) => Ok(()),
        Err(first_error) if path.exists() => {
            fs::remove_file(&path)
                .map_err(|error| format!("替换旧交互历史失败：{error}; 初始错误：{first_error}"))?;
            fs::rename(&tmp_path, &path).map_err(|error| format!("保存交互历史失败：{error}"))
        }
        Err(error) => Err(format!("保存交互历史失败：{error}")),
    }
}

fn append_interaction_history(
    app: &AppHandle,
    mut record: InteractionRecord,
) -> Result<InteractionRecord, String> {
    let mut history = load_interaction_history(app)?;
    let next_id = history
        .last()
        .map(|record| record.id.saturating_add(1))
        .unwrap_or(1);
    record.id = next_id;
    history.push(record.clone());

    if history.len() > MAX_HISTORY_RECORDS {
        let start = history.len() - MAX_HISTORY_RECORDS;
        history = history.split_off(start);
    }

    save_interaction_history(app, &history)?;
    Ok(record)
}

fn save_stored_llm_config(app: &AppHandle, config: &StoredLlmConfig) -> Result<(), String> {
    let path = llm_config_path(app)?;
    let text = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化 LLM 配置失败：{error}"))?;
    fs::write(&path, text).map_err(|error| format!("保存 LLM 配置失败：{error}"))
}

fn save_stored_tts_config(app: &AppHandle, config: &StoredTtsConfig) -> Result<(), String> {
    let path = tts_config_path(app)?;
    let text = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化语音配置失败：{error}"))?;
    fs::write(&path, text).map_err(|error| format!("保存语音配置失败：{error}"))
}

fn save_stored_asr_config(app: &AppHandle, config: &StoredAsrConfig) -> Result<(), String> {
    let path = asr_config_path(app)?;
    let text = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化识别配置失败：{error}"))?;
    fs::write(&path, text).map_err(|error| format!("保存识别配置失败：{error}"))
}

fn mask_api_key(api_key: &str) -> String {
    let chars: Vec<char> = api_key.chars().collect();
    if chars.len() <= 8 {
        return "••••".to_string();
    }

    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(chars.len().saturating_sub(4)).collect();
    format!("{head}••••{tail}")
}

fn config_view(config: &StoredLlmConfig) -> LlmConfigView {
    let api_key = clean_optional(config.api_key.clone())
        .or_else(|| read_env(&["LLM_API_KEY", "OPENAI_API_KEY"]));
    let base_url = clean_optional(config.base_url.clone())
        .or_else(|| read_env(&["LLM_BASE_URL", "OPENAI_BASE_URL"]))
        .unwrap_or_else(|| DEFAULT_LLM_BASE_URL.to_string());
    let model = clean_optional(config.model.clone())
        .or_else(|| read_env(&["LLM_MODEL", "OPENAI_MODEL"]))
        .unwrap_or_default();
    let timeout_secs = config.timeout_secs.unwrap_or_else(|| {
        parse_env_u64("LLM_TIMEOUT_SECS", DEFAULT_LLM_TIMEOUT_SECS)
            .unwrap_or(DEFAULT_LLM_TIMEOUT_SECS)
    });

    LlmConfigView {
        has_api_key: api_key.is_some(),
        masked_api_key: api_key.as_deref().map(mask_api_key),
        base_url,
        model,
        timeout_secs,
        pet_interaction_system_prompt: clean_optional(config.pet_interaction_system_prompt.clone())
            .unwrap_or_default(),
        default_pet_interaction_system_prompt: DEFAULT_PET_INTERACTION_SYSTEM_PROMPT.to_string(),
    }
}

fn normalize_tts_provider(provider: Option<String>) -> String {
    match provider
        .as_deref()
        .unwrap_or(TTS_PROVIDER_GPT_SOVITS)
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "managed" | "local" | "localgptsovits" | "local-gpt-sovits" | "managedgptsovits"
        | "managed-gpt-sovits" | "managed_gpt_sovits" => {
            TTS_PROVIDER_MANAGED_GPT_SOVITS.to_string()
        }
        "gpt" | "gptsovits" | "gpt-sovits" | "gpt_sovits" => TTS_PROVIDER_GPT_SOVITS.to_string(),
        "openai" | "openaicompatible" | "openai-compatible" | "open_ai_compatible" => {
            TTS_PROVIDER_OPENAI_COMPATIBLE.to_string()
        }
        "custom" | "customjson" | "custom-json" | "custom_json" => {
            TTS_PROVIDER_CUSTOM_JSON.to_string()
        }
        _ => TTS_PROVIDER_GPT_SOVITS.to_string(),
    }
}

fn normalize_asr_provider(provider: Option<String>) -> String {
    match provider
        .as_deref()
        .unwrap_or(if cfg!(windows) {
            ASR_PROVIDER_WINDOWS_NATIVE
        } else {
            ASR_PROVIDER_BROWSER
        })
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "windows" | "native" | "windowsnative" | "windows-native" | "windows_native" | "system"
        | "systemdictation" | "system-dictation" => {
            if cfg!(windows) {
                ASR_PROVIDER_WINDOWS_NATIVE.to_string()
            } else {
                ASR_PROVIDER_BROWSER.to_string()
            }
        }
        "openai" | "openaicompatible" | "openai-compatible" | "open_ai_compatible" | "whisper" => {
            ASR_PROVIDER_OPENAI_COMPATIBLE.to_string()
        }
        _ => ASR_PROVIDER_BROWSER.to_string(),
    }
}

fn asr_config_view(config: &StoredAsrConfig) -> AsrConfigView {
    let provider = normalize_asr_provider(config.provider.clone());
    let api_key = clean_optional(config.api_key.clone())
        .or_else(|| read_env(&["ASR_API_KEY", "OPENAI_API_KEY"]));
    let endpoint = clean_optional(config.endpoint.clone())
        .or_else(|| read_env(&["ASR_BASE_URL", "OPENAI_BASE_URL"]))
        .unwrap_or_else(|| DEFAULT_ASR_BASE_URL.to_string());
    let model = clean_optional(config.model.clone())
        .or_else(|| read_env(&["ASR_MODEL"]))
        .unwrap_or_else(|| DEFAULT_ASR_MODEL.to_string());
    let language = clean_optional(config.language.clone()).unwrap_or_else(|| "zh".to_string());
    let prompt =
        clean_optional(config.prompt.clone()).unwrap_or_else(|| DEFAULT_ASR_PROMPT.to_string());
    let timeout_secs = config
        .timeout_secs
        .unwrap_or_else(|| {
            parse_env_u64("ASR_TIMEOUT_SECS", DEFAULT_ASR_TIMEOUT_SECS)
                .unwrap_or(DEFAULT_ASR_TIMEOUT_SECS)
        })
        .clamp(5, 300);

    AsrConfigView {
        provider,
        endpoint,
        has_api_key: api_key.is_some(),
        masked_api_key: api_key.as_deref().map(mask_api_key),
        model,
        language,
        prompt,
        timeout_secs,
        default_prompt: DEFAULT_ASR_PROMPT.to_string(),
        native_speech_available: cfg!(windows),
        native_speech_filter_configurable: false,
        browser_speech_filter_configurable: false,
    }
}

fn normalize_tts_media_type(media_type: Option<String>) -> String {
    match media_type
        .as_deref()
        .unwrap_or("wav")
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "mp3".to_string(),
        "ogg" => "ogg".to_string(),
        "opus" => "opus".to_string(),
        "aac" => "aac".to_string(),
        "flac" => "flac".to_string(),
        "pcm" => "pcm".to_string(),
        "raw" => "raw".to_string(),
        _ => "wav".to_string(),
    }
}

fn content_type_for_audio(media_type: &str) -> String {
    match media_type {
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "opus" => "audio/ogg; codecs=opus",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "pcm" | "raw" => "audio/wav",
        _ => "audio/wav",
    }
    .to_string()
}

fn tts_config_view(config: &StoredTtsConfig) -> TtsConfigView {
    let api_key = clean_optional(config.api_key.clone()).or_else(|| read_env(&["TTS_API_KEY"]));
    let provider = clean_optional(config.provider.clone())
        .map(|provider| normalize_tts_provider(Some(provider)))
        .unwrap_or_else(|| {
            if default_gpt_sovits_root().is_some() {
                TTS_PROVIDER_MANAGED_GPT_SOVITS.to_string()
            } else {
                TTS_PROVIDER_GPT_SOVITS.to_string()
            }
        });
    let media_type = normalize_tts_media_type(config.media_type.clone());
    let speed_factor = config
        .speed_factor
        .filter(|value| value.is_finite())
        .unwrap_or(1.0)
        .clamp(0.5, 2.0);
    let timeout_secs = config.timeout_secs.unwrap_or_else(|| {
        parse_env_u64("TTS_TIMEOUT_SECS", DEFAULT_TTS_TIMEOUT_SECS)
            .unwrap_or(DEFAULT_TTS_TIMEOUT_SECS)
    });
    let managed_root = clean_optional(config.managed_root.clone())
        .or_else(|| read_env(&["GPT_SOVITS_ROOT", "TTS_GPT_SOVITS_ROOT"]))
        .or_else(|| default_gpt_sovits_root().map(|path| path_to_string(&path)))
        .unwrap_or_default();
    let managed_python = clean_optional(config.managed_python.clone())
        .or_else(|| read_env(&["GPT_SOVITS_PYTHON", "TTS_GPT_SOVITS_PYTHON"]))
        .unwrap_or_else(|| default_managed_child_path(&managed_root, "runtime/python.exe"));
    let managed_port = config
        .managed_port
        .or_else(|| {
            parse_env_u64("GPT_SOVITS_PORT", DEFAULT_MANAGED_GPT_SOVITS_PORT as u64)
                .ok()
                .and_then(|port| u16::try_from(port).ok())
        })
        .unwrap_or(DEFAULT_MANAGED_GPT_SOVITS_PORT);
    let gpt_weight_path = clean_optional(config.gpt_weight_path.clone())
        .or_else(|| read_env(&["GPT_SOVITS_GPT_WEIGHT", "TTS_GPT_SOVITS_GPT_WEIGHT"]))
        .unwrap_or_else(|| default_managed_child_path(&managed_root, DEFAULT_YUA_GPT_WEIGHT_REL));
    let sovits_weight_path = clean_optional(config.sovits_weight_path.clone())
        .or_else(|| read_env(&["GPT_SOVITS_SOVITS_WEIGHT", "TTS_GPT_SOVITS_SOVITS_WEIGHT"]))
        .unwrap_or_else(|| {
            default_managed_child_path(&managed_root, DEFAULT_YUA_SOVITS_WEIGHT_REL)
        });
    let ref_audio_path = clean_optional(config.ref_audio_path.clone())
        .or_else(|| read_env(&["GPT_SOVITS_REF_AUDIO", "TTS_GPT_SOVITS_REF_AUDIO"]))
        .unwrap_or_else(|| default_managed_child_path(&managed_root, DEFAULT_YUA_REF_AUDIO_REL));
    let endpoint = if provider == TTS_PROVIDER_MANAGED_GPT_SOVITS {
        managed_gpt_sovits_base_url(managed_port)
    } else {
        clean_optional(config.endpoint.clone())
            .or_else(|| read_env(&["TTS_ENDPOINT", "GPT_SOVITS_ENDPOINT"]))
            .unwrap_or_else(|| managed_gpt_sovits_base_url(DEFAULT_MANAGED_GPT_SOVITS_PORT))
    };

    TtsConfigView {
        enabled: config.enabled.unwrap_or(false),
        provider,
        endpoint,
        has_api_key: api_key.is_some(),
        masked_api_key: api_key.as_deref().map(mask_api_key),
        model: clean_optional(config.model.clone())
            .or_else(|| read_env(&["TTS_MODEL"]))
            .unwrap_or_default(),
        voice: clean_optional(config.voice.clone())
            .or_else(|| read_env(&["TTS_VOICE"]))
            .unwrap_or_else(|| "alloy".to_string()),
        media_type,
        text_lang: clean_optional(config.text_lang.clone()).unwrap_or_else(|| "zh".to_string()),
        ref_audio_path,
        prompt_lang: clean_optional(config.prompt_lang.clone()).unwrap_or_else(|| "zh".to_string()),
        prompt_text: clean_optional(config.prompt_text.clone())
            .unwrap_or_else(|| DEFAULT_YUA_PROMPT_TEXT.to_string()),
        speed_factor,
        timeout_secs: timeout_secs.clamp(5, 300),
        managed_root,
        managed_python,
        managed_port,
        gpt_weight_path,
        sovits_weight_path,
    }
}

fn tts_endpoint_url(provider: &str, endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if provider == TTS_PROVIDER_GPT_SOVITS || provider == TTS_PROVIDER_MANAGED_GPT_SOVITS {
        if trimmed.ends_with("/tts") {
            trimmed.to_string()
        } else {
            format!("{trimmed}/tts")
        }
    } else if provider == TTS_PROVIDER_OPENAI_COMPATIBLE {
        if trimmed.ends_with("/audio/speech") {
            trimmed.to_string()
        } else if trimmed.ends_with("/v1") {
            format!("{trimmed}/audio/speech")
        } else {
            format!("{trimmed}/v1/audio/speech")
        }
    } else {
        trimmed.to_string()
    }
}

fn asr_endpoint_url(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.ends_with("/audio/transcriptions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/audio/transcriptions")
    } else {
        format!("{trimmed}/v1/audio/transcriptions")
    }
}

#[cfg(windows)]
fn windows_error(error: windows::core::Error) -> String {
    error.message().to_string()
}

#[cfg(windows)]
fn native_speech_error_message(error: windows::core::Error) -> String {
    let message = windows_error(error);
    let lower = message.to_ascii_lowercase();
    if lower.contains("speech privacy policy") || lower.contains("privacy") {
        "Windows 尚未允许此应用使用语音识别。请打开 Windows 设置 > 隐私和安全性 > 语音，接受语音隐私策略并开启联机语音识别，然后重启桌宠监听。".to_string()
    } else {
        message
    }
}

#[cfg(windows)]
fn speech_status_label(status: SpeechRecognitionResultStatus) -> &'static str {
    if status == SpeechRecognitionResultStatus::Success {
        "success"
    } else if status == SpeechRecognitionResultStatus::TopicLanguageNotSupported {
        "topic-language-not-supported"
    } else if status == SpeechRecognitionResultStatus::GrammarLanguageMismatch {
        "grammar-language-mismatch"
    } else if status == SpeechRecognitionResultStatus::GrammarCompilationFailure {
        "grammar-compilation-failure"
    } else if status == SpeechRecognitionResultStatus::AudioQualityFailure {
        "audio-quality-failure"
    } else if status == SpeechRecognitionResultStatus::UserCanceled {
        "user-canceled"
    } else if status == SpeechRecognitionResultStatus::TimeoutExceeded {
        "timeout-exceeded"
    } else if status == SpeechRecognitionResultStatus::PauseLimitExceeded {
        "pause-limit-exceeded"
    } else if status == SpeechRecognitionResultStatus::NetworkFailure {
        "network-failure"
    } else if status == SpeechRecognitionResultStatus::MicrophoneUnavailable {
        "microphone-unavailable"
    } else {
        "unknown"
    }
}

#[cfg(windows)]
fn speech_confidence_value(confidence: SpeechRecognitionConfidence) -> f64 {
    if confidence == SpeechRecognitionConfidence::High {
        0.92
    } else if confidence == SpeechRecognitionConfidence::Medium {
        0.74
    } else if confidence == SpeechRecognitionConfidence::Low {
        0.46
    } else {
        0.0
    }
}

#[cfg(windows)]
fn speech_state_label(state: SpeechRecognizerState) -> &'static str {
    if state == SpeechRecognizerState::Idle {
        "idle"
    } else if state == SpeechRecognizerState::Capturing {
        "capturing"
    } else if state == SpeechRecognizerState::Processing {
        "processing"
    } else if state == SpeechRecognizerState::SoundStarted {
        "sound-started"
    } else if state == SpeechRecognizerState::SoundEnded {
        "sound-ended"
    } else if state == SpeechRecognizerState::SpeechDetected {
        "speech-detected"
    } else if state == SpeechRecognizerState::Paused {
        "paused"
    } else {
        "unknown"
    }
}

#[cfg(windows)]
fn stop_native_speech_session(session: NativeSpeechSession) {
    let _ = session.recognizer.RemoveStateChanged(session.state_token);
    let _ = session
        .recognizer
        .RemoveHypothesisGenerated(session.hypothesis_token);
    let _ = session.session.RemoveResultGenerated(session.result_token);
    let _ = session.session.RemoveCompleted(session.completed_token);
    let _ = session
        .session
        .CancelAsync()
        .and_then(|action| action.get());
    let _ = session.recognizer.Close();
}

fn managed_gpt_sovits_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("获取应用配置目录失败：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建应用配置目录失败：{error}"))?;
    Ok(dir.join(MANAGED_GPT_SOVITS_CONFIG_FILE))
}

fn write_managed_gpt_sovits_config(
    app: &AppHandle,
    config: &TtsConfigView,
) -> Result<PathBuf, String> {
    let root = PathBuf::from(&config.managed_root);
    let bert_path = root.join("GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large");
    let hubert_path = root.join("GPT_SoVITS/pretrained_models/chinese-hubert-base");
    let yaml = format!(
        "custom:\n  bert_base_path: {}\n  cnhuhbert_base_path: {}\n  device: cuda\n  is_half: true\n  t2s_weights_path: {}\n  version: v2\n  vits_weights_path: {}\n",
        yaml_path(&path_to_string(&bert_path)),
        yaml_path(&path_to_string(&hubert_path)),
        yaml_path(&config.gpt_weight_path),
        yaml_path(&config.sovits_weight_path),
    );
    let path = managed_gpt_sovits_config_path(app)?;
    fs::write(&path, yaml).map_err(|error| format!("写入 GPT-SoVITS 托管配置失败：{error}"))?;
    Ok(path)
}

fn validate_existing_file(path: &str, label: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.is_file() {
        return Err(format!("{label}不存在：{}", path.display()));
    }
    Ok(())
}

fn validate_existing_dir(path: &str, label: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.is_dir() {
        return Err(format!("{label}不存在：{}", path.display()));
    }
    Ok(())
}

async fn managed_gpt_sovits_is_ready(client: &reqwest::Client, port: u16) -> bool {
    let url = format!("{}/docs", managed_gpt_sovits_base_url(port));
    client
        .get(url)
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn start_managed_gpt_sovits(
    app: &AppHandle,
    state: &ManagedGptSovitsState,
    config: &TtsConfigView,
) -> Result<u32, String> {
    validate_existing_dir(&config.managed_root, "GPT-SoVITS 根目录")?;
    validate_existing_file(&config.managed_python, "GPT-SoVITS Python")?;
    validate_existing_file(&config.gpt_weight_path, "GPT 权重")?;
    validate_existing_file(&config.sovits_weight_path, "SoVITS 权重")?;

    let root = PathBuf::from(&config.managed_root);
    let api_path = root.join("api_v2.py");
    if !api_path.is_file() {
        return Err(format!(
            "GPT-SoVITS api_v2.py 不存在：{}",
            api_path.display()
        ));
    }

    let config_path = write_managed_gpt_sovits_config(app, config)?;
    let log_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("获取应用配置目录失败：{error}"))?;
    fs::create_dir_all(&log_dir).map_err(|error| format!("创建应用配置目录失败：{error}"))?;
    let stdout_path = log_dir.join("managed-gpt-sovits-api.out.log");
    let stderr_path = log_dir.join("managed-gpt-sovits-api.err.log");
    let stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stdout_path)
        .map_err(|error| format!("打开 GPT-SoVITS stdout 日志失败：{error}"))?;
    let stderr = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_path)
        .map_err(|error| format!("打开 GPT-SoVITS stderr 日志失败：{error}"))?;

    let runtime_dir = root.join("runtime");
    let scripts_dir = runtime_dir.join("Scripts");
    let existing_path = env::var_os("PATH").unwrap_or_default();
    let mut path_entries = vec![runtime_dir, scripts_dir];
    path_entries.extend(env::split_paths(&existing_path));
    let child_path = env::join_paths(path_entries)
        .map_err(|error| format!("拼接 GPT-SoVITS PATH 失败：{error}"))?;

    let mut command = Command::new(&config.managed_python);
    command
        .arg("api_v2.py")
        .arg("-a")
        .arg("127.0.0.1")
        .arg("-p")
        .arg(config.managed_port.to_string())
        .arg("-c")
        .arg(&config_path)
        .current_dir(&root)
        .env("PATH", child_path)
        .env("PYTHONNOUSERSITE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let child = command
        .spawn()
        .map_err(|error| format!("启动 GPT-SoVITS 失败：{error}"))?;
    let pid = child.id();
    let mut slot = state
        .child
        .lock()
        .map_err(|_| "GPT-SoVITS 进程状态锁已损坏。".to_string())?;
    *slot = Some(child);
    Ok(pid)
}

async fn ensure_managed_gpt_sovits(
    app: &AppHandle,
    state: &ManagedGptSovitsState,
    config: &TtsConfigView,
) -> Result<(), String> {
    let health_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| format!("创建 GPT-SoVITS 健康检查客户端失败：{error}"))?;
    if managed_gpt_sovits_is_ready(&health_client, config.managed_port).await {
        return Ok(());
    }

    let mut needs_start = false;
    {
        let mut slot = state
            .child
            .lock()
            .map_err(|_| "GPT-SoVITS 进程状态锁已损坏。".to_string())?;
        match slot.as_mut() {
            Some(child) => {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|error| format!("检查 GPT-SoVITS 进程失败：{error}"))?
                {
                    *slot = None;
                    return Err(format!("GPT-SoVITS 已退出，状态：{status}。"));
                }
            }
            None => needs_start = true,
        }
    }

    if needs_start {
        let _pid = start_managed_gpt_sovits(app, state, config)?;
    }

    let attempts = MANAGED_GPT_SOVITS_STARTUP_TIMEOUT_SECS / 2;
    for _ in 0..attempts {
        if managed_gpt_sovits_is_ready(&health_client, config.managed_port).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        let mut slot = state
            .child
            .lock()
            .map_err(|_| "GPT-SoVITS 进程状态锁已损坏。".to_string())?;
        if let Some(child) = slot.as_mut() {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("检查 GPT-SoVITS 进程失败：{error}"))?
            {
                *slot = None;
                return Err(format!("GPT-SoVITS 启动后已退出，状态：{status}。"));
            }
        }
    }

    Err(format!(
        "GPT-SoVITS 在 {} 秒内未就绪，请查看应用配置目录下的 managed-gpt-sovits-api.err.log。",
        MANAGED_GPT_SOVITS_STARTUP_TIMEOUT_SECS
    ))
}

fn effective_llm_config(
    app: &AppHandle,
    request_model: Option<String>,
) -> Result<EffectiveLlmConfig, String> {
    let stored = load_stored_llm_config(app)?;
    let api_key = clean_optional(stored.api_key)
        .or_else(|| read_env(&["LLM_API_KEY", "OPENAI_API_KEY"]))
        .ok_or_else(|| "还没有配置 API Key，请右键桌宠打开设置页。".to_string())?;
    let base_url = clean_optional(stored.base_url)
        .or_else(|| read_env(&["LLM_BASE_URL", "OPENAI_BASE_URL"]))
        .unwrap_or_else(|| DEFAULT_LLM_BASE_URL.to_string());
    let model = clean_optional(request_model)
        .or_else(|| clean_optional(stored.model))
        .or_else(|| read_env(&["LLM_MODEL", "OPENAI_MODEL"]))
        .ok_or_else(|| "还没有配置模型名，请右键桌宠打开设置页。".to_string())?;
    let timeout_secs = stored.timeout_secs.unwrap_or_else(|| {
        parse_env_u64("LLM_TIMEOUT_SECS", DEFAULT_LLM_TIMEOUT_SECS)
            .unwrap_or(DEFAULT_LLM_TIMEOUT_SECS)
    });
    let pet_interaction_system_prompt = clean_optional(stored.pet_interaction_system_prompt)
        .unwrap_or_else(|| DEFAULT_PET_INTERACTION_SYSTEM_PROMPT.to_string());

    Ok(EffectiveLlmConfig {
        api_key,
        base_url,
        model,
        timeout_secs,
        pet_interaction_system_prompt,
    })
}

fn chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn parse_env_u64(name: &str, fallback: u64) -> Result<u64, String> {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => value
            .trim()
            .parse::<u64>()
            .map_err(|_| format!("{name} 必须是数字。")),
        _ => Ok(fallback),
    }
}

fn truncate_error_body(body: &str) -> String {
    const MAX_LEN: usize = 800;
    let trimmed = body.trim();
    if trimmed.chars().count() <= MAX_LEN {
        trimmed.to_string()
    } else {
        let shortened: String = trimmed.chars().take(MAX_LEN).collect();
        format!("{shortened}...")
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn clean_model_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '“' | '”' | '‘' | '’'))
        .chars()
        .take(120)
        .collect::<String>()
}

fn content_value_to_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .map(content_value_to_text)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" "),
        serde_json::Value::Object(map) => map
            .get("text")
            .or_else(|| map.get("content"))
            .map(content_value_to_text)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn extract_message_text(message: &OpenAiCompatibleMessage) -> String {
    for value in [message.content.as_ref(), message.text.as_ref()]
        .into_iter()
        .flatten()
    {
        let content = clean_model_text(&content_value_to_text(value));
        if !content.is_empty() {
            return content;
        }
    }

    String::new()
}

fn extract_stream_choice_text(choice: OpenAiCompatibleStreamChoice) -> String {
    if let Some(message) = choice.delta {
        let content = extract_message_text(&message);
        if !content.is_empty() {
            return content;
        }
    }

    if let Some(message) = choice.message {
        let content = extract_message_text(&message);
        if !content.is_empty() {
            return content;
        }
    }

    choice
        .text
        .as_ref()
        .map(content_value_to_text)
        .map(|content| clean_model_text(&content))
        .unwrap_or_default()
}

fn sse_frame_end(buffer: &str) -> Option<(usize, usize)> {
    buffer
        .find("\r\n\r\n")
        .map(|position| (position, 4))
        .or_else(|| buffer.find("\n\n").map(|position| (position, 2)))
}

fn parse_stream_frame(frame: &str) -> Vec<String> {
    frame
        .lines()
        .filter_map(|line| line.trim().strip_prefix("data:").map(str::trim))
        .filter(|data| !data.is_empty() && *data != "[DONE]")
        .filter_map(|data| serde_json::from_str::<OpenAiCompatibleStreamResponse>(data).ok())
        .flat_map(|parsed| parsed.choices.into_iter().map(extract_stream_choice_text))
        .filter(|content| !content.is_empty())
        .collect()
}

fn emit_pet_interaction_stream(
    app: &AppHandle,
    stream_id: &str,
    phase: &str,
    delta: Option<String>,
    content: Option<String>,
    record: Option<InteractionRecord>,
    error: Option<String>,
) {
    let _ = app.emit(
        "pet-interaction-stream",
        PetInteractionStreamEvent {
            stream_id: stream_id.to_string(),
            phase: phase.to_string(),
            delta,
            content,
            record,
            error,
        },
    );
}

fn format_history_for_prompt(history: &[InteractionRecord]) -> String {
    if history.is_empty() {
        return "暂无历史。".to_string();
    }

    history
        .iter()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|record| {
            let area = record.area.as_deref().unwrap_or("无部位");
            let interaction_tool = record.interaction_tool.as_deref().unwrap_or("无控件");
            let user = record.user_text.as_deref().unwrap_or("");
            let position = match (record.x_percent, record.y_percent) {
                (Some(x), Some(y)) => format!("位置 {:.1}%, {:.1}%", x, y),
                _ => "无坐标".to_string(),
            };
            format!(
                "- 来源={} / 控件={} / 部位={} / {} / 用户文本：{} / 回复：{}",
                record.source, interaction_tool, area, position, user, record.assistant_text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn describe_pet_interaction(request: &PetInteractionRequest) -> String {
    let area = request.area.as_deref().unwrap_or("未指定");
    let interaction_tool = request.interaction_tool.as_deref().unwrap_or("未选择");
    let user_text = request.user_text.as_deref().unwrap_or("");
    let skin_id = request.skin_id.as_deref().unwrap_or("未指定");
    let skin_name = request.skin_name.as_deref().unwrap_or("未指定");
    let skin_prompt = request.skin_prompt.as_deref().unwrap_or("").trim();
    let position = match (request.x_percent, request.y_percent) {
        (Some(x), Some(y)) => format!("{:.1}%, {:.1}%", x, y),
        _ => "未记录".to_string(),
    };
    let skin_context = if skin_prompt.is_empty() {
        format!("当前皮肤={}({})；", skin_name, skin_id)
    } else {
        format!(
            "当前皮肤={}({})；皮肤专属设定={}；",
            skin_name, skin_id, skin_prompt
        )
    };

    format!(
        "当前交互：{}来源={}；用户使用控件={}；目标部位={}；位置={}；用户文本={}；亲密度={}；状态={}；背景模式={}。请生成桌宠回应。",
        skin_context,
        request.source,
        interaction_tool,
        area,
        position,
        user_text,
        request.affection,
        request.mood,
        if request.scene_mode { "开启" } else { "关闭" }
    )
}

fn validate_llm_request(request: &LlmChatRequest) -> Result<(), String> {
    if request.messages.is_empty() {
        return Err("LLM 请求至少需要一条消息。".to_string());
    }

    for message in &request.messages {
        if message.role.trim().is_empty() {
            return Err("LLM 消息 role 不能为空。".to_string());
        }

        if message.content.trim().is_empty() {
            return Err("LLM 消息 content 不能为空。".to_string());
        }
    }

    if let Some(temperature) = request.temperature {
        if !(0.0..=2.0).contains(&temperature) {
            return Err("temperature 需要在 0 到 2 之间。".to_string());
        }
    }

    Ok(())
}

fn validate_tts_config(config: &TtsConfigView) -> Result<(), String> {
    if config.provider != TTS_PROVIDER_MANAGED_GPT_SOVITS
        && !(config.endpoint.starts_with("https://") || config.endpoint.starts_with("http://"))
    {
        return Err("语音服务地址需要以 http:// 或 https:// 开头。".to_string());
    }

    if !(5..=300).contains(&config.timeout_secs) {
        return Err("语音超时时间需要在 5 到 300 秒之间。".to_string());
    }

    if !(0.5..=2.0).contains(&config.speed_factor) {
        return Err("语速需要在 0.5 到 2.0 之间。".to_string());
    }

    if config.enabled
        && (config.provider == TTS_PROVIDER_GPT_SOVITS
            || config.provider == TTS_PROVIDER_MANAGED_GPT_SOVITS)
    {
        if config.ref_audio_path.trim().is_empty() {
            return Err("GPT-SoVITS 需要填写参考音频路径。".to_string());
        }
        if config.prompt_lang.trim().is_empty() || config.text_lang.trim().is_empty() {
            return Err("GPT-SoVITS 需要填写文本语言和参考音频语言。".to_string());
        }
    }

    if config.enabled && config.provider == TTS_PROVIDER_MANAGED_GPT_SOVITS {
        if config.managed_port == 0 {
            return Err("GPT-SoVITS 本地端口需要在 1 到 65535 之间。".to_string());
        }
        validate_existing_dir(&config.managed_root, "GPT-SoVITS 根目录")?;
        validate_existing_file(&config.managed_python, "GPT-SoVITS Python")?;
        validate_existing_file(&config.gpt_weight_path, "GPT 权重")?;
        validate_existing_file(&config.sovits_weight_path, "SoVITS 权重")?;
        validate_existing_file(&config.ref_audio_path, "GPT-SoVITS 参考音频")?;
    }

    if config.enabled
        && config.provider == TTS_PROVIDER_OPENAI_COMPATIBLE
        && (config.model.trim().is_empty() || config.voice.trim().is_empty())
    {
        return Err("OpenAI 兼容语音需要填写模型和音色。".to_string());
    }

    Ok(())
}

#[tauri::command]
fn list_tts_assets(request: ListTtsAssetsRequest) -> Result<TtsAssetCatalog, String> {
    let root = tts_asset_root(request.root)?;
    if !root.is_dir() {
        return Err(format!("GPT-SoVITS 根目录不存在：{}", root.display()));
    }

    let gpt_paths = scan_files_by_extension(
        &root,
        &[
            "GPT_weights",
            "GPT_weights_v2",
            "GPT_weights_v3",
            "GPT_weights_v4",
        ],
        &["ckpt", "safetensors"],
        TTS_ASSET_SCAN_LIMIT_PER_KIND,
    );
    let sovits_paths = scan_files_by_extension(
        &root,
        &[
            "SoVITS_weights",
            "SoVITS_weights_v2",
            "SoVITS_weights_v3",
            "SoVITS_weights_v4",
        ],
        &["pth", "ckpt", "safetensors"],
        TTS_ASSET_SCAN_LIMIT_PER_KIND,
    );
    let ref_audio_paths = scan_files_by_extension(
        &root,
        &["logs", "output", "outputs", "reference", "references"],
        &["wav", "mp3", "flac", "ogg", "m4a", "aac"],
        TTS_ASSET_SCAN_LIMIT_PER_KIND,
    );

    Ok(TtsAssetCatalog {
        gpt_weights: build_weight_options(&root, gpt_paths),
        sovits_weights: build_weight_options(&root, sovits_paths),
        ref_audios: build_ref_audio_options(&root, ref_audio_paths),
    })
}

#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn pick_tts_path(request: PickTtsPathRequest) -> Result<Option<String>, String> {
    let kind = request.kind.trim();
    let mut dialog = rfd::FileDialog::new();

    let initial_dir = clean_optional(request.current_path.clone())
        .and_then(|path| {
            let path = PathBuf::from(path);
            if path.is_dir() {
                Some(path)
            } else if path.is_file() {
                path.parent().map(Path::to_path_buf)
            } else {
                None
            }
        })
        .or_else(|| {
            clean_optional(request.root_path)
                .map(PathBuf::from)
                .filter(|path| path.is_dir())
        })
        .or_else(default_gpt_sovits_root);

    if let Some(initial_dir) = initial_dir {
        dialog = dialog.set_directory(initial_dir);
    }

    let picked = match kind {
        "root" => dialog.set_title("选择 GPT-SoVITS 根目录").pick_folder(),
        "python" => dialog
            .set_title("选择 GPT-SoVITS runtime/python.exe")
            .add_filter("Python", &["exe"])
            .pick_file(),
        "gptWeight" => dialog
            .set_title("选择 GPT 权重")
            .add_filter("GPT 权重", &["ckpt", "safetensors"])
            .pick_file(),
        "sovitsWeight" => dialog
            .set_title("选择 SoVITS 权重")
            .add_filter("SoVITS 权重", &["pth", "ckpt", "safetensors"])
            .pick_file(),
        "refAudio" => dialog
            .set_title("选择参考音频")
            .add_filter("音频", &["wav", "mp3", "flac", "ogg", "m4a", "aac"])
            .pick_file(),
        _ => return Err("未知的语音路径类型。".to_string()),
    };

    Ok(picked.as_deref().map(path_to_string))
}

#[tauri::command]
#[cfg(any(target_os = "android", target_os = "ios"))]
fn pick_tts_path(_request: PickTtsPathRequest) -> Result<Option<String>, String> {
    Err("移动端暂不支持系统文件选择器。".to_string())
}

#[tauri::command]
fn get_tts_config(app: AppHandle) -> Result<TtsConfigView, String> {
    let config = load_stored_tts_config(&app)?;
    Ok(tts_config_view(&config))
}

#[tauri::command]
fn get_asr_config(app: AppHandle) -> Result<AsrConfigView, String> {
    let config = load_stored_asr_config(&app)?;
    Ok(asr_config_view(&config))
}

#[tauri::command]
fn save_asr_config(app: AppHandle, request: SaveAsrConfigRequest) -> Result<AsrConfigView, String> {
    let mut stored = load_stored_asr_config(&app)?;
    let provider = normalize_asr_provider(Some(request.provider));
    stored.provider = Some(provider.clone());
    stored.endpoint = Some(clean_required(&request.endpoint, "识别服务地址")?);
    stored.model = clean_optional(request.model);
    stored.language = clean_optional(request.language);
    stored.prompt = clean_optional(request.prompt);
    stored.timeout_secs = Some(request.timeout_secs.clamp(5, 300));

    if request.clear_api_key {
        stored.api_key = None;
    } else if let Some(api_key) = clean_optional(request.api_key) {
        stored.api_key = Some(api_key);
    }

    let view = asr_config_view(&stored);
    if view.provider == ASR_PROVIDER_OPENAI_COMPATIBLE && view.model.trim().is_empty() {
        return Err("高精度识别需要填写模型名。".to_string());
    }
    save_stored_asr_config(&app, &stored)?;
    let _ = app.emit("asr-config-updated", view.clone());
    Ok(view)
}

#[tauri::command]
#[cfg(windows)]
fn start_native_speech_recognition(
    app: AppHandle,
    native_speech: State<'_, NativeSpeechState>,
    language: String,
) -> Result<(), String> {
    if let Some(session) = native_speech
        .session
        .lock()
        .map_err(|_| "Windows 原生识别状态锁已损坏。".to_string())?
        .take()
    {
        stop_native_speech_session(session);
    }

    let language_tag = clean_optional(Some(language)).unwrap_or_else(|| "zh-CN".to_string());
    let language =
        Language::CreateLanguage(&HSTRING::from(language_tag.as_str())).map_err(windows_error)?;
    let recognizer = SpeechRecognizer::Create(&language).map_err(windows_error)?;
    let constraints = recognizer.Constraints().map_err(windows_error)?;
    let dictation = SpeechRecognitionTopicConstraint::Create(
        SpeechRecognitionScenario::Dictation,
        &HSTRING::from("dictation"),
    )
    .map_err(windows_error)?;
    constraints.Append(&dictation).map_err(windows_error)?;

    let compile_result = recognizer
        .CompileConstraintsAsync()
        .map_err(windows_error)?
        .get()
        .map_err(windows_error)?;
    let compile_status = compile_result.Status().map_err(windows_error)?;
    if compile_status != SpeechRecognitionResultStatus::Success {
        let _ = recognizer.Close();
        return Err(format!(
            "Windows 原生识别约束编译失败：{}",
            speech_status_label(compile_status)
        ));
    }

    let session = recognizer
        .ContinuousRecognitionSession()
        .map_err(windows_error)?;
    let result_app = app.clone();
    let result_handler: TypedEventHandler<
        SpeechContinuousRecognitionSession,
        SpeechContinuousRecognitionResultGeneratedEventArgs,
    > = TypedEventHandler::new(
        move |_sender: Ref<SpeechContinuousRecognitionSession>,
              args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
            let args = args.ok()?;
            let result = args.Result()?;
            if result.Status()? != SpeechRecognitionResultStatus::Success {
                return Ok(());
            }

            let transcript = result.Text()?.to_string_lossy().trim().to_string();
            if transcript.is_empty() {
                return Ok(());
            }

            let confidence = result
                .RawConfidence()
                .ok()
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or_else(|| {
                    speech_confidence_value(
                        result
                            .Confidence()
                            .unwrap_or(SpeechRecognitionConfidence::Medium),
                    )
                });
            let _ = result_app.emit(
                "native-speech-result",
                NativeSpeechRecognitionEvent {
                    transcript,
                    confidence,
                    provider: ASR_PROVIDER_WINDOWS_NATIVE.to_string(),
                },
            );
            Ok(())
        },
    );
    let result_token = session
        .ResultGenerated(&result_handler)
        .map_err(windows_error)?;

    let completed_app = app.clone();
    let completed_handler: TypedEventHandler<
        SpeechContinuousRecognitionSession,
        SpeechContinuousRecognitionCompletedEventArgs,
    > = TypedEventHandler::new(
        move |_sender: Ref<SpeechContinuousRecognitionSession>,
              args: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
            let args = args.ok()?;
            let status = args.Status()?;
            if status != SpeechRecognitionResultStatus::Success
                && status != SpeechRecognitionResultStatus::UserCanceled
            {
                let _ = completed_app.emit(
                    "native-speech-status",
                    format!("Windows 原生识别已停止：{}", speech_status_label(status)),
                );
            }
            Ok(())
        },
    );
    let completed_token = session
        .Completed(&completed_handler)
        .map_err(windows_error)?;

    let hypothesis_app = app.clone();
    let hypothesis_handler: TypedEventHandler<
        SpeechRecognizer,
        SpeechRecognitionHypothesisGeneratedEventArgs,
    > = TypedEventHandler::new(
        move |_sender: Ref<SpeechRecognizer>,
              args: Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
            let args = args.ok()?;
            let hypothesis = args.Hypothesis()?;
            let text = hypothesis.Text()?.to_string_lossy().trim().to_string();
            if !text.is_empty() {
                let _ =
                    hypothesis_app.emit("native-speech-status", format!("Windows 正在听：{text}"));
            }
            Ok(())
        },
    );
    let hypothesis_token = recognizer
        .HypothesisGenerated(&hypothesis_handler)
        .map_err(windows_error)?;

    let state_app = app.clone();
    let state_handler: TypedEventHandler<SpeechRecognizer, SpeechRecognizerStateChangedEventArgs> =
        TypedEventHandler::new(
            move |_sender: Ref<SpeechRecognizer>,
                  args: Ref<SpeechRecognizerStateChangedEventArgs>| {
                let args = args.ok()?;
                let state = args.State()?;
                let _ =
                    state_app.emit("native-speech-state", speech_state_label(state).to_string());
                Ok(())
            },
        );
    let state_token = recognizer
        .StateChanged(&state_handler)
        .map_err(windows_error)?;
    let result_handler_ref = AgileReference::new(&result_handler).map_err(windows_error)?;
    let completed_handler_ref = AgileReference::new(&completed_handler).map_err(windows_error)?;
    let hypothesis_handler_ref = AgileReference::new(&hypothesis_handler).map_err(windows_error)?;
    let state_handler_ref = AgileReference::new(&state_handler).map_err(windows_error)?;

    session
        .StartWithModeAsync(SpeechContinuousRecognitionMode::Default)
        .map_err(native_speech_error_message)?
        .get()
        .map_err(native_speech_error_message)?;

    *native_speech
        .session
        .lock()
        .map_err(|_| "Windows 原生识别状态锁已损坏。".to_string())? = Some(NativeSpeechSession {
        recognizer,
        session,
        result_token,
        completed_token,
        hypothesis_token,
        state_token,
        _result_handler: result_handler_ref,
        _completed_handler: completed_handler_ref,
        _hypothesis_handler: hypothesis_handler_ref,
        _state_handler: state_handler_ref,
    });

    Ok(())
}

#[tauri::command]
#[cfg(not(windows))]
fn start_native_speech_recognition(_app: AppHandle, _language: String) -> Result<(), String> {
    Err("Windows 原生识别只支持 Windows。".to_string())
}

#[tauri::command]
#[cfg(windows)]
fn stop_native_speech_recognition(
    native_speech: State<'_, NativeSpeechState>,
) -> Result<(), String> {
    if let Some(session) = native_speech
        .session
        .lock()
        .map_err(|_| "Windows 原生识别状态锁已损坏。".to_string())?
        .take()
    {
        stop_native_speech_session(session);
    }
    Ok(())
}

#[tauri::command]
#[cfg(not(windows))]
fn stop_native_speech_recognition() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(windows)]
fn open_windows_speech_privacy_settings(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("ms-settings:privacy-speech", None::<&str>)
        .map_err(|error| format!("打开 Windows 语音隐私设置失败：{error}"))
}

#[tauri::command]
#[cfg(not(windows))]
fn open_windows_speech_privacy_settings(_app: AppHandle) -> Result<(), String> {
    Err("Windows 语音隐私设置只支持 Windows。".to_string())
}

#[tauri::command]
fn save_tts_config(app: AppHandle, request: SaveTtsConfigRequest) -> Result<TtsConfigView, String> {
    let mut stored = load_stored_tts_config(&app)?;
    stored.enabled = Some(request.enabled);
    let provider = normalize_tts_provider(Some(request.provider));
    stored.provider = Some(provider.clone());
    stored.endpoint = if provider == TTS_PROVIDER_MANAGED_GPT_SOVITS {
        clean_optional(Some(request.endpoint))
            .or_else(|| {
                request
                    .managed_port
                    .map(|port| managed_gpt_sovits_base_url(port))
            })
            .or_else(|| Some(managed_gpt_sovits_base_url(DEFAULT_MANAGED_GPT_SOVITS_PORT)))
    } else {
        Some(clean_required(&request.endpoint, "语音服务地址")?)
    };
    stored.model = clean_optional(request.model);
    stored.voice = clean_optional(request.voice);
    stored.media_type = Some(normalize_tts_media_type(Some(request.media_type)));
    stored.text_lang = clean_optional(request.text_lang);
    stored.ref_audio_path = clean_optional(request.ref_audio_path);
    stored.prompt_lang = clean_optional(request.prompt_lang);
    stored.prompt_text = clean_optional(request.prompt_text);
    stored.speed_factor = Some(request.speed_factor.clamp(0.5, 2.0));
    stored.timeout_secs = Some(request.timeout_secs.clamp(5, 300));
    stored.managed_root = clean_optional(request.managed_root);
    stored.managed_python = clean_optional(request.managed_python);
    stored.managed_port = request.managed_port;
    stored.gpt_weight_path = clean_optional(request.gpt_weight_path);
    stored.sovits_weight_path = clean_optional(request.sovits_weight_path);

    if request.clear_api_key {
        stored.api_key = None;
    } else if let Some(api_key) = clean_optional(request.api_key) {
        stored.api_key = Some(api_key);
    }

    let view = tts_config_view(&stored);
    validate_tts_config(&view)?;
    save_stored_tts_config(&app, &stored)?;
    let _ = app.emit("tts-config-updated", view.clone());
    Ok(view)
}

#[tauri::command]
async fn synthesize_speech(
    app: AppHandle,
    managed_tts: State<'_, ManagedGptSovitsState>,
    request: TtsSynthesisRequest,
) -> Result<TtsSynthesisResponse, String> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err("要合成的文本不能为空。".to_string());
    }

    let stored = load_stored_tts_config(&app)?;
    let mut config = tts_config_view(&stored);
    config.enabled = true;
    validate_tts_config(&config)?;
    if config.provider == TTS_PROVIDER_MANAGED_GPT_SOVITS {
        ensure_managed_gpt_sovits(&app, managed_tts.inner(), &config).await?;
        config.endpoint = managed_gpt_sovits_base_url(config.managed_port);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_secs))
        .build()
        .map_err(|error| format!("创建语音 HTTP 客户端失败：{error}"))?;
    let url = tts_endpoint_url(&config.provider, &config.endpoint);
    let api_key = clean_optional(stored.api_key).or_else(|| read_env(&["TTS_API_KEY"]));

    let mut request_builder = client.post(url);
    if let Some(api_key) = api_key {
        request_builder = request_builder.bearer_auth(api_key);
    }

    let response = match config.provider.as_str() {
        TTS_PROVIDER_GPT_SOVITS | TTS_PROVIDER_MANAGED_GPT_SOVITS => {
            let payload = GptSovitsTtsRequest {
                text,
                text_lang: &config.text_lang,
                ref_audio_path: &config.ref_audio_path,
                prompt_lang: &config.prompt_lang,
                prompt_text: &config.prompt_text,
                media_type: &config.media_type,
                speed_factor: config.speed_factor,
                streaming_mode: false,
                text_split_method: "cut5",
                batch_size: 1,
                split_bucket: true,
                parallel_infer: true,
                repetition_penalty: 1.35,
            };
            request_builder.json(&payload).send().await
        }
        TTS_PROVIDER_OPENAI_COMPATIBLE => {
            let payload = OpenAiCompatibleSpeechRequest {
                model: &config.model,
                voice: &config.voice,
                input: text,
                response_format: &config.media_type,
                speed: config.speed_factor,
            };
            request_builder.json(&payload).send().await
        }
        _ => {
            let model = clean_optional(Some(config.model.clone()));
            let voice = clean_optional(Some(config.voice.clone()));
            let payload = CustomJsonSpeechRequest {
                text,
                input: text,
                model: model.as_deref(),
                voice: voice.as_deref(),
                format: &config.media_type,
                media_type: &config.media_type,
                speed: config.speed_factor,
            };
            request_builder.json(&payload).send().await
        }
    }
    .map_err(|error| format!("请求语音服务失败：{error}"))?;

    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("读取语音服务响应失败：{error}"))?;

    if !status.is_success() {
        let text = String::from_utf8_lossy(&body);
        return Err(format!(
            "语音服务返回错误 {status}：{}",
            truncate_error_body(&text)
        ));
    }

    if body.is_empty() {
        return Err("语音服务返回了空音频。".to_string());
    }

    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|value| value.starts_with("audio/"))
        .unwrap_or_else(|| content_type_for_audio(&config.media_type));
    let audio_data_url = format!(
        "data:{content_type};base64,{}",
        general_purpose::STANDARD.encode(&body)
    );

    Ok(TtsSynthesisResponse {
        audio_data_url,
        content_type,
        provider: config.provider,
    })
}

#[tauri::command]
async fn transcribe_speech(
    app: AppHandle,
    request: AsrTranscriptionRequest,
) -> Result<AsrTranscriptionResponse, String> {
    let stored = load_stored_asr_config(&app)?;
    let config = asr_config_view(&stored);
    if config.provider != ASR_PROVIDER_OPENAI_COMPATIBLE {
        return Err("当前识别模式不是高精度 ASR。".to_string());
    }

    let audio_bytes = decode_audio_data_url(&request.audio_data_url)?;
    if audio_bytes.is_empty() {
        return Err("音频片段为空。".to_string());
    }

    let content_type = request
        .mime_type
        .as_deref()
        .and_then(clean_optional_str)
        .unwrap_or_else(|| "audio/webm".to_string());
    let extension = if content_type.contains("wav") {
        "wav"
    } else if content_type.contains("mpeg") || content_type.contains("mp3") {
        "mp3"
    } else if content_type.contains("ogg") {
        "ogg"
    } else if content_type.contains("mp4") || content_type.contains("m4a") {
        "m4a"
    } else {
        "webm"
    };

    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(format!("speech.{extension}"))
        .mime_str(&content_type)
        .map_err(|error| format!("设置识别音频类型失败：{error}"))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", config.model.clone())
        .text("response_format", "json");
    if let Some(language) = clean_optional_str(&config.language) {
        form = form.text("language", language);
    }
    if let Some(prompt) = clean_optional_str(&config.prompt) {
        form = form.text("prompt", prompt);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_secs))
        .build()
        .map_err(|error| format!("创建识别 HTTP 客户端失败：{error}"))?;
    let mut http_request = client
        .post(asr_endpoint_url(&config.endpoint))
        .multipart(form);
    if let Some(api_key) =
        clean_optional(stored.api_key).or_else(|| read_env(&["ASR_API_KEY", "OPENAI_API_KEY"]))
    {
        http_request = http_request.bearer_auth(api_key);
    }

    let response = http_request
        .send()
        .await
        .map_err(|error| format!("语音识别请求失败：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取识别响应失败：{error}"))?;
    if !status.is_success() {
        return Err(format!("语音识别服务返回 {status}：{body}"));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| format!("解析识别响应失败：{error}"))?;
    let text = json
        .get("text")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("识别响应缺少 text 字段：{body}"))?
        .to_string();

    Ok(AsrTranscriptionResponse {
        text,
        provider: config.provider,
    })
}

#[tauri::command]
fn get_llm_config(app: AppHandle) -> Result<LlmConfigView, String> {
    let config = load_stored_llm_config(&app)?;
    Ok(config_view(&config))
}

#[tauri::command]
fn save_llm_config(app: AppHandle, request: SaveLlmConfigRequest) -> Result<LlmConfigView, String> {
    let mut config = load_stored_llm_config(&app)?;
    let base_url = clean_required(&request.base_url, "Base URL")?;
    let model = clean_required(&request.model, "模型名")?;

    if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
        return Err("Base URL 需要以 http:// 或 https:// 开头。".to_string());
    }

    if !(5..=300).contains(&request.timeout_secs) {
        return Err("超时时间需要在 5 到 300 秒之间。".to_string());
    }

    config.base_url = Some(base_url);
    config.model = Some(model);
    config.timeout_secs = Some(request.timeout_secs);
    config.pet_interaction_system_prompt = clean_optional(request.pet_interaction_system_prompt);

    if request.clear_api_key {
        config.api_key = None;
    } else if let Some(api_key) = clean_optional(request.api_key) {
        config.api_key = Some(api_key);
    }

    save_stored_llm_config(&app, &config)?;
    Ok(config_view(&config))
}

#[tauri::command]
fn get_interaction_history(
    app: AppHandle,
    limit: Option<usize>,
) -> Result<Vec<InteractionRecord>, String> {
    let mut history = load_interaction_history(&app)?;
    if let Some(limit) = limit {
        if history.len() > limit {
            let start = history.len() - limit;
            history = history.split_off(start);
        }
    }

    Ok(history)
}

#[tauri::command]
fn clear_interaction_history(app: AppHandle) -> Result<(), String> {
    save_interaction_history(&app, &[])
}

#[tauri::command]
async fn llm_pet_interact(
    app: AppHandle,
    request: PetInteractionRequest,
) -> Result<PetInteractionResponse, String> {
    let history = load_interaction_history(&app)?;
    let prompt = format!(
        "最近交互历史：\n{}\n\n{}",
        format_history_for_prompt(&history),
        describe_pet_interaction(&request)
    );

    let mut llm_used = false;
    let assistant_text = match effective_llm_config(&app, None) {
        Ok(config) => {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(config.timeout_secs))
                .build()
                .map_err(|error| format!("创建 LLM HTTP 客户端失败：{error}"))?;
            let messages = vec![
                LlmMessage {
                    role: "system".to_string(),
                    content: config.pet_interaction_system_prompt.clone(),
                },
                LlmMessage {
                    role: "user".to_string(),
                    content: prompt,
                },
            ];
            let payload = OpenAiCompatibleChatRequest {
                model: &config.model,
                messages: &messages,
                stream: false,
                temperature: Some(0.82),
                max_tokens: Some(180),
            };

            match client
                .post(chat_completions_url(&config.base_url))
                .bearer_auth(config.api_key)
                .json(&payload)
                .send()
                .await
            {
                Ok(response) => {
                    let status = response.status();
                    match response.text().await {
                        Ok(body) if status.is_success() => {
                            match serde_json::from_str::<OpenAiCompatibleChatResponse>(&body) {
                                Ok(parsed) => {
                                    let content = parsed
                                        .choices
                                        .into_iter()
                                        .next()
                                        .map(|choice| extract_message_text(&choice.message))
                                        .unwrap_or_default();

                                    if content.is_empty() {
                                        "我刚刚听见了，但外脑没吐出一句完整的话。".to_string()
                                    } else {
                                        llm_used = true;
                                        content
                                    }
                                }
                                Err(_) => "外脑回信格式怪怪的，我先眨眨眼。".to_string(),
                            }
                        }
                        Ok(body) => format!(
                            "外脑暂时卡住了：{}",
                            truncate_error_body(&body)
                                .chars()
                                .take(36)
                                .collect::<String>()
                        ),
                        Err(_) => "外脑有回应，但我没能读清楚。".to_string(),
                    }
                }
                Err(_) => "外脑连线失败了，我先靠本能陪你一下。".to_string(),
            }
        }
        Err(_) => "右键我打开设置页，填好 API 后就能记录并思考互动啦。".to_string(),
    };

    let record = InteractionRecord {
        id: 0,
        timestamp_ms: now_ms(),
        source: request.source,
        interaction_tool: clean_optional(request.interaction_tool),
        area: clean_optional(request.area),
        x_percent: request.x_percent,
        y_percent: request.y_percent,
        user_text: clean_optional(request.user_text),
        assistant_text: assistant_text.clone(),
        llm_used,
    };
    let record = append_interaction_history(&app, record)?;

    Ok(PetInteractionResponse {
        content: assistant_text,
        record,
    })
}

#[tauri::command]
async fn llm_pet_interact_stream(
    app: AppHandle,
    stream_id: String,
    request: PetInteractionRequest,
) -> Result<PetInteractionResponse, String> {
    let history = load_interaction_history(&app)?;
    let prompt = format!(
        "最近交互历史：\n{}\n\n{}",
        format_history_for_prompt(&history),
        describe_pet_interaction(&request)
    );

    let mut llm_used = false;
    let assistant_text = match effective_llm_config(&app, None) {
        Ok(config) => {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(config.timeout_secs))
                .build()
                .map_err(|error| format!("创建 LLM HTTP 客户端失败：{error}"))?;
            let messages = vec![
                LlmMessage {
                    role: "system".to_string(),
                    content: config.pet_interaction_system_prompt.clone(),
                },
                LlmMessage {
                    role: "user".to_string(),
                    content: prompt,
                },
            ];
            let payload = OpenAiCompatibleChatRequest {
                model: &config.model,
                messages: &messages,
                stream: true,
                temperature: Some(0.82),
                max_tokens: Some(180),
            };

            match client
                .post(chat_completions_url(&config.base_url))
                .bearer_auth(config.api_key)
                .json(&payload)
                .send()
                .await
            {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        match response.text().await {
                            Ok(body) => format!(
                                "外脑暂时卡住了：{}",
                                truncate_error_body(&body)
                                    .chars()
                                    .take(36)
                                    .collect::<String>()
                            ),
                            Err(_) => "外脑有回应，但我没能读清楚。".to_string(),
                        }
                    } else {
                        let mut content = String::new();
                        let mut buffer = String::new();
                        let mut stream = response.bytes_stream();

                        while let Some(chunk) = stream.next().await {
                            match chunk {
                                Ok(bytes) => {
                                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                                    while let Some((end, skip)) = sse_frame_end(&buffer) {
                                        let frame = buffer[..end].to_string();
                                        buffer = buffer[end + skip..].to_string();

                                        for delta in parse_stream_frame(&frame) {
                                            llm_used = true;
                                            content.push_str(&delta);
                                            emit_pet_interaction_stream(
                                                &app,
                                                &stream_id,
                                                "delta",
                                                Some(delta),
                                                None,
                                                None,
                                                None,
                                            );
                                        }
                                    }
                                }
                                Err(_) => {
                                    return Ok(finalize_pet_interaction(
                                        &app,
                                        &stream_id,
                                        request,
                                        "外脑流式连线中断了，我先靠本能陪你一下。".to_string(),
                                        false,
                                    )?);
                                }
                            }
                        }

                        for delta in parse_stream_frame(&buffer) {
                            llm_used = true;
                            content.push_str(&delta);
                            emit_pet_interaction_stream(
                                &app,
                                &stream_id,
                                "delta",
                                Some(delta),
                                None,
                                None,
                                None,
                            );
                        }

                        if content.is_empty() {
                            if let Ok(parsed) =
                                serde_json::from_str::<OpenAiCompatibleChatResponse>(buffer.trim())
                            {
                                if let Some(choice) = parsed.choices.into_iter().next() {
                                    let parsed_content = extract_message_text(&choice.message);
                                    if !parsed_content.is_empty() {
                                        llm_used = true;
                                        emit_pet_interaction_stream(
                                            &app,
                                            &stream_id,
                                            "delta",
                                            Some(parsed_content.clone()),
                                            None,
                                            None,
                                            None,
                                        );
                                        content = parsed_content;
                                    }
                                }
                            }
                        }

                        if content.is_empty() {
                            "我刚刚听见了，但外脑没吐出一句完整的话。".to_string()
                        } else {
                            clean_model_text(&content)
                        }
                    }
                }
                Err(_) => "外脑连线失败了，我先靠本能陪你一下。".to_string(),
            }
        }
        Err(_) => "右键我打开设置页，填好 API 后就能记录并思考互动啦。".to_string(),
    };

    finalize_pet_interaction(&app, &stream_id, request, assistant_text, llm_used)
}

fn finalize_pet_interaction(
    app: &AppHandle,
    stream_id: &str,
    request: PetInteractionRequest,
    assistant_text: String,
    llm_used: bool,
) -> Result<PetInteractionResponse, String> {
    let record = InteractionRecord {
        id: 0,
        timestamp_ms: now_ms(),
        source: request.source,
        interaction_tool: clean_optional(request.interaction_tool),
        area: clean_optional(request.area),
        x_percent: request.x_percent,
        y_percent: request.y_percent,
        user_text: clean_optional(request.user_text),
        assistant_text: assistant_text.clone(),
        llm_used,
    };
    let record = append_interaction_history(app, record)?;

    emit_pet_interaction_stream(
        app,
        stream_id,
        "done",
        None,
        Some(assistant_text.clone()),
        Some(record.clone()),
        None,
    );

    Ok(PetInteractionResponse {
        content: assistant_text,
        record,
    })
}

#[tauri::command]
async fn llm_chat(app: AppHandle, request: LlmChatRequest) -> Result<LlmChatResponse, String> {
    validate_llm_request(&request)?;

    let config = effective_llm_config(&app, request.model.clone())?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout_secs))
        .build()
        .map_err(|error| format!("创建 LLM HTTP 客户端失败：{error}"))?;

    let payload = OpenAiCompatibleChatRequest {
        model: &config.model,
        messages: &request.messages,
        stream: false,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
    };

    let response = client
        .post(chat_completions_url(&config.base_url))
        .bearer_auth(config.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("请求 LLM API 失败：{error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取 LLM API 响应失败：{error}"))?;

    if !status.is_success() {
        return Err(format!(
            "LLM API 返回错误 {status}：{}",
            truncate_error_body(&body)
        ));
    }

    let parsed: OpenAiCompatibleChatResponse =
        serde_json::from_str(&body).map_err(|error| format!("解析 LLM API 响应失败：{error}"))?;
    let choice = parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| "LLM API 响应里没有 choices。".to_string())?;
    let content = extract_message_text(&choice.message);

    if content.is_empty() {
        return Err("LLM API 返回了空内容。".to_string());
    }

    Ok(LlmChatResponse {
        content,
        model: config.model,
        finish_reason: choice.finish_reason,
        usage: parsed.usage.map(Into::into),
    })
}

#[tauri::command]
#[allow(dead_code)]
async fn llm_chat_from_env(request: LlmChatRequest) -> Result<LlmChatResponse, String> {
    validate_llm_request(&request)?;

    let api_key = read_env(&["LLM_API_KEY", "OPENAI_API_KEY"])
        .ok_or_else(|| "未配置 LLM_API_KEY 或 OPENAI_API_KEY。".to_string())?;
    let base_url = read_env(&["LLM_BASE_URL", "OPENAI_BASE_URL"])
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let model = request
        .model
        .clone()
        .or_else(|| read_env(&["LLM_MODEL", "OPENAI_MODEL"]))
        .ok_or_else(|| "未配置模型名，请设置 LLM_MODEL 或在请求里传 model。".to_string())?;
    let timeout_secs = parse_env_u64("LLM_TIMEOUT_SECS", 45)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|error| format!("创建 LLM HTTP 客户端失败：{error}"))?;

    let payload = OpenAiCompatibleChatRequest {
        model: &model,
        messages: &request.messages,
        stream: false,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
    };

    let response = client
        .post(chat_completions_url(&base_url))
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("请求 LLM API 失败：{error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取 LLM API 响应失败：{error}"))?;

    if !status.is_success() {
        return Err(format!(
            "LLM API 返回错误 {status}：{}",
            truncate_error_body(&body)
        ));
    }

    let parsed: OpenAiCompatibleChatResponse =
        serde_json::from_str(&body).map_err(|error| format!("解析 LLM API 响应失败：{error}"))?;
    let choice = parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| "LLM API 响应里没有 choices。".to_string())?;
    let content = extract_message_text(&choice.message);

    if content.is_empty() {
        return Err("LLM API 返回了空内容。".to_string());
    }

    Ok(LlmChatResponse {
        content,
        model,
        finish_reason: choice.finish_reason,
        usage: parsed.usage.map(Into::into),
    })
}

#[tauri::command]
fn list_custom_skins(app: AppHandle) -> Result<Vec<CustomSkinView>, String> {
    let dir = custom_skins_dir(&app)?;
    let mut skins = Vec::new();

    for entry in fs::read_dir(&dir).map_err(|error| format!("读取自定义皮肤目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取自定义皮肤失败：{error}"))?;
        let skin_dir = entry.path();
        if !skin_dir.is_dir() {
            continue;
        }

        let manifest_path = skin_dir.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }

        let text = fs::read_to_string(&manifest_path)
            .map_err(|error| format!("读取自定义皮肤清单失败：{error}"))?;
        match serde_json::from_str::<CustomSkinManifest>(&text) {
            Ok(manifest) => skins.push(manifest_to_custom_skin_view(&skin_dir, manifest)),
            Err(error) => eprintln!(
                "Failed to parse custom skin manifest {:?}: {error}",
                manifest_path
            ),
        }
    }

    skins.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(skins)
}

#[tauri::command]
fn save_custom_skin(
    app: AppHandle,
    request: SaveCustomSkinRequest,
) -> Result<CustomSkinView, String> {
    if request.asset_width == 0 || request.asset_height == 0 {
        return Err("皮肤图片尺寸无效。".to_string());
    }

    let name = clean_required(&request.name, "皮肤名称")?;
    let layout = normalize_skin_layout(&request.layout);
    let root = custom_skins_dir(&app)?;
    let requested_id = request.id.as_deref().unwrap_or(&name);
    let mut id = sanitize_skin_id(requested_id);
    let mut skin_dir = root.join(&id);

    if skin_dir.exists() {
        id = format!("{id}-{}", current_timestamp_ms());
        skin_dir = root.join(&id);
    }

    fs::create_dir_all(&skin_dir).map_err(|error| format!("创建皮肤目录失败：{error}"))?;

    let assets = CustomSkinAssets {
        idle: "idle.png".to_string(),
        surprised: "surprised.png".to_string(),
        blink: "blink_overlay.png".to_string(),
        mouth_talk: "mouth_talk_overlay.png".to_string(),
        mouth_o: "mouth_o_overlay.png".to_string(),
    };

    write_skin_data_url(&skin_dir.join(&assets.idle), &request.images.idle_data_url)?;
    write_skin_data_url(
        &skin_dir.join(&assets.surprised),
        &request.images.surprised_data_url,
    )?;
    write_skin_data_url(
        &skin_dir.join(&assets.blink),
        &request.images.blink_data_url,
    )?;
    write_skin_data_url(
        &skin_dir.join(&assets.mouth_talk),
        &request.images.mouth_talk_data_url,
    )?;
    write_skin_data_url(
        &skin_dir.join(&assets.mouth_o),
        &request.images.mouth_o_data_url,
    )?;

    let manifest = CustomSkinManifest {
        schema_version: 1,
        id,
        name,
        layout,
        asset_width: request.asset_width,
        asset_height: request.asset_height,
        hit_calibration_y: request.hit_calibration_y.unwrap_or(0.0),
        assets,
    };

    let manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("生成皮肤清单失败：{error}"))?;
    fs::write(skin_dir.join("manifest.json"), manifest_text)
        .map_err(|error| format!("保存皮肤清单失败：{error}"))?;

    Ok(manifest_to_custom_skin_view(&skin_dir, manifest))
}

#[tauri::command]
fn delete_custom_skin(app: AppHandle, id: String) -> Result<(), String> {
    let clean_id = sanitize_skin_id(&id);
    if clean_id != id {
        return Err("皮肤 ID 无效。".to_string());
    }

    let root = custom_skins_dir(&app)?;
    let skin_dir = root.join(&clean_id);
    if !skin_dir.exists() {
        return Ok(());
    }

    if !skin_dir.is_dir() {
        return Err("皮肤路径不是目录，已取消删除。".to_string());
    }

    fs::remove_dir_all(&skin_dir).map_err(|error| format!("删除皮肤失败：{error}"))
}

#[tauri::command]
#[cfg(not(mobile))]
fn move_pet_window(window: Window, x: f64, y: f64) -> Result<(), String> {
    window
        .set_position(Position::Logical(LogicalPosition::new(x, y)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(mobile)]
fn move_pet_window(_window: Window, _x: f64, _y: f64) -> Result<(), String> {
    // Android is a full-screen app in the first phase. Keep this as a no-op so
    // shared front-end drag code can call the same command on every platform.
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
fn get_pet_window_position(window: Window) -> Result<WindowPosition, String> {
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;

    Ok(WindowPosition {
        x: position.x as f64 / scale_factor,
        y: position.y as f64 / scale_factor,
        window_width: None,
        physical_x: None,
        physical_y: None,
    })
}

#[tauri::command]
#[cfg(mobile)]
fn get_pet_window_position(_window: Window) -> Result<WindowPosition, String> {
    Ok(WindowPosition {
        x: 0.0,
        y: 0.0,
        window_width: None,
        physical_x: None,
        physical_y: None,
    })
}

#[tauri::command]
#[cfg(not(mobile))]
fn get_pet_cursor_position(window: Window) -> Result<WindowPosition, String> {
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let window_position = window.outer_position().map_err(|error| error.to_string())?;
    let window_size = window.outer_size().map_err(|error| error.to_string())?;
    let cursor_position = window
        .cursor_position()
        .map_err(|error| error.to_string())?;
    let physical_position = global_cursor_position_physical();
    Ok(WindowPosition {
        x: (cursor_position.x - f64::from(window_position.x)) / scale_factor,
        y: (cursor_position.y - f64::from(window_position.y)) / scale_factor,
        window_width: Some(f64::from(window_size.width)),
        physical_x: physical_position.map(|(x, _)| x - f64::from(window_position.x)),
        physical_y: physical_position.map(|(_, y)| y - f64::from(window_position.y)),
    })
}

#[tauri::command]
#[cfg(mobile)]
fn get_pet_cursor_position(_window: Window) -> Result<WindowPosition, String> {
    Ok(WindowPosition {
        x: 0.0,
        y: 0.0,
        window_width: None,
        physical_x: None,
        physical_y: None,
    })
}

#[tauri::command]
#[cfg(not(mobile))]
fn resize_pet_window(window: Window, width: f64, height: f64) -> Result<(), String> {
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let outer_position = window.outer_position().map_err(|error| error.to_string())?;
    let outer_size = window.outer_size().map_err(|error| error.to_string())?;

    let bottom = outer_position.y + outer_size.height as i32;
    let center_x = outer_position.x as f64 + outer_size.width as f64 / 2.0;
    let width_physical = (width * scale_factor).round();
    let height_physical = (height * scale_factor).round();

    let next_x = (center_x - width_physical / 2.0).round() as i32;
    let next_y = bottom - height_physical.round() as i32;

    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| error.to_string())?;

    window
        .set_position(Position::Physical(PhysicalPosition::new(next_x, next_y)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(mobile)]
fn resize_pet_window(_window: Window, _width: f64, _height: f64) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
fn set_pet_always_on_top(window: Window, always_on_top: bool) -> Result<(), String> {
    window
        .set_always_on_top(always_on_top)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(mobile)]
fn set_pet_always_on_top(_window: Window, _always_on_top: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
fn set_pet_ignore_cursor_events(window: Window, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(mobile)]
fn set_pet_ignore_cursor_events(_window: Window, _ignore: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
fn close_current_window(window: Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(mobile)]
fn close_current_window(_window: Window) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
fn close_pet(app: AppHandle) -> Result<(), String> {
    let mut close_error = None;

    for label in ["mask-editor", "settings", "settings-menu", "main"] {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.close() {
                close_error.get_or_insert_with(|| format!("关闭窗口 {label} 失败：{error}"));
            }
        }
    }

    let app_for_fallback = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        if !app_for_fallback.webview_windows().is_empty() {
            app_for_fallback.exit(0);
        }
    });

    if let Some(error) = close_error {
        return Err(error);
    }

    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
fn close_pet(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(mobile))]
fn mask_editor_url() -> Result<WebviewUrl, String> {
    if cfg!(debug_assertions) {
        "http://localhost:1420/?view=mask-editor"
            .parse()
            .map(WebviewUrl::External)
            .map_err(|error| format!("invalid mask editor dev url: {error}"))
    } else {
        Ok(WebviewUrl::App("index.html?view=mask-editor".into()))
    }
}

#[cfg(not(mobile))]
fn settings_window_url() -> Result<WebviewUrl, String> {
    if cfg!(debug_assertions) {
        "http://localhost:1420/?view=settings"
            .parse()
            .map(WebviewUrl::External)
            .map_err(|error| format!("invalid settings window dev url: {error}"))
    } else {
        Ok(WebviewUrl::App("index.html?view=settings".into()))
    }
}

#[cfg(not(mobile))]
fn show_pet_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|error| error.to_string())?;
        let _ = window.unminimize();
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(mobile))]
fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app
        .get_webview_window("settings")
        .or_else(|| app.get_webview_window("settings-menu"))
    {
        window.show().map_err(|error| error.to_string())?;
        let _ = window.unminimize();
        return window.set_focus().map_err(|error| error.to_string());
    }

    let window = WebviewWindowBuilder::new(app, "settings", settings_window_url()?)
        .title("Silver Pet Settings")
        .inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
        .min_inner_size(760.0, 620.0)
        .center()
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;

    let _ = window.center();
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(not(mobile))]
fn setup_tray(app: &App) -> tauri::Result<()> {
    let show_pet = MenuItem::with_id(app, "show-pet", "显示桌宠", true, None::<&str>)?;
    let open_settings = MenuItem::with_id(app, "open-settings", "打开设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_pet, &open_settings, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id("silver-pet-tray")
        .menu(&menu)
        .tooltip("Silver Pet")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-pet" => {
                if let Err(error) = show_pet_window(app) {
                    eprintln!("failed to show pet from tray: {error}");
                }
            }
            "open-settings" => {
                if let Err(error) = show_settings_window(app) {
                    eprintln!("failed to open settings from tray: {error}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(error) = show_pet_window(tray.app_handle()) {
                    eprintln!("failed to show pet from tray click: {error}");
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

#[tauri::command]
#[cfg(not(mobile))]
async fn open_mask_editor(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("mask-editor") {
        let _ = window.show();
        return window.set_focus().map_err(|error| error.to_string());
    }

    WebviewWindowBuilder::new(&app, "mask-editor", mask_editor_url()?)
        .title("Silver Pet Mask Editor")
        .inner_size(920.0, 760.0)
        .min_inner_size(760.0, 620.0)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(mobile)]
async fn open_mask_editor(_app: AppHandle) -> Result<(), String> {
    Err("移动端暂不支持独立蒙版编辑器。".to_string())
}

#[tauri::command]
#[cfg(not(mobile))]
async fn open_settings_menu(
    app: AppHandle,
    _anchor_x: Option<f64>,
    _anchor_y: Option<f64>,
) -> Result<(), String> {
    show_settings_window(&app)
}

#[tauri::command]
#[cfg(mobile)]
async fn open_settings_menu(
    _app: AppHandle,
    _anchor_x: Option<f64>,
    _anchor_y: Option<f64>,
) -> Result<(), String> {
    Err("移动端使用内置设置面板。".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(not(mobile))]
    let builder = builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("pet-open-input", PET_INPUT_SHORTCUT_LABEL);
                    }
                })
                .build(),
        )
        .setup(|app| {
            setup_tray(app)?;
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
            if let Err(error) = app.global_shortcut().register(shortcut) {
                eprintln!(
                    "global shortcut {PET_INPUT_SHORTCUT_LABEL} is unavailable; continuing without it: {error}"
                );
            }
            Ok(())
        });

    let builder = builder.manage(ManagedGptSovitsState::default());

    #[cfg(windows)]
    let builder = builder.manage(NativeSpeechState::default());

    builder
        .invoke_handler(tauri::generate_handler![
            clear_interaction_history,
            close_current_window,
            delete_custom_skin,
            get_asr_config,
            get_llm_config,
            get_interaction_history,
            get_pet_cursor_position,
            get_pet_window_position,
            get_tts_config,
            list_tts_assets,
            list_custom_skins,
            llm_chat,
            llm_pet_interact,
            llm_pet_interact_stream,
            pick_tts_path,
            save_llm_config,
            save_asr_config,
            save_tts_config,
            save_custom_skin,
            start_native_speech_recognition,
            stop_native_speech_recognition,
            synthesize_speech,
            transcribe_speech,
            move_pet_window,
            open_mask_editor,
            open_settings_menu,
            open_windows_speech_privacy_settings,
            resize_pet_window,
            set_pet_always_on_top,
            set_pet_ignore_cursor_events,
            close_pet
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
