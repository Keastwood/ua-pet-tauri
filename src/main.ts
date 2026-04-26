import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import idleBase from "./assets/pet/full_idle_smile.png";
import surpriseBase from "./assets/pet/full_surprised_original.png";
import blinkOverlay from "./assets/pet/eyes_blink_overlay.png";
import mouthTalkOverlay from "./assets/pet/mouth_talk_overlay.png";
import mouthOOverlay from "./assets/pet/mouth_o_overlay.png";

type Tone = "warm" | "alert" | "hint";
type BaseExpression = "idle" | "surprised";
type InteractionToolId = "finger" | "palm" | "mouth" | "foot" | "feather" | "comb" | "snack";

interface PetState {
  affection: number;
  alwaysOnTop: boolean;
  llmInteractionMode: boolean;
  selectedInteractionTool: InteractionToolId;
  talking: boolean;
  surprised: boolean;
  scale: number;
  dockedToCorner: boolean;
  sceneMode: boolean;
  bubbleTimeout?: number;
  blinkTimeout?: number;
  blinkHideTimeout?: number;
  talkInterval?: number;
  surpriseTimeout?: number;
  idleChatterInterval?: number;
}

interface ApplyScaleOptions {
  persist?: boolean;
  showBubble?: boolean;
  ensureDocked?: boolean;
}

interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LlmChatResponse {
  content: string;
  model: string;
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

interface LlmConfigView {
  hasApiKey: boolean;
  maskedApiKey?: string;
  baseUrl: string;
  model: string;
  timeoutSecs: number;
  petInteractionSystemPrompt: string;
  defaultPetInteractionSystemPrompt: string;
}

interface InteractionRecord {
  id: number;
  timestampMs: number;
  source: string;
  interactionTool?: string | null;
  area?: string | null;
  xPercent?: number | null;
  yPercent?: number | null;
  userText?: string | null;
  assistantText?: string | null;
  llmUsed: boolean;
}

interface PetInteractionResponse {
  content: string;
  record: InteractionRecord;
}

interface PetInteractionStreamEvent {
  streamId: string;
  phase: "delta" | "done";
  delta?: string | null;
  content?: string | null;
  record?: InteractionRecord | null;
  error?: string | null;
}

interface PetPointerPosition {
  xPercent?: number;
  yPercent?: number;
}

interface PetHitAreaRule {
  label: string;
  shape: "rect" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
}

interface InteractionTool {
  id: InteractionToolId;
  label: string;
  verb: string;
}

const BASE_WINDOW_WIDTH = 430;
const BASE_WINDOW_HEIGHT = 1080;
const PET_ASSET_WIDTH = 1170;
const PET_ASSET_HEIGHT = 2532;
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.35;
const SCALE_STEP = 0.05;
const SCALE_STORAGE_KEY = "silver-pet.scale.v2";
const SCENE_MODE_STORAGE_KEY = "silver-pet.scene-mode.v1";
const LLM_INTERACTION_MODE_STORAGE_KEY = "silver-pet.llm-interaction-mode.v1";
const INTERACTION_TOOL_STORAGE_KEY = "silver-pet.interaction-tool.v1";
const PET_LLM_SYSTEM_PROMPT =
  "你是一个银白发桌宠，会陪用户工作和休息。请用中文回复，语气温柔、俏皮、像桌宠在说话。每次只说一句，控制在 36 个汉字以内，不要解释，不要加引号。";

const INTERACTION_TOOLS: InteractionTool[] = [
  { id: "finger", label: "手指", verb: "轻点" },
  { id: "palm", label: "手掌", verb: "轻拍" },
  { id: "mouth", label: "嘴", verb: "亲近" },
  { id: "foot", label: "脚", verb: "轻踢" },
  { id: "feather", label: "羽毛", verb: "轻挠" },
  { id: "comb", label: "梳子", verb: "梳理" },
  { id: "snack", label: "零食", verb: "投喂" },
];

const PET_HIT_AREA_RULES: PetHitAreaRule[] = [
  { label: "嘴巴", shape: "ellipse", x: 43.5, y: 47.2, width: 14, height: 5.4 },
  { label: "鼻尖", shape: "ellipse", x: 47.7, y: 43.7, width: 5.4, height: 5.8 },
  { label: "左脸颊", shape: "ellipse", x: 27.5, y: 42.2, width: 16, height: 10.5 },
  { label: "右脸颊", shape: "ellipse", x: 56.5, y: 42.2, width: 16, height: 10.5 },
  { label: "左眼", shape: "ellipse", x: 29.2, y: 36.2, width: 17.4, height: 7.2 },
  { label: "右眼", shape: "ellipse", x: 53.8, y: 36.2, width: 17.4, height: 7.2 },
  { label: "眼镜", shape: "rect", x: 27, y: 34.8, width: 47, height: 12.8 },
  { label: "脸", shape: "ellipse", x: 28.5, y: 31.2, width: 43, height: 26 },
  { label: "呆毛", shape: "ellipse", x: 44.8, y: 8.4, width: 12.8, height: 14.8 },
  { label: "头顶", shape: "ellipse", x: 27, y: 17, width: 46, height: 17 },
  { label: "刘海", shape: "rect", x: 31, y: 27.6, width: 37, height: 9.8 },
  { label: "右侧发饰", shape: "rect", x: 70.5, y: 21.5, width: 17.5, height: 16.5 },
  { label: "耳朵", shape: "ellipse", x: 72, y: 39.5, width: 10.5, height: 11.8 },
  { label: "左侧头发", shape: "rect", x: 6, y: 31, width: 22, height: 43 },
  { label: "右侧头发", shape: "rect", x: 74, y: 31, width: 20, height: 47 },
  { label: "脖子", shape: "rect", x: 38, y: 57.8, width: 24, height: 7.4 },
  { label: "左肩", shape: "rect", x: 18, y: 62, width: 20, height: 8.5 },
  { label: "右肩", shape: "rect", x: 62, y: 62, width: 20, height: 8.5 },
  { label: "锁骨", shape: "rect", x: 34, y: 62, width: 32, height: 7.8 },
  { label: "胸口", shape: "ellipse", x: 30, y: 65.5, width: 40, height: 14 },
  { label: "左胸", shape: "ellipse", x: 11, y: 72.5, width: 18, height: 9 },
  { label: "腹部", shape: "rect", x: 28, y: 76, width: 44, height: 12 },
  { label: "腰部", shape: "rect", x: 20, y: 88, width: 60, height: 7.5 },
  { label: "左手臂", shape: "rect", x: 0, y: 64, width: 25, height: 34 },
  { label: "右手臂", shape: "rect", x: 75, y: 64, width: 25, height: 34 },
  { label: "左手", shape: "rect", x: 0, y: 95, width: 18, height: 5 },
  { label: "右手", shape: "rect", x: 82, y: 95, width: 18, height: 5 },
  { label: "头发", shape: "rect", x: 0, y: 18, width: 100, height: 40 },
];

const state: PetState = {
  affection: 0,
  alwaysOnTop: true,
  llmInteractionMode: false,
  selectedInteractionTool: "finger",
  talking: false,
  surprised: false,
  scale: 1,
  dockedToCorner: true,
  sceneMode: false,
};

const headLines = [
  "摸头会让我心情变好一点。",
  "今天也要一起认真工作。",
  "发型别弄乱呀，不过还是谢谢你。",
  "被照顾到啦，我会更努力陪你。",
];

const bodyLines = [
  "诶，戳到毛衣啦。",
  "我在这里，有什么想做的？",
  "需要我陪你发会儿呆吗？",
  "轻一点，我会害羞的。",
];

const surpriseLines = [
  "呀，突然一下吓到我了。",
  "等等，我还没准备好。",
  "被你抓到走神现场了。",
];

const chatLines = [
  "我会在桌面边上安静陪着你。",
  "累了就摸摸我，我会提醒你休息。",
  "这套桌宠素材已经顺利接进程序了。",
  "你继续忙，我负责在旁边营业。",
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function getInteractionTool(id: string | null | undefined): InteractionTool {
  return INTERACTION_TOOLS.find((tool) => tool.id === id) ?? INTERACTION_TOOLS[0];
}

function must<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error("Missing element: " + selector);
  }
  return element;
}

