# LLM Backend

UA Pet has a Tauri-side OpenAI-compatible LLM backend. API credentials are configured at runtime from the app UI, so you do not need to set environment variables before starting the app.

## Runtime Configuration

1. Start the app:

```powershell
npm run tauri dev
```

2. Right-click the desktop pet.
3. Fill in API Key, Base URL, model, timeout, and optionally a custom pet interaction system prompt.
4. Click Save, or Test Connection to save and immediately verify the API.

The config is saved by the Tauri backend in the app config directory as `llm_config.json`. The repository ignores this file.

When an API key already exists, the settings panel shows only a masked key. Leave the API Key field blank to keep the saved key.

## Supported API Shape

The backend targets OpenAI-compatible chat completions APIs:

```text
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
```

The parser accepts `choices[0].message.content` as a string, and also accepts content arrays/objects with nested `text` or `content` fields.

Examples of compatible Base URLs:

```text
https://api.openai.com/v1
https://api.deepseek.com/v1
```

## Prompt Categories

There are two prompt flows:

1. Normal chat button prompt
2. Pet interaction prompt

Normal chat uses `llm_chat`. Its system prompt is currently defined in `src/main.ts` as `PET_LLM_SYSTEM_PROMPT`. This is a short desktop-pet persona prompt used when the user clicks the Chat button outside the full interaction mode.

Pet interaction uses `llm_pet_interact_stream` in the frontend path. It sends `stream: true` to the compatible chat completions API, emits `pet-interaction-stream` events while chunks arrive, then writes the final response into interaction history.

The older `llm_pet_interact` command is still present as a non-streaming backend path, but the desktop interaction UI uses the streaming command.

The default system prompt is defined in `src-tauri/src/lib.rs` as `DEFAULT_PET_INTERACTION_SYSTEM_PROMPT`, and can be overridden from the right-click settings page.

Default pet interaction system prompt:

```text
你是银白发桌宠，正在和用户互动。用户会先选择一个交互控件，例如手指、手掌、嘴、脚、羽毛、梳子或零食，再点击桌宠的具体部位。请参考控件、部位、坐标和最近交互历史，用中文给出一句自然、温柔、俏皮的桌宠回应。回复不超过 42 个汉字，不要解释，不要加引号。
```

The pet interaction user prompt is generated in `src-tauri/src/lib.rs` by `format_history_for_prompt` and `describe_pet_interaction`. It includes:

- Recent interaction history
- Interaction source, such as click, shortcut, or button
- Selected interaction tool, such as hand/finger/mouth/foot
- Target body part, such as head, mouth, sleeve, or hair
- Click coordinates as percentages
- User text, if provided
- Affection value, current mood, and scene mode

Before the first stream chunk arrives, the frontend shows a thinking indicator cycling from `·` to `······`. Once the first delta arrives, the speech bubble switches to the streamed text.

## Interaction Tools

The current selectable tools are defined in `src/main.ts` as `INTERACTION_TOOLS`:

- 手指
- 手掌
- 嘴
- 脚
- 羽毛
- 梳子
- 零食

Click target mapping is defined in `src/main.ts` as `PET_HIT_AREA_RULES`. It maps click coordinates to semantic parts such as mouth, nose, eyes, face, hair, neck, shoulder, collarbone, chest, belly, waist, arm, and hand. The lower outfit-looking areas intentionally map to body-part semantics instead of clothing names.

## Environment Fallback

Runtime settings are preferred. Environment variables are only a fallback for development or quick testing:

```powershell
$env:LLM_API_KEY="your-api-key"
$env:LLM_MODEL="your-model-name"
$env:LLM_BASE_URL="https://api.openai.com/v1"
```

Aliases are also supported: `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL`.
