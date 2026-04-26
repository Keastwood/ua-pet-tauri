# LLM Backend

The desktop pet has a Tauri-side LLM backend command named `llm_chat`.
The frontend does not store the API key in `localStorage`; it sends the key to Rust only when you save the settings form.

## Configure In The App

1. Start the app normally:

```powershell
npm run tauri dev
```

2. Right-click the desktop pet.
3. Fill in API Key, Base URL, model, and timeout.
4. Click Save, or Test Connection to save and immediately verify the API.

The config is saved by the Tauri backend in the app config directory as `llm_config.json`.
When an API key already exists, the settings panel shows only a masked key; leave the API Key field blank to keep it.

## Supported API Shape

`llm_chat` targets OpenAI-compatible chat completions APIs:

```text
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
```

The API response should include `choices[0].message.content`.

Examples of compatible Base URLs:

```text
https://api.openai.com/v1
https://api.deepseek.com/v1
```

## Environment Fallback

Runtime settings are preferred. Environment variables are only a fallback for development or quick testing:

```powershell
$env:LLM_API_KEY="your-api-key"
$env:LLM_MODEL="your-model-name"
$env:LLM_BASE_URL="https://api.openai.com/v1"
```

Aliases are also supported: `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL`.