function clearTimer(timer: number | undefined): void {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    window.clearInterval(timer);
  }
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return 1;
  }
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale.toFixed(2))));
}

function getWindowSizeForScale(scale: number): { width: number; height: number } {
  return {
    width: Math.round(BASE_WINDOW_WIDTH * scale),
    height: Math.round(BASE_WINDOW_HEIGHT * scale),
  };
}

function setCssScale(scale: number): void {
  document.documentElement.style.setProperty("--app-scale", String(scale));
}

async function movePetWindow(x: number, y: number): Promise<void> {
  await invoke("move_pet_window", { x, y });
}

async function resizePetWindow(width: number, height: number): Promise<void> {
  await invoke("resize_pet_window", { width, height });
}

async function setAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
  await invoke("set_pet_always_on_top", { alwaysOnTop });
}

async function closePet(): Promise<void> {
  await invoke("close_pet");
}

async function startPetDrag(): Promise<void> {
  await invoke("start_pet_drag");
}

async function moveWindowToDesktopCorner(scale = state.scale): Promise<void> {
  const marginX = 28;
  const marginY = 54;
  const { width, height } = getWindowSizeForScale(scale);
  const x = Math.max(0, window.screen.availWidth - width - marginX);
  const y = Math.max(0, window.screen.availHeight - height - marginY);
  await movePetWindow(x, y);
}

