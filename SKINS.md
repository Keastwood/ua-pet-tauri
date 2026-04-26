# 助手皮肤

应用现在通过 `src/skins.ts` 统一注册皮肤。默认皮肤是 `银白半身 UA`，生成器生成的皮肤会写入 `src/assets/skins/<skin-id>/`，并自动刷新 `src/generated/skins.ts`。

## 一键生成

### 在桌宠 UI 中添加

打开桌宠后，在主界面的“助手皮肤”区域点击 `选择图片并添加`，选择图片即可生成并切换到新皮肤。这里生成的皮肤会保存到 Tauri 应用数据目录，不会写入仓库，也不会进 git。

UI 选项：

- `新皮肤名`：可留空，留空时使用图片文件名。
- `半身绑定 / 全身立绘`：决定点击部位映射用哪套规则。
- `边缘背景透明`：默认开启，会把与图片边缘连通的背景色透明化。

### 命令行生成

把图片放到任意位置后运行：

```powershell
npm run skin:generate -- --image "E:\path\to\your-image.png" --id my-skin --name "我的皮肤" --layout fullBody
```

常用参数：

- `--image`：源图片路径，支持 PNG/JPEG/WebP 等 `sharp` 能读取的格式。
- `--id`：皮肤 ID，只能用小写字母、数字和连字符。
- `--name`：界面上显示的皮肤名。
- `--layout`：部位映射预设，`halfBody` 是当前半身绑定，`fullBody` 是全身立绘绑定。
- `--keep-background`：保留原图背景；默认会把边缘连通的背景色透明化。
- `--tolerance 34`：背景透明化容差，背景残留时可调大，误删角色边缘时可调小。

生成后重新构建或启动应用，皮肤会出现在主界面的“助手皮肤”切换区。

## 文件结构

每个生成皮肤包含：

- `idle.png`：默认表情。
- `surprised.png`：惊讶表情，简单生成时先复用默认图。
- `blink_overlay.png`：眨眼覆盖层，简单生成时为空透明图。
- `mouth_talk_overlay.png`：说话口型覆盖层，简单生成时为空透明图。
- `mouth_o_overlay.png`：另一帧口型覆盖层，简单生成时为空透明图。
- `manifest.json`：皮肤 ID、名称、原图尺寸、部位映射预设和素材路径。

简单生成的动态主要依赖应用里的漂浮、弹跳、气泡和口型帧切换。以后如果要更精细，可以直接替换 overlay PNG，保持文件名和尺寸一致即可。

## 当前测试皮肤

`npm run skin:generate:heart` 会使用仓库上级目录的 `爱心眼ua.png` 生成测试皮肤：

```powershell
npm run skin:generate:heart
```

该测试皮肤使用 `fullBody` 部位映射，覆盖脸、眼睛、嘴巴、脖子、胸口、手臂、双手、腹部、腰部、胯部和大腿等区域。
