use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Position, Size,
    Window,
};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

const DEFAULT_LLM_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_LLM_TIMEOUT_SECS: u64 = 45;
const LLM_CONFIG_FILE: &str = "llm_config.json";
const INTERACTION_HISTORY_FILE: &str = "interaction_history.json";
const MAX_HISTORY_RECORDS: usize = 240;
const PET_INPUT_SHORTCUT_LABEL: &str = "Ctrl+Alt+Space";
const PET_INTERACTION_SYSTEM_PROMPT: &str = "你是银白发桌宠，正在和用户互动。请参考最近交互历史，用中文给出一句自然、温柔、俏皮的桌宠回应。回复不超过 42 个汉字，不要解释，不要加引号。";

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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLlmConfigRequest {
    api_key: Option<String>,
    clear_api_key: bool,
    base_url: String,
    model: String,
    timeout_secs: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmConfigView {
    has_api_key: bool,
    masked_api_key: Option<String>,
    base_url: String,
    model: String,
    timeout_secs: u64,
}

#[derive(Debug, Clone)]
struct EffectiveLlmConfig {
    api_key: String,
    base_url: String,
    model: String,
    timeout_secs: u64,
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
    #[serde(default)]
    area: Option<String>,
    #[serde(default, alias = "x_percent")]
    x_percent: Option<f64>,
    #[serde(default, alias = "y_percent")]
    y_percent: Option<f64>,
    #[serde(default, alias = "user_text")]
    user_text: Option<String>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmUsage {
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    total_tokens: Option<u32>,
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
struct OpenAiCompatibleChoice {
    message: OpenAiCompatibleMessage,
    finish_reason: Option<String>,
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

fn clean_required(value: &str, field: &str) -> Result<String, String> {
    let cleaned = value.trim().to_string();
    if cleaned.is_empty() {
        Err(format!("{field} 不能为空。"))
    } else {
        Ok(cleaned)
    }
}

fn llm_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("获取应用配置目录失败：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建应用配置目录失败：{error}"))?;
    Ok(dir.join(LLM_CONFIG_FILE))
}

fn interaction_history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("获取应用配置目录失败：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建应用配置目录失败：{error}"))?;
    Ok(dir.join(INTERACTION_HISTORY_FILE))
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

fn save_interaction_history(
    app: &AppHandle,
    history: &[InteractionRecord],
) -> Result<(), String> {
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
            fs::rename(&tmp_path, &path)
                .map_err(|error| format!("保存交互历史失败：{error}"))
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
    }
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

    Ok(EffectiveLlmConfig {
        api_key,
        base_url,
        model,
        timeout_secs,
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
    for value in [
        message.content.as_ref(),
        message.text.as_ref(),
    ]
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
            let user = record.user_text.as_deref().unwrap_or("");
            let position = match (record.x_percent, record.y_percent) {
                (Some(x), Some(y)) => format!("位置 {:.1}%, {:.1}%", x, y),
                _ => "无坐标".to_string(),
            };
            format!(
                "- {} / {} / {} / 用户文本：{} / 回复：{}",
                record.source, area, position, user, record.assistant_text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn describe_pet_interaction(request: &PetInteractionRequest) -> String {
    let area = request.area.as_deref().unwrap_or("未指定");
    let user_text = request.user_text.as_deref().unwrap_or("");
    let position = match (request.x_percent, request.y_percent) {
        (Some(x), Some(y)) => format!("{:.1}%, {:.1}%", x, y),
        _ => "未记录".to_string(),
    };

    format!(
        "当前交互：来源={}；部位={}；位置={}；用户文本={}；亲密度={}；状态={}；背景模式={}。请生成桌宠回应。",
        request.source,
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
                    content: PET_INTERACTION_SYSTEM_PROMPT.to_string(),
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
                            truncate_error_body(&body).chars().take(36).collect::<String>()
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
fn move_pet_window(window: Window, x: f64, y: f64) -> Result<(), String> {
    window
        .set_position(Position::Logical(LogicalPosition::new(x, y)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
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
fn start_pet_drag(window: Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_pet_always_on_top(window: Window, always_on_top: bool) -> Result<(), String> {
    window
        .set_always_on_top(always_on_top)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn close_pet(window: Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
            app.global_shortcut()
                .register(shortcut)
                .map_err(|error| format!("register global shortcut failed: {error}"))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            clear_interaction_history,
            get_llm_config,
            get_interaction_history,
            llm_chat,
            llm_pet_interact,
            save_llm_config,
            move_pet_window,
            resize_pet_window,
            start_pet_drag,
            set_pet_always_on_top,
            close_pet
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
