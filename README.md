# UA Pet Tauri

一个基于 Tauri 2 + Vanilla TypeScript 的桌面宠物应用。当前版本支持透明桌宠窗口、点击互动、表情切换、可选背景模式、运行时配置 LLM、交互历史记录，以及可选择交互控件的桌宠互动。

## 功能

- 透明无边框桌宠窗口，默认置顶并隐藏任务栏图标。
- 点击桌宠不同部位触发互动，并支持亲密度和状态反馈。
- 可选择交互控件，例如手指、手掌、嘴、脚、羽毛、梳子、零食。
- LLM 交互模式会记录控件、目标部位、点击坐标、文本输入和模型回复。
- 右键桌宠打开设置页，运行时配置 OpenAI 兼容 LLM API 和桌宠交互系统提示词。
- 历史页可查看或清空最近交互记录。
- 全局快捷键 `Ctrl + Alt + Space` 可唤出悬浮输入框。
- 支持眨眼、说话口型、惊讶表情和带背景边框的展示模式。

## 开发

需要先安装 Node.js、npm 和 Rust 工具链。

```powershell
npm install
npm run tauri dev
```

## 构建

```powershell
npm run build
npm run tauri build
```

仅检查前端和 Rust 编译：

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## LLM 与提示词

启动应用后右键桌宠，填写 API Key、Base URL、模型名、超时时间和可选的桌宠交互系统提示词。配置由 Tauri 后端保存到应用配置目录，不会写入仓库。

提示词分两类：

- 普通聊天按钮提示词在 `src/main.ts` 的 `PET_LLM_SYSTEM_PROMPT`。
- 点击/快捷输入等桌宠交互提示词在 `src-tauri/src/lib.rs` 的 `DEFAULT_PET_INTERACTION_SYSTEM_PROMPT`，也可以在设置页覆盖。

完整说明见 [LLM_BACKEND.md](./LLM_BACKEND.md)。

## 主要目录

- `src/main.ts`：桌宠状态、交互控件、点击部位映射、历史页、悬浮输入框和前端 LLM 调用。
- `src/styles.css`：桌宠界面、交互控件、背景模式、设置页、历史页和悬浮输入框样式。
- `src/assets/pet/`：桌宠 PNG 素材。
- `src-tauri/src/lib.rs`：Tauri 命令、窗口控制、LLM 后端、交互历史持久化、系统提示词配置和全局快捷键。
- `src-tauri/tauri.conf.json`：Tauri 应用配置。
