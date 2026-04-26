# UA Pet Tauri

一个基于 Tauri 2 + Vanilla TypeScript 的桌面宠物应用。当前版本支持透明桌宠窗口、点击互动、表情切换、可选背景模式、运行时配置 LLM，以及交互历史记录。

## 功能

- 透明无边框桌宠窗口，默认置顶并隐藏任务栏图标。
- 点击头部、身体触发不同互动，并支持亲密度和状态反馈。
- 眨眼、说话口型、惊讶表情等基础动画表现。
- 可开启带背景和边框的美观展示模式。
- 右键桌宠打开设置页，运行时配置 OpenAI 兼容 LLM API，无需启动前设置环境变量。
- LLM 交互模式会记录点击来源、点击部位、点击位置和文本输入，并让模型参考历史生成回应。
- 历史页可查看或清空最近交互记录。
- 全局快捷键 `Ctrl + Alt + Space` 可唤出悬浮输入框。

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

## LLM 配置

启动应用后右键桌宠，填写 API Key、Base URL、模型名和超时时间即可。配置由 Tauri 后端保存到应用配置目录，不会写入仓库。

更多说明见 [LLM_BACKEND.md](./LLM_BACKEND.md)。

## 主要目录

- `src/main.ts`：桌宠状态、点击交互、历史页、悬浮输入框和前端 LLM 调用。
- `src/styles.css`：桌宠界面、背景模式、设置页、历史页和悬浮输入框样式。
- `src/assets/pet/`：桌宠 PNG 素材。
- `src-tauri/src/lib.rs`：Tauri 命令、窗口控制、LLM 后端、交互历史持久化和全局快捷键。
- `src-tauri/tauri.conf.json`：Tauri 应用配置。