window.addEventListener("DOMContentLoaded", () => {
  const petRoot = must<HTMLDivElement>("#pet");
  const petStage = must<HTMLDivElement>("#pet-stage");
  const petFrame = must<HTMLDivElement>("#pet-frame");
  const bubble = must<HTMLDivElement>("#bubble");
  const settingsPanel = must<HTMLElement>("#settings-panel");
  const historyPanel = must<HTMLElement>("#history-panel");
  const historyList = must<HTMLDivElement>("#history-list");
  const historyCloseButton = must<HTMLButtonElement>("#history-close-btn");
  const historyClearButton = must<HTMLButtonElement>("#history-clear-btn");
  const historyRefreshButton = must<HTMLButtonElement>("#history-refresh-btn");
  const floatingInput = must<HTMLFormElement>("#floating-input");
  const floatingTextInput = must<HTMLInputElement>("#floating-text-input");
  const floatingInputHint = must<HTMLParagraphElement>("#floating-input-hint");
  const settingsForm = must<HTMLFormElement>("#llm-settings-form");
  const settingsStatus = must<HTMLParagraphElement>("#settings-status");
  const settingsCloseButton = must<HTMLButtonElement>("#settings-close-btn");
  const settingsSaveButton = must<HTMLButtonElement>("#settings-save-btn");
  const settingsTestButton = must<HTMLButtonElement>("#settings-test-btn");
  const llmApiKeyInput = must<HTMLInputElement>("#llm-api-key-input");
  const llmBaseUrlInput = must<HTMLInputElement>("#llm-base-url-input");
  const llmModelInput = must<HTMLInputElement>("#llm-model-input");
  const llmTimeoutInput = must<HTMLInputElement>("#llm-timeout-input");
  const llmSystemPromptInput = must<HTMLTextAreaElement>("#llm-system-prompt-input");
  const llmClearKeyInput = must<HTMLInputElement>("#llm-clear-key-input");
  const affectionValue = must<HTMLSpanElement>("#affection-value");
  const moodValue = must<HTMLSpanElement>("#mood-value");
  const scaleValue = must<HTMLSpanElement>("#scale-value");
  const pinButton = must<HTMLButtonElement>("#pin-btn");
  const snapButton = must<HTMLButtonElement>("#snap-btn");
  const chatButton = must<HTMLButtonElement>("#chat-btn");
  const scaleDownButton = must<HTMLButtonElement>("#scale-down-btn");
  const scaleUpButton = must<HTMLButtonElement>("#scale-up-btn");
  const sceneButton = must<HTMLButtonElement>("#scene-btn");
  const llmModeButton = must<HTMLButtonElement>("#llm-mode-btn");
  const historyButton = must<HTMLButtonElement>("#history-btn");
  const closeButton = must<HTMLButtonElement>("#close-btn");
  const dragHandle = must<HTMLButtonElement>("#drag-handle");
  const interactionToolValue = must<HTMLElement>("#interaction-tool-value");
  const interactionToolButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".interaction-tool-btn[data-tool]"),
  );
  const fxLayer = must<HTMLDivElement>("#fx-layer");
  const baseLayer = must<HTMLImageElement>("#base-layer");
  const blinkLayer = must<HTMLImageElement>("#blink-layer");
  const talkLayer = must<HTMLImageElement>("#talk-layer");
  const mouthOLayer = must<HTMLImageElement>("#mouth-o-layer");
  let llmRequestId = 0;

  baseLayer.src = idleBase;
  blinkLayer.src = blinkOverlay;
  talkLayer.src = mouthTalkOverlay;
  mouthOLayer.src = mouthOOverlay;

  const expressionSrc: Record<BaseExpression, string> = {
    idle: idleBase,
    surprised: surpriseBase,
  };

  for (const src of Object.values(expressionSrc)) {
    const image = new Image();
    image.src = src;
  }

  function setBaseExpression(expression: BaseExpression): void {
    baseLayer.src = expressionSrc[expression];
    baseLayer.dataset.expression = expression;
  }

  function updateStatus(): void {
    affectionValue.textContent = String(state.affection).padStart(2, "0");
    scaleValue.textContent = `${Math.round(state.scale * 100)}%`;

    if (state.surprised) {
      moodValue.textContent = "受惊";
    } else if (state.talking) {
      moodValue.textContent = "聊天";
    } else {
      moodValue.textContent = "待机";
    }

    pinButton.textContent = state.alwaysOnTop ? "取消置顶" : "重新置顶";
    pinButton.setAttribute("aria-pressed", String(state.alwaysOnTop));
    sceneButton.textContent = state.sceneMode ? "透明" : "背景";
    sceneButton.setAttribute("aria-pressed", String(state.sceneMode));
    llmModeButton.textContent = state.llmInteractionMode ? "LLM" : "本地";
    llmModeButton.setAttribute("aria-pressed", String(state.llmInteractionMode));

    const selectedTool = getInteractionTool(state.selectedInteractionTool);
    interactionToolValue.textContent = selectedTool.label;
    for (const button of interactionToolButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.tool === selectedTool.id));
    }
  }

  function setSceneMode(enabled: boolean, options: { persist?: boolean; announce?: boolean } = {}): void {
    state.sceneMode = enabled;
    petFrame.dataset.scene = enabled ? "framed" : "transparent";

    if (options.persist ?? true) {
      localStorage.setItem(SCENE_MODE_STORAGE_KEY, enabled ? "1" : "0");
    }

    updateStatus();

    if (options.announce) {
      setBubble(enabled ? "背景模式已开启，今天营业得更有橱窗感。" : "已切回透明模式，继续轻盈地待在桌面上。", "hint", 1900);
    }
  }

  function setLlmInteractionMode(enabled: boolean, options: { persist?: boolean; announce?: boolean } = {}): void {
    state.llmInteractionMode = enabled;

    if (options.persist ?? true) {
      localStorage.setItem(LLM_INTERACTION_MODE_STORAGE_KEY, enabled ? "1" : "0");
    }

    updateStatus();

    if (options.announce) {
      setBubble(
        enabled ? "LLM 交互模式已开启，我会记住你的点击和对话。" : "已切回本地互动模式，轻装营业。",
        "hint",
        2100,
      );
    }
  }

  function setInteractionTool(toolId: string | null | undefined, options: { persist?: boolean; announce?: boolean } = {}): void {
    const tool = getInteractionTool(toolId);
    state.selectedInteractionTool = tool.id;

    if (options.persist ?? true) {
      localStorage.setItem(INTERACTION_TOOL_STORAGE_KEY, tool.id);
    }

    updateStatus();

    if (options.announce) {
      setBubble(`已切换为${tool.label}，接下来会用它${tool.verb}桌宠。`, "hint", 1700);
    }
  }

  function setBubble(text: string, tone: Tone = "warm", duration = 2200): void {
    clearTimer(state.bubbleTimeout);
    bubble.dataset.show = "true";
    bubble.dataset.tone = tone;
    bubble.textContent = text;
    state.bubbleTimeout = window.setTimeout(() => {
      bubble.dataset.show = "false";
    }, duration);
  }

  function getMoodLabel(): string {
    if (state.surprised) {
      return "受惊";
    }

    if (state.talking) {
      return "聊天";
    }

    return "待机";
  }

  function normalizeLlmReply(content: string): string {
    const normalized = content
      .replace(/\s+/g, " ")
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();

    return Array.from(normalized).slice(0, 90).join("");
  }

  function buildPetChatMessages(): LlmMessage[] {
    return [
      {
        role: "system",
        content: PET_LLM_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: `用户点击了桌宠聊天按钮。当前亲密度：${state.affection}；当前状态：${getMoodLabel()}；背景模式：${state.sceneMode ? "开启" : "关闭"}。请生成一句新的桌宠回应。`,
      },
    ];
  }

  async function requestLlmPetLine(): Promise<string | null> {
    try {
      const response = await invoke<LlmChatResponse>("llm_chat", {
        request: {
          messages: buildPetChatMessages(),
          temperature: 0.82,
          maxTokens: 80,
        },
      });
      const reply = normalizeLlmReply(response.content);
      return reply.length > 0 ? reply : null;
    } catch (error) {
      console.warn("LLM chat fallback:", error);
      const message = String(error);
      if (message.includes("API Key") || message.includes("模型") || message.includes("设置页")) {
        return "右键我打开设置页，填好 API 后我就能接入外脑啦。";
      }

      return null;
    }
  }

  function setSettingsStatus(text: string, tone: Tone | "idle" = "idle"): void {
    settingsStatus.textContent = text;
    settingsStatus.dataset.tone = tone;
  }

  function setSettingsBusy(busy: boolean): void {
    settingsSaveButton.disabled = busy;
    settingsTestButton.disabled = busy;
    settingsCloseButton.disabled = busy;
  }

  function applyLlmConfig(config: LlmConfigView): void {
    llmApiKeyInput.value = "";
    llmApiKeyInput.placeholder = config.hasApiKey
      ? `已保存：${config.maskedApiKey ?? "••••"}（留空则保留）`
      : "粘贴你的 API Key";
    llmBaseUrlInput.value = config.baseUrl || "https://api.openai.com/v1";
    llmModelInput.value = config.model;
    llmTimeoutInput.value = String(config.timeoutSecs || 45);
    llmSystemPromptInput.value = config.petInteractionSystemPrompt ?? "";
    llmSystemPromptInput.placeholder = config.defaultPetInteractionSystemPrompt || "留空使用默认桌宠交互提示词";
    llmClearKeyInput.checked = false;
  }

  async function loadLlmSettings(): Promise<void> {
    setSettingsStatus("正在读取配置...", "idle");

    try {
      const config = await invoke<LlmConfigView>("get_llm_config");
      applyLlmConfig(config);
      setSettingsStatus(config.hasApiKey ? "已读取配置，API Key 只显示掩码。" : "还没有保存 API Key。", "idle");
    } catch (error) {
      console.error(error);
      setSettingsStatus(`读取配置失败：${String(error)}`, "alert");
    }
  }

  function openSettings(): void {
    settingsPanel.hidden = false;
    settingsPanel.dataset.show = "true";
    void loadLlmSettings();
  }

  function closeSettings(): void {
    settingsPanel.dataset.show = "false";
    window.setTimeout(() => {
      if (settingsPanel.dataset.show !== "true") {
        settingsPanel.hidden = true;
      }
    }, 180);
  }

  function clampTimeoutSeconds(value: number): number {
    if (!Number.isFinite(value)) {
      return 45;
    }

    return Math.min(300, Math.max(5, Math.round(value)));
  }

  async function saveLlmSettings(announce = true): Promise<LlmConfigView | null> {
    setSettingsBusy(true);
    setSettingsStatus("正在保存配置...", "idle");

    try {
      const apiKey = llmApiKeyInput.value.trim();
      const config = await invoke<LlmConfigView>("save_llm_config", {
        request: {
          apiKey: apiKey.length > 0 ? apiKey : null,
          clearApiKey: llmClearKeyInput.checked,
          baseUrl: llmBaseUrlInput.value.trim(),
          model: llmModelInput.value.trim(),
          timeoutSecs: clampTimeoutSeconds(Number(llmTimeoutInput.value)),
          petInteractionSystemPrompt: llmSystemPromptInput.value.trim() || null,
        },
      });

      applyLlmConfig(config);
      setSettingsStatus("配置已保存，下一次聊天会直接使用。", "warm");

      if (announce) {
        setBubble("LLM 设置已保存，我可以开始接入外脑啦。", "hint", 1800);
      }

      return config;
    } catch (error) {
      console.error(error);
      setSettingsStatus(`保存失败：${String(error)}`, "alert");
      return null;
    } finally {
      setSettingsBusy(false);
    }
  }

  async function testLlmSettings(): Promise<void> {
    const config = await saveLlmSettings(false);
    if (!config) {
      return;
    }

    setSettingsBusy(true);
    setSettingsStatus("正在测试连接...", "idle");

    try {
      const response = await invoke<LlmChatResponse>("llm_chat", {
        request: {
          messages: [
            {
              role: "system",
              content: PET_LLM_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: "请用一句话确认你已经成功接入桌宠。",
            },
          ],
          temperature: 0.6,
          maxTokens: 60,
        },
      });
      const reply = normalizeLlmReply(response.content);
      setSettingsStatus(`连接成功：${reply}`, "warm");
      startTalking(reply, 2300);
    } catch (error) {
      console.error(error);
      setSettingsStatus(`测试失败：${String(error)}`, "alert");
    } finally {
      setSettingsBusy(false);
    }
  }

  function getPetPointerPosition(event?: MouseEvent): PetPointerPosition {
    if (!event) {
      return {};
    }

    const petRect = petRoot.getBoundingClientRect();
    const renderedImageWidth = petRect.width;
    const renderedImageHeight = renderedImageWidth * (PET_ASSET_HEIGHT / PET_ASSET_WIDTH);
    const imageLeft = petRect.left;
    const imageTop = petRect.bottom - renderedImageHeight;

    const xPercent = Math.min(100, Math.max(0, ((event.clientX - imageLeft) / renderedImageWidth) * 100));
    const yPercent = Math.min(100, Math.max(0, ((event.clientY - imageTop) / renderedImageHeight) * 100));
    return {
      xPercent: Number(xPercent.toFixed(1)),
      yPercent: Number(yPercent.toFixed(1)),
    };
  }

  function isPointInHitRule(position: PetPointerPosition, rule: PetHitAreaRule): boolean {
    if (position.xPercent === undefined || position.yPercent === undefined) {
      return false;
    }

    const x = position.xPercent;
    const y = position.yPercent;

    if (rule.shape === "rect") {
      return x >= rule.x && x <= rule.x + rule.width && y >= rule.y && y <= rule.y + rule.height;
    }

    const radiusX = rule.width / 2;
    const radiusY = rule.height / 2;
    const centerX = rule.x + radiusX;
    const centerY = rule.y + radiusY;
    const normalizedX = (x - centerX) / radiusX;
    const normalizedY = (y - centerY) / radiusY;
    return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
  }

  function resolvePetHitArea(event: MouseEvent | undefined, fallback: string): string {
    const position = getPetPointerPosition(event);
    const matchedRule = PET_HIT_AREA_RULES.find((rule) => isPointInHitRule(position, rule));
    return matchedRule?.label ?? fallback;
  }

  function getAreaLabel(area?: string | null): string {
    if (area === "head") {
      return "头部";
    }

    if (area === "body") {
      return "身体";
    }

    if (area === "chat") {
      return "聊天按钮";
    }

    return area?.trim() || "文本";
  }

  function getSourceLabel(source?: string | null): string {
    if (source === "click") {
      return "点击互动";
    }

    if (source === "shortcut") {
      return "快捷输入";
    }

    if (source === "button") {
      return "按钮互动";
    }

    return source ?? "未知来源";
  }

  function formatRecordTime(timestampMs: number): string {
    if (!Number.isFinite(timestampMs)) {
      return "未知时间";
    }

    const date = new Date(timestampMs);
    if (Number.isNaN(date.getTime())) {
      return "未知时间";
    }

    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function renderHistory(records: InteractionRecord[]): void {
    historyList.replaceChildren();

    if (records.length === 0) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "还没有交互历史。开启 LLM 模式后点击我，或者用快捷输入框和我说话。";
      historyList.appendChild(empty);
      return;
    }

    for (const record of [...records].reverse()) {
      const item = document.createElement("article");
      item.className = "history-item";

      const meta = document.createElement("div");
      meta.className = "history-meta";
      const areaLabel = getAreaLabel(record.area);
      const interactionTool = record.interactionTool?.trim();
      const details = [
        getSourceLabel(record.source),
        interactionTool ? `${interactionTool} -> ${areaLabel}` : areaLabel,
      ];
      const xPercent = record.xPercent;
      const yPercent = record.yPercent;
      if (
        typeof xPercent === "number" &&
        Number.isFinite(xPercent) &&
        typeof yPercent === "number" &&
        Number.isFinite(yPercent)
      ) {
        details.push(`${xPercent.toFixed(1)}%, ${yPercent.toFixed(1)}%`);
      }
      details.push(record.llmUsed ? "LLM" : "本地");
      meta.textContent = `${formatRecordTime(record.timestampMs)} · ${details.join(" · ")}`;

      const assistant = document.createElement("p");
      assistant.className = "history-assistant";
      assistant.textContent = record.assistantText?.trim() || "（没有记录到回应）";

      item.append(meta);

      const userText = record.userText?.trim();
      if (userText) {
        const user = document.createElement("p");
        user.className = "history-user";
        user.textContent = userText;
        item.append(user);
      }

      item.append(assistant);
      historyList.appendChild(item);
    }
  }

  async function refreshHistory(): Promise<void> {
    try {
      const records = await invoke<InteractionRecord[]>("get_interaction_history", { limit: 120 });
      renderHistory(records);
    } catch (error) {
      console.error(error);
      historyList.replaceChildren();
      const failed = document.createElement("p");
      failed.className = "history-empty";
      failed.textContent = `读取历史失败：${String(error)}`;
      historyList.appendChild(failed);
    }
  }

  function openHistory(): void {
    historyPanel.hidden = false;
    historyPanel.dataset.show = "true";
    void refreshHistory();
  }

  function closeHistory(): void {
    historyPanel.dataset.show = "false";
    window.setTimeout(() => {
      if (historyPanel.dataset.show !== "true") {
        historyPanel.hidden = true;
      }
    }, 180);
  }

  async function clearHistory(): Promise<void> {
    try {
      await invoke("clear_interaction_history");
      renderHistory([]);
      setBubble("交互历史已清空，新的故事从这里开始。", "hint", 1800);
    } catch (error) {
      console.error(error);
      setBubble("清空历史失败了，稍后再试一次。", "alert", 2200);
    }
  }

  function openFloatingInput(): void {
    floatingInput.hidden = false;
    floatingInput.dataset.show = "true";
    floatingInputHint.textContent = "Enter 发送，Esc 收起。";
    window.setTimeout(() => {
      floatingTextInput.focus();
      floatingTextInput.select();
    }, 0);
  }

  function closeFloatingInput(): void {
    floatingInput.dataset.show = "false";
    window.setTimeout(() => {
      if (floatingInput.dataset.show !== "true") {
        floatingInput.hidden = true;
      }
    }, 180);
  }

  function startThinkingDots(requestId: number): void {
    clearTimer(state.bubbleTimeout);
    let dotCount = 1;
    bubble.dataset.show = "true";
    bubble.dataset.tone = "warm";
    bubble.textContent = "·";

    state.bubbleTimeout = window.setInterval(() => {
      if (requestId !== llmRequestId) {
        clearTimer(state.bubbleTimeout);
        return;
      }

      dotCount = dotCount >= 6 ? 1 : dotCount + 1;
      bubble.textContent = "·".repeat(dotCount);
    }, 180);
  }

  function startStreamingTalking(text: string): void {
    clearTimer(state.surpriseTimeout);
    clearTimer(state.talkInterval);
    clearTimer(state.bubbleTimeout);
    state.surprised = false;
    state.talking = true;
    setBaseExpression("idle");
    blinkLayer.hidden = true;
    mouthOLayer.hidden = true;

    let flip = false;
    talkLayer.hidden = false;
    state.talkInterval = window.setInterval(() => {
      flip = !flip;
      talkLayer.hidden = !flip;
      mouthOLayer.hidden = flip;
    }, 120);

    bubble.dataset.show = "true";
    bubble.dataset.tone = "warm";
    bubble.textContent = text || "·";
    updateStatus();
  }

  function updateStreamingTalking(text: string): void {
    bubble.dataset.show = "true";
    bubble.dataset.tone = "warm";
    bubble.textContent = text || "·";
  }

  function finishStreamingTalking(duration = 2400): void {
    clearTimer(state.bubbleTimeout);
    clearTimer(state.surpriseTimeout);

    state.bubbleTimeout = window.setTimeout(() => {
      bubble.dataset.show = "false";
    }, duration + 400);

    state.surpriseTimeout = window.setTimeout(() => {
      resetFaceLayers();
    }, duration);
  }

  async function runLlmInteraction(
    source: string,
    area?: string,
    event?: MouseEvent,
    userText?: string,
  ): Promise<void> {
    const requestId = ++llmRequestId;
    const { xPercent, yPercent } = getPetPointerPosition(event);
    const selectedTool = getInteractionTool(state.selectedInteractionTool);
    const interactionTool = source === "click" ? selectedTool.label : null;
    const streamId = `${Date.now()}-${requestId}`;
    let streamedContent = "";
    let hasStreamed = false;
    const unlisten = await listen<PetInteractionStreamEvent>("pet-interaction-stream", (event) => {
      const payload = event.payload;
      if (payload.streamId !== streamId || requestId !== llmRequestId) {
        return;
      }

      if (payload.phase === "delta" && payload.delta) {
        if (!hasStreamed) {
          hasStreamed = true;
          startStreamingTalking("");
        }

        streamedContent += payload.delta;
        updateStreamingTalking(Array.from(streamedContent.replace(/\s+/g, " ")).slice(0, 90).join(""));
      }
    });

    startThinkingDots(requestId);

    try {
      const response = await invoke<PetInteractionResponse>("llm_pet_interact_stream", {
        streamId,
        request: {
          source,
          interactionTool,
          area: area ?? null,
          xPercent: xPercent ?? null,
          yPercent: yPercent ?? null,
          userText: userText?.trim() || null,
          affection: state.affection,
          mood: getMoodLabel(),
          sceneMode: state.sceneMode,
        },
      });

      if (requestId !== llmRequestId) {
        return;
      }

      const reply = normalizeLlmReply(response.content);
      if (!hasStreamed) {
        startStreamingTalking(reply);
      } else {
        updateStreamingTalking(reply);
      }
      finishStreamingTalking(response.record.llmUsed ? 2400 : 2600);

      if (!historyPanel.hidden) {
        void refreshHistory();
      }
    } catch (error) {
      console.error(error);
      if (requestId === llmRequestId) {
        startTalking("这次互动记录失败了，我先把反应留在心里。", 2200);
      }
    } finally {
      unlisten();
    }
  }

  async function submitFloatingInput(): Promise<void> {
    const text = floatingTextInput.value.trim();
    if (!text) {
      floatingInputHint.textContent = "先输入一句想对我说的话。";
      return;
    }

    floatingTextInput.value = "";
    closeFloatingInput();
    await runLlmInteraction("shortcut", "悬浮输入框", undefined, text);
  }

  async function applyScale(nextScale: number, options: ApplyScaleOptions = {}): Promise<void> {
    const persist = options.persist ?? true;
    const showBubble = options.showBubble ?? true;
    const ensureDocked = options.ensureDocked ?? false;
    const normalizedScale = clampScale(nextScale);
    const scaleChanged = normalizedScale !== state.scale;

    state.scale = normalizedScale;
    setCssScale(normalizedScale);
    updateStatus();

    if (persist) {
      localStorage.setItem(SCALE_STORAGE_KEY, String(normalizedScale));
    }

    const { width, height } = getWindowSizeForScale(normalizedScale);

    try {
      if (scaleChanged) {
        await resizePetWindow(width, height);
      }

      if (state.dockedToCorner || ensureDocked) {
        state.dockedToCorner = true;
        await moveWindowToDesktopCorner(normalizedScale);
      }

      if (showBubble) {
        setBubble(`现在是 ${Math.round(normalizedScale * 100)}% 大小。`, "hint", 1100);
      }
    } catch (error) {
      console.error(error);
      setBubble("缩放失败了，稍后再试一次。", "alert", 2200);
    }
  }

  function resetFaceLayers(): void {
    blinkLayer.hidden = true;
    talkLayer.hidden = true;
    mouthOLayer.hidden = true;
    state.talking = false;
    state.surprised = false;
    setBaseExpression("idle");
    clearTimer(state.talkInterval);
    clearTimer(state.surpriseTimeout);
    updateStatus();
  }

  function burst(icon: string, x: number, y: number): void {
    const sparkle = document.createElement("span");
    sparkle.className = "float-emoji";
    sparkle.textContent = icon;
    sparkle.style.left = `${x}%`;
    sparkle.style.top = `${y}%`;
    fxLayer.appendChild(sparkle);
    window.setTimeout(() => sparkle.remove(), 920);
  }

  function blinkOnce(): void {
    if (state.surprised) {
      return;
    }

    clearTimer(state.blinkHideTimeout);
    blinkLayer.hidden = false;
    state.blinkHideTimeout = window.setTimeout(() => {
      blinkLayer.hidden = true;
    }, 160);
  }

  function scheduleBlink(): void {
    clearTimer(state.blinkTimeout);
    const delay = 3400 + Math.random() * 2600;
    state.blinkTimeout = window.setTimeout(() => {
      blinkOnce();
      scheduleBlink();
    }, delay);
  }

  function startTalking(text: string, duration = 1800): void {
    clearTimer(state.surpriseTimeout);
    clearTimer(state.talkInterval);
    state.surprised = false;
    state.talking = true;
    setBaseExpression("idle");

    let flip = false;
    talkLayer.hidden = false;
    mouthOLayer.hidden = true;

    state.talkInterval = window.setInterval(() => {
      flip = !flip;
      talkLayer.hidden = !flip;
      mouthOLayer.hidden = flip;
    }, 120);

    setBubble(text, "warm", duration + 400);
    updateStatus();

    state.surpriseTimeout = window.setTimeout(() => {
      resetFaceLayers();
    }, duration);
  }

  async function startSmartChat(): Promise<void> {
    const requestId = ++llmRequestId;
    startTalking("我想想，给你现场编一句。", 1200);

    const reply = await requestLlmPetLine();
    if (requestId !== llmRequestId) {
      return;
    }

    startTalking(reply ?? pick(chatLines), reply ? 2300 : 2000);
  }

  function startSurprise(text: string, duration = 950): void {
    clearTimer(state.talkInterval);
    clearTimer(state.surpriseTimeout);
    state.talking = false;
    state.surprised = true;
    talkLayer.hidden = true;
    mouthOLayer.hidden = true;
    blinkLayer.hidden = true;
    setBaseExpression("surprised");
    setBubble(text, "alert", duration + 500);
    updateStatus();

    state.surpriseTimeout = window.setTimeout(() => {
      resetFaceLayers();
    }, duration);
  }

  function reactToHead(event?: MouseEvent): void {
    state.affection += 1;
    petRoot.classList.remove("pet-pop");
    void petRoot.offsetWidth;
    petRoot.classList.add("pet-pop");
    burst("*", 46, 18);

    if (state.llmInteractionMode) {
      void runLlmInteraction("click", resolvePetHitArea(event, "头部"), event);
      updateStatus();
      return;
    }

    if (state.affection % 5 === 0) {
      startSurprise("头顶是重点保护区，不准偷袭。");
    } else {
      startTalking(pick(headLines), 1700);
    }

    updateStatus();
  }

  function reactToBody(event?: MouseEvent): void {
    state.affection += 2;
    petRoot.classList.remove("pet-pop");
    void petRoot.offsetWidth;
    petRoot.classList.add("pet-pop");
    burst("+", 52, 38);

    if (state.llmInteractionMode) {
      void runLlmInteraction("click", resolvePetHitArea(event, "身体"), event);
      updateStatus();
      return;
    }

    if (Math.random() > 0.55) {
      startSurprise(pick(surpriseLines));
    } else {
      startTalking(pick(bodyLines), 1600);
    }

    updateStatus();
  }

  async function safeMoveWindow(): Promise<void> {
    try {
      state.dockedToCorner = true;
      await moveWindowToDesktopCorner();
      setBubble("已经帮你回到桌面右下角。", "hint", 1700);
    } catch (error) {
      console.error(error);
      setBubble("归位失败了，稍后再试一次。", "alert", 2200);
    }
  }

  async function safeTogglePin(): Promise<void> {
    const nextValue = !state.alwaysOnTop;
    try {
      await setAlwaysOnTop(nextValue);
      state.alwaysOnTop = nextValue;
      updateStatus();
      setBubble(
        nextValue ? "我会继续待在最前面陪你。" : "先让其他窗口排在我前面吧。",
        "hint",
        1900,
      );
    } catch (error) {
      console.error(error);
      setBubble("置顶状态切换失败了。", "alert", 2200);
    }
  }

  async function safeClose(): Promise<void> {
    try {
      setBubble("那我先悄悄下班啦。", "hint", 800);
      window.setTimeout(() => {
        void closePet();
      }, 260);
    } catch (error) {
      console.error(error);
      setBubble("关闭失败了。", "alert", 1800);
    }
  }

  async function safeStartDrag(): Promise<void> {
    try {
      state.dockedToCorner = false;
      await startPetDrag();
    } catch (error) {
      console.error(error);
      setBubble("拖动暂时失败了。", "alert", 1800);
    }
  }

  function startIdleChatter(): void {
    clearTimer(state.idleChatterInterval);
    state.idleChatterInterval = window.setInterval(() => {
      if (state.talking || state.surprised) {
        return;
      }
      if (Math.random() < 0.42) {
        startTalking(pick(chatLines), 1850);
      }
    }, 14000);
  }

  petStage.querySelectorAll<HTMLButtonElement>(".hitbox").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (button.dataset.area === "head") {
        reactToHead(event);
      } else {
        reactToBody(event);
      }
    });
  });

  dragHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    void safeStartDrag();
  });

  petRoot.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target !== petRoot) {
      return;
    }
    event.preventDefault();
    void safeStartDrag();
  });

  petFrame.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0) {
      return;
    }
    if (
      target === petFrame ||
      target.classList.contains("pet-shadow")
    ) {
      event.preventDefault();
      void safeStartDrag();
    }
  });

  petFrame.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openSettings();
  });

  settingsPanel.addEventListener("click", (event) => {
    if (event.target === settingsPanel) {
      closeSettings();
    }
  });

  settingsCloseButton.addEventListener("click", () => {
    closeSettings();
  });

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveLlmSettings();
  });

  settingsTestButton.addEventListener("click", () => {
    void testLlmSettings();
  });

  historyButton.addEventListener("click", () => {
    openHistory();
  });

  historyCloseButton.addEventListener("click", () => {
    closeHistory();
  });

  historyRefreshButton.addEventListener("click", () => {
    void refreshHistory();
  });

  historyClearButton.addEventListener("click", () => {
    void clearHistory();
  });

  historyPanel.addEventListener("click", (event) => {
    if (event.target === historyPanel) {
      closeHistory();
    }
  });

  for (const button of interactionToolButtons) {
    button.addEventListener("click", () => {
      setInteractionTool(button.dataset.tool, { announce: true });
    });
  }

  floatingInput.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitFloatingInput();
  });

  floatingTextInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFloatingInput();
    }
  });

  petStage.addEventListener(
    "wheel",
    (event) => {
      const target = event.target as HTMLElement;
      if (target.closest(".control-row") || target.closest(".interaction-tools")) {
        return;
      }
      event.preventDefault();
      const nextScale = state.scale + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP);
      void applyScale(nextScale, { showBubble: false });
    },
    { passive: false },
  );

  petRoot.addEventListener("animationend", () => {
    petRoot.classList.remove("pet-pop");
  });

  chatButton.addEventListener("click", () => {
    if (state.llmInteractionMode) {
      void runLlmInteraction("button", "聊天按钮", undefined, "用户点击了聊天按钮。");
      return;
    }

    void startSmartChat();
  });

  snapButton.addEventListener("click", () => {
    void safeMoveWindow();
  });

  scaleDownButton.addEventListener("click", () => {
    void applyScale(state.scale - SCALE_STEP);
  });

  scaleUpButton.addEventListener("click", () => {
    void applyScale(state.scale + SCALE_STEP);
  });

  sceneButton.addEventListener("click", () => {
    setSceneMode(!state.sceneMode, { announce: true });
  });

  llmModeButton.addEventListener("click", () => {
    setLlmInteractionMode(!state.llmInteractionMode, { announce: true });
  });

  pinButton.addEventListener("click", () => {
    void safeTogglePin();
  });

  closeButton.addEventListener("click", () => {
    void safeClose();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!settingsPanel.hidden) {
        closeSettings();
        return;
      }

      if (!historyPanel.hidden) {
        closeHistory();
        return;
      }

      if (!floatingInput.hidden) {
        closeFloatingInput();
        return;
      }

      void safeClose();
      return;
    }

    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      void applyScale(state.scale + SCALE_STEP);
      return;
    }

    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      void applyScale(state.scale - SCALE_STEP);
    }
  });

  updateStatus();
  bubble.dataset.show = "false";
  blinkLayer.hidden = true;
  talkLayer.hidden = true;
  mouthOLayer.hidden = true;
  setBaseExpression("idle");
  setCssScale(state.scale);

  const savedScale = Number(localStorage.getItem(SCALE_STORAGE_KEY) ?? "1");
  const savedLlmInteractionMode = localStorage.getItem(LLM_INTERACTION_MODE_STORAGE_KEY) === "1";
  const savedSceneMode = localStorage.getItem(SCENE_MODE_STORAGE_KEY) === "1";
  const savedInteractionTool = localStorage.getItem(INTERACTION_TOOL_STORAGE_KEY);

  setSceneMode(savedSceneMode, { persist: false });
  setLlmInteractionMode(savedLlmInteractionMode, { persist: false });
  setInteractionTool(savedInteractionTool, { persist: false });
  void applyScale(savedScale, { persist: false, showBubble: false, ensureDocked: true });

  void listen("pet-open-input", () => {
    openFloatingInput();
  });

  setBubble("可以拖动我，也可以用滚轮或 +/- 调整大小。", "hint", 3400);
  scheduleBlink();
  startIdleChatter();
});
