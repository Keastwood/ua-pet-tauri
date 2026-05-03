import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { DEFAULT_PET_SKIN_ID, PET_SKINS as BUILT_IN_PET_SKINS, getPetSkin as getBuiltInPetSkin } from "./skins";
import type { PetSkinDefinition, PetSkinLayoutId } from "./skinTypes";

function getCurrentWindowLabel(): string | null {
  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

const IS_MASK_EDITOR_WINDOW =
  getCurrentWindowLabel() === "mask-editor" ||
  new URLSearchParams(window.location.search).get("view") === "mask-editor" ||
  window.location.hash === "#mask-editor";

type Tone = "warm" | "alert" | "hint";
type BaseExpression = "idle" | "surprised";
type InteractionToolId = string;

interface PetState {
  affection: number;
  alwaysOnTop: boolean;
  llmInteractionMode: boolean;
  selectedInteractionTool: InteractionToolId;
  selectedSkinId: string;
  talking: boolean;
  surprised: boolean;
  scale: number;
  dockedToCorner: boolean;
  sceneMode: boolean;
  voiceEnabled: boolean;
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
  forceResize?: boolean;
}

interface WindowPosition {
  x: number;
  y: number;
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

interface MaskPoint {
  x: number;
  y: number;
}

interface BodyMaskStroke {
  mode: "paint" | "erase";
  size: number;
  points: MaskPoint[];
}

interface BodyMaskPart {
  id: string;
  label: string;
  prompt?: string;
  layer?: number;
  shape: "rect" | "ellipse" | "polygon";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  points?: MaskPoint[];
  strokes?: BodyMaskStroke[];
}

type MaskTool = "move" | "brush" | "lasso" | "eraser";

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
  icon: string;
  prompt?: string;
}

interface CustomSkinImagePaths {
  idle: string;
  surprised: string;
  blink: string;
  mouthTalk: string;
  mouthO: string;
}

interface CustomSkinView {
  id: string;
  name: string;
  layout: PetSkinLayoutId;
  assetWidth: number;
  assetHeight: number;
  hitCalibrationY: number;
  images: CustomSkinImagePaths;
}

interface SaveCustomSkinRequest {
  id: string;
  name: string;
  layout: PetSkinLayoutId;
  assetWidth: number;
  assetHeight: number;
  hitCalibrationY: number;
  images: {
    idleDataUrl: string;
    surprisedDataUrl: string;
    blinkDataUrl: string;
    mouthTalkDataUrl: string;
    mouthODataUrl: string;
  };
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternativeLike;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  item(index: number): SpeechRecognitionResultLike;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const BASE_WINDOW_WIDTH = 430;
const PET_VISUAL_WIDTH = 350;
const BASE_WINDOW_HEIGHT = Math.ceil(
  (PET_VISUAL_WIDTH * getBuiltInPetSkin(DEFAULT_PET_SKIN_ID).assetHeight) /
    getBuiltInPetSkin(DEFAULT_PET_SKIN_ID).assetWidth,
);
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;
const SCALE_STEP = 0.05;
const INTERACTIVE_DRAG_DELAY_MS = 180;
const INTERACTIVE_DRAG_DISTANCE_PX = 7;
const SCALE_STORAGE_KEY = "silver-pet.scale.v2";
const SCENE_MODE_STORAGE_KEY = "silver-pet.scene-mode.v1";
const LLM_INTERACTION_MODE_STORAGE_KEY = "silver-pet.llm-interaction-mode.v1";
const INTERACTION_TOOL_STORAGE_KEY = "silver-pet.interaction-tool.v1";
const INTERACTION_TOOLS_STORAGE_KEY = "silver-pet.interaction-tools.v1";
const PET_SKIN_STORAGE_KEY = "silver-pet.skin.v1";
const PET_SKIN_PROMPTS_STORAGE_KEY = "silver-pet.skin-prompts.v1";
const PET_HIDDEN_SKINS_STORAGE_KEY = "silver-pet.hidden-skins.v1";
const PET_FAVORITE_SKINS_STORAGE_KEY = "silver-pet.favorite-skins.v1";
const PET_BODY_MASKS_STORAGE_KEY = "silver-pet.body-masks.v1";
const VOICE_ENABLED_STORAGE_KEY = "silver-pet.voice-enabled.v1";
const VOICE_SENSITIVITY_STORAGE_KEY = "silver-pet.voice-sensitivity.v1";
const VOICE_LANGUAGE_STORAGE_KEY = "silver-pet.voice-language.v1";
const MAX_FAVORITE_SKINS = 4;
const PET_LLM_SYSTEM_PROMPT =
  "你是一个银白发桌宠，会陪用户工作和休息。请用中文回复，语气温柔、俏皮、像桌宠在说话。每次只说一句，控制在 36 个汉字以内，不要解释，不要加引号。";

const DEFAULT_INTERACTION_TOOLS: InteractionTool[] = [
  { id: "finger", label: "手指", verb: "戳戳", icon: "☝" },
  { id: "palm", label: "手掌", verb: "揉捏", icon: "✋" },
  { id: "mouth", label: "嘴", verb: "亲吻", icon: "♡" },
  { id: "foot", label: "脚", verb: "踩", icon: "◒" },
  { id: "feather", label: "舌头", verb: "舔", icon: "〰" },
  { id: "comb", label: "鸡鸡", verb: "插入", icon: "▥" },
  { id: "snack", label: "零食", verb: "投喂", icon: "◇" },
];

const HALF_BODY_HIT_AREA_RULES: PetHitAreaRule[] = [
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
  { label: "小腹", shape: "rect", x: 35, y: 95, width: 30, height: 12 },
  { label: "腹部", shape: "rect", x: 28, y: 76, width: 44, height: 12 },
  { label: "腰部", shape: "rect", x: 20, y: 88, width: 60, height: 7.5 },
  { label: "左手臂", shape: "rect", x: 0, y: 64, width: 25, height: 34 },
  { label: "右手臂", shape: "rect", x: 75, y: 64, width: 25, height: 34 },
  { label: "左手", shape: "rect", x: 0, y: 95, width: 18, height: 5 },
  { label: "右手", shape: "rect", x: 82, y: 95, width: 18, height: 5 },
  { label: "头发", shape: "rect", x: 0, y: 18, width: 100, height: 40 },
];

const FULL_BODY_HIT_AREA_RULES: PetHitAreaRule[] = [
  { label: "嘴巴", shape: "ellipse", x: 44, y: 36.6, width: 14, height: 4.6 },
  { label: "鼻尖", shape: "ellipse", x: 48, y: 31.8, width: 5, height: 5.2 },
  { label: "左眼", shape: "ellipse", x: 31, y: 26.4, width: 18, height: 6.6 },
  { label: "右眼", shape: "ellipse", x: 52, y: 26.4, width: 18, height: 6.6 },
  { label: "左脸颊", shape: "ellipse", x: 25, y: 31.2, width: 17, height: 8.8 },
  { label: "右脸颊", shape: "ellipse", x: 59, y: 31.2, width: 17, height: 8.8 },
  { label: "脸", shape: "ellipse", x: 26, y: 22.4, width: 48, height: 20 },
  { label: "光环", shape: "ellipse", x: 3, y: 0.8, width: 43, height: 10 },
  { label: "头顶", shape: "ellipse", x: 25, y: 10.5, width: 52, height: 15 },
  { label: "刘海", shape: "rect", x: 31, y: 19.5, width: 38, height: 8 },
  { label: "左耳", shape: "ellipse", x: 20, y: 28.5, width: 8, height: 9 },
  { label: "右耳", shape: "ellipse", x: 71, y: 27.8, width: 9, height: 10 },
  { label: "左侧头发", shape: "rect", x: 6, y: 23, width: 20, height: 49 },
  { label: "右侧头发", shape: "rect", x: 75, y: 22, width: 20, height: 49 },
  { label: "脖子", shape: "rect", x: 40, y: 40.2, width: 21, height: 6.2 },
  { label: "左肩", shape: "rect", x: 12, y: 45.5, width: 25, height: 7 },
  { label: "右肩", shape: "rect", x: 63, y: 45.5, width: 25, height: 7 },
  { label: "胸口", shape: "ellipse", x: 27, y: 49, width: 46, height: 12 },
  { label: "左胸", shape: "ellipse", x: 20, y: 54.5, width: 24, height: 11 },
  { label: "右胸", shape: "ellipse", x: 56, y: 54.5, width: 24, height: 11 },
  { label: "双手", shape: "ellipse", x: 35, y: 50.5, width: 31, height: 12 },
  { label: "左手臂", shape: "rect", x: 0, y: 48, width: 30, height: 31 },
  { label: "右手臂", shape: "rect", x: 70, y: 48, width: 30, height: 31 },
  { label: "腹部", shape: "rect", x: 34, y: 65.5, width: 32, height: 12 },
  { label: "肚脐", shape: "ellipse", x: 45, y: 77.2, width: 10, height: 5 },
  { label: "腰部", shape: "rect", x: 26, y: 80, width: 48, height: 7 },
  { label: "小穴", shape: "ellipse", x: 28, y: 85.5, width: 44, height: 9 },
  { label: "左大腿", shape: "rect", x: 25, y: 91, width: 21, height: 9 },
  { label: "右大腿", shape: "rect", x: 54, y: 91, width: 21, height: 9 },
  { label: "头发", shape: "rect", x: 0, y: 10, width: 100, height: 34 },
];

const PET_HIT_AREA_RULES_BY_LAYOUT: Record<PetSkinLayoutId, PetHitAreaRule[]> = {
  halfBody: HALF_BODY_HIT_AREA_RULES,
  fullBody: FULL_BODY_HIT_AREA_RULES,
};

let customPetSkins: PetSkinDefinition[] = [];
let availablePetSkins: PetSkinDefinition[] = [...BUILT_IN_PET_SKINS];
let hiddenPetSkinIds = readStoredStringSet(PET_HIDDEN_SKINS_STORAGE_KEY);
let skinPromptOverrides = readStoredStringRecord(PET_SKIN_PROMPTS_STORAGE_KEY);
let favoritePetSkinIds = readStoredStringList(PET_FAVORITE_SKINS_STORAGE_KEY);
let bodyMaskOverrides = readStoredBodyMasks();
let interactionTools = readStoredInteractionTools();
let currentBaseWindowHeight = BASE_WINDOW_HEIGHT;
const hadStoredFavoritePetSkins = localStorage.getItem(PET_FAVORITE_SKINS_STORAGE_KEY) !== null;

const state: PetState = {
  affection: 0,
  alwaysOnTop: true,
  llmInteractionMode: false,
  selectedInteractionTool: "finger",
  selectedSkinId: DEFAULT_PET_SKIN_ID,
  talking: false,
  surprised: false,
  scale: 1,
  dockedToCorner: true,
  sceneMode: false,
  voiceEnabled: false,
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

function readStoredStringRecord(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch (error) {
    console.warn(`Failed to read ${key}:`, error);
    return {};
  }
}

function readStoredStringSet(key: string): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch (error) {
    console.warn(`Failed to read ${key}:`, error);
    return new Set();
  }
}

function readStoredStringList(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === "string");
  } catch (error) {
    console.warn(`Failed to read ${key}:`, error);
    return [];
  }
}

function cloneInteractionTool(tool: InteractionTool): InteractionTool {
  return { ...tool };
}

function normalizeInteractionTool(tool: unknown): InteractionTool | null {
  if (!tool || typeof tool !== "object") {
    return null;
  }

  const candidate = tool as Partial<InteractionTool>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
  const verb = typeof candidate.verb === "string" ? candidate.verb.trim() : "";
  const icon = typeof candidate.icon === "string" ? candidate.icon.trim() : "";
  if (!id || !label || !verb) {
    return null;
  }

  return {
    id,
    label,
    verb,
    icon: icon || label.slice(0, 1) || "互",
    prompt: typeof candidate.prompt === "string" ? candidate.prompt.trim() : "",
  };
}

function uniqueInteractionTools(tools: InteractionTool[]): InteractionTool[] {
  const seen = new Set<string>();
  const unique: InteractionTool[] = [];
  for (const tool of tools) {
    if (seen.has(tool.id)) {
      continue;
    }
    seen.add(tool.id);
    unique.push(tool);
  }
  return unique;
}

function readStoredInteractionTools(): InteractionTool[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(INTERACTION_TOOLS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) {
      return DEFAULT_INTERACTION_TOOLS.map(cloneInteractionTool);
    }

    const tools = uniqueInteractionTools(
      parsed.map(normalizeInteractionTool).filter((tool): tool is InteractionTool => tool !== null),
    );
    return tools.length > 0 ? tools : DEFAULT_INTERACTION_TOOLS.map(cloneInteractionTool);
  } catch (error) {
    console.warn(`Failed to read ${INTERACTION_TOOLS_STORAGE_KEY}:`, error);
    return DEFAULT_INTERACTION_TOOLS.map(cloneInteractionTool);
  }
}

function saveInteractionTools(): void {
  localStorage.setItem(INTERACTION_TOOLS_STORAGE_KEY, JSON.stringify(interactionTools));
}

function normalizeMaskPoint(point: unknown): MaskPoint | null {
  if (!point || typeof point !== "object") {
    return null;
  }

  const candidate = point as Partial<MaskPoint>;
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

function normalizeBodyMaskPart(part: unknown): BodyMaskPart | null {
  if (!part || typeof part !== "object") {
    return null;
  }

  const candidate = part as Partial<BodyMaskPart>;
  if (!candidate.id || !candidate.label) {
    return null;
  }

  const shape = candidate.shape === "polygon" || candidate.shape === "rect" || candidate.shape === "ellipse"
    ? candidate.shape
    : "ellipse";
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  const rotation = Number(candidate.rotation ?? 0);
  const layer = Number(candidate.layer);
  if (![x, y, width, height, rotation].every(Number.isFinite)) {
    return null;
  }

  const points = Array.isArray(candidate.points)
    ? candidate.points.map(normalizeMaskPoint).filter((point): point is MaskPoint => point !== null)
    : undefined;
  const strokes = Array.isArray(candidate.strokes)
    ? candidate.strokes.flatMap((stroke) => {
        if (!stroke || typeof stroke !== "object") {
          return [];
        }
        const candidateStroke = stroke as Partial<BodyMaskStroke>;
        const mode: BodyMaskStroke["mode"] = candidateStroke.mode === "erase" ? "erase" : "paint";
        const size = Number(candidateStroke.size);
        const strokePoints = Array.isArray(candidateStroke.points)
          ? candidateStroke.points.map(normalizeMaskPoint).filter((point): point is MaskPoint => point !== null)
          : [];
        return Number.isFinite(size) && strokePoints.length > 0 ? [{ mode, size, points: strokePoints }] : [];
      })
    : undefined;

  return {
    id: String(candidate.id),
    label: String(candidate.label),
    prompt: typeof candidate.prompt === "string" ? candidate.prompt : undefined,
    layer: Number.isFinite(layer) ? layer : undefined,
    shape,
    x,
    y,
    width,
    height,
    rotation,
    points,
    strokes,
  };
}

function isAutoRuleMaskId(id: string): boolean {
  return /^rule-\d+$/.test(id);
}

function preserveLegacyLayerOrder(parts: BodyMaskPart[]): BodyMaskPart[] {
  if (parts.some((part) => Number.isFinite(part.layer))) {
    return parts;
  }

  const allPartsAreAutoRules = parts.length > 0 && parts.every((part) => isAutoRuleMaskId(part.id));
  const autoRuleOrderWasChanged = allPartsAreAutoRules && parts.some((part, index) => part.id !== `rule-${index}`);
  if (!autoRuleOrderWasChanged) {
    return parts;
  }

  return parts.map((part, index) => ({ ...part, layer: index }));
}

function readStoredBodyMasks(): Record<string, BodyMaskPart[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PET_BODY_MASKS_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const masks: Record<string, BodyMaskPart[]> = {};
    for (const [skinId, parts] of Object.entries(parsed)) {
      if (!Array.isArray(parts)) {
        continue;
      }
      const normalizedParts = parts.map(normalizeBodyMaskPart).filter((part): part is BodyMaskPart => part !== null);
      masks[skinId] = preserveLegacyLayerOrder(normalizedParts);
    }
    return masks;
  } catch {
    return {};
  }
}

function saveBodyMaskOverrides(): void {
  localStorage.setItem(PET_BODY_MASKS_STORAGE_KEY, JSON.stringify(bodyMaskOverrides));
}

function saveSkinPromptOverrides(): void {
  localStorage.setItem(PET_SKIN_PROMPTS_STORAGE_KEY, JSON.stringify(skinPromptOverrides));
}

function saveHiddenPetSkins(): void {
  localStorage.setItem(PET_HIDDEN_SKINS_STORAGE_KEY, JSON.stringify(Array.from(hiddenPetSkinIds)));
}

function saveFavoritePetSkins(): void {
  localStorage.setItem(PET_FAVORITE_SKINS_STORAGE_KEY, JSON.stringify(favoritePetSkinIds));
}

function getInteractionTool(id: string | null | undefined): InteractionTool {
  return interactionTools.find((tool) => tool.id === id) ?? interactionTools[0] ?? DEFAULT_INTERACTION_TOOLS[0];
}

function getHitAreaRules(skin: PetSkinDefinition): PetHitAreaRule[] {
  return PET_HIT_AREA_RULES_BY_LAYOUT[skin.layout] ?? HALF_BODY_HIT_AREA_RULES;
}

function cloneBodyMaskPart(part: BodyMaskPart): BodyMaskPart {
  return {
    ...part,
    points: part.points?.map((point) => ({ ...point })),
    strokes: part.strokes?.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ ...point })),
    })),
  };
}

function cloneBodyMaskParts(parts: BodyMaskPart[]): BodyMaskPart[] {
  return parts.map(cloneBodyMaskPart);
}

function buildDefaultBodyMasks(skin: PetSkinDefinition): BodyMaskPart[] {
  return getHitAreaRules(skin).map((rule, index) => ({
    id: `rule-${index}`,
    label: rule.label,
    prompt: "",
    shape: rule.shape,
    x: rule.x + rule.width / 2,
    y: rule.y + rule.height / 2,
    width: rule.width,
    height: rule.height,
    rotation: 0,
  })).sort((a, b) => getBodyMaskArea(b) - getBodyMaskArea(a));
}

function getBodyMaskArea(part: BodyMaskPart): number {
  return Math.max(0, part.width) * Math.max(0, part.height);
}

function getBodyMaskHitPriority(part: BodyMaskPart): number {
  return Number.isFinite(part.layer) ? Number(part.layer) + 100000 : -getBodyMaskArea(part);
}

function getBodyMasksForHitTesting(skin: PetSkinDefinition): BodyMaskPart[] {
  return cloneBodyMaskParts(getBodyMasksForSkin(skin)).sort((a, b) => {
    const priorityDiff = getBodyMaskHitPriority(b) - getBodyMaskHitPriority(a);
    return priorityDiff !== 0 ? priorityDiff : getBodyMaskArea(a) - getBodyMaskArea(b);
  });
}

function getBodyMasksForSkin(skin: PetSkinDefinition): BodyMaskPart[] {
  bodyMaskOverrides = readStoredBodyMasks();
  const customMasks = bodyMaskOverrides[skin.id];
  return customMasks && customMasks.length > 0 ? customMasks : buildDefaultBodyMasks(skin);
}

function rotatePoint(point: MaskPoint, center: MaskPoint, degrees: number): MaskPoint {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

function unrotatePoint(point: MaskPoint, center: MaskPoint, degrees: number): MaskPoint {
  return rotatePoint(point, center, -degrees);
}

function distanceToSegment(point: MaskPoint, start: MaskPoint, end: MaskPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function isPointInPolygon(point: MaskPoint, polygon: MaskPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const current = polygon[i];
    const previous = polygon[j];
    const crosses = current.y > point.y !== previous.y > point.y;
    if (crosses && point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x) {
      inside = !inside;
    }
  }
  return inside;
}

function isPointInStroke(point: MaskPoint, stroke: BodyMaskStroke): boolean {
  const radius = stroke.size / 2;
  if (stroke.points.length === 1) {
    return Math.hypot(point.x - stroke.points[0].x, point.y - stroke.points[0].y) <= radius;
  }

  return stroke.points.some((strokePoint, index) => {
    const next = stroke.points[index + 1];
    return next ? distanceToSegment(point, strokePoint, next) <= radius : false;
  });
}

function isPointInBodyMaskPart(position: PetPointerPosition, part: BodyMaskPart): boolean {
  if (position.xPercent === undefined || position.yPercent === undefined) {
    return false;
  }

  const point = { x: position.xPercent, y: position.yPercent };
  const erased = part.strokes?.some((stroke) => stroke.mode === "erase" && isPointInStroke(point, stroke)) ?? false;
  if (erased) {
    return false;
  }

  const painted = part.strokes?.some((stroke) => stroke.mode === "paint" && isPointInStroke(point, stroke)) ?? false;
  if (painted) {
    return true;
  }

  const center = { x: part.x, y: part.y };
  const localPoint = unrotatePoint(point, center, part.rotation);
  if (part.shape === "rect") {
    return Math.abs(localPoint.x - part.x) <= part.width / 2 && Math.abs(localPoint.y - part.y) <= part.height / 2;
  }

  if (part.shape === "polygon" && part.points && part.points.length >= 3) {
    return isPointInPolygon(localPoint, part.points);
  }

  const radiusX = part.width / 2;
  const radiusY = part.height / 2;
  if (radiusX <= 0 || radiusY <= 0) {
    return false;
  }

  const normalizedX = (localPoint.x - part.x) / radiusX;
  const normalizedY = (localPoint.y - part.y) / radiusY;
  return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
}

function syncAvailablePetSkins(): void {
  availablePetSkins = [...BUILT_IN_PET_SKINS, ...customPetSkins].filter(
    (skin) => skin.id === DEFAULT_PET_SKIN_ID || !hiddenPetSkinIds.has(skin.id),
  );
}

function findPetSkin(id: string | null | undefined): PetSkinDefinition {
  return (
    availablePetSkins.find((skin) => skin.id === id) ??
    availablePetSkins.find((skin) => skin.id === DEFAULT_PET_SKIN_ID) ??
    getBuiltInPetSkin(DEFAULT_PET_SKIN_ID)
  );
}

function getSkinPrompt(skinId: string | null | undefined): string {
  return (skinPromptOverrides[skinId ?? ""] ?? "").trim();
}

function isRuntimeCustomSkin(skinId: string): boolean {
  return customPetSkins.some((skin) => skin.id === skinId);
}

function uniqueAvailableSkinIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const availableIds = new Set(availablePetSkins.map((skin) => skin.id));

  return ids.filter((id) => {
    if (seen.has(id) || !availableIds.has(id)) {
      return false;
    }

    seen.add(id);
    return true;
  });
}

function getFavoritePetSkinIds(): string[] {
  const savedFavorites = uniqueAvailableSkinIds(favoritePetSkinIds).slice(0, MAX_FAVORITE_SKINS);
  if (savedFavorites.length > 0 || hadStoredFavoritePetSkins) {
    return savedFavorites;
  }

  return availablePetSkins.slice(0, MAX_FAVORITE_SKINS).map((skin) => skin.id);
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function clampVoiceSensitivity(value: number): number {
  if (!Number.isFinite(value)) {
    return 6;
  }

  return Math.min(10, Math.max(1, Math.round(value)));
}

function getVoiceConfidenceThreshold(sensitivity: number): number {
  return Math.max(0.05, Math.min(0.65, 0.72 - clampVoiceSensitivity(sensitivity) * 0.067));
}

function shouldAcceptVoiceTranscript(transcript: string, confidence: number, sensitivity: number): boolean {
  const normalized = transcript.replace(/\s+/g, "");
  if (normalized.length >= 2 && clampVoiceSensitivity(sensitivity) >= 6) {
    return true;
  }

  if (normalized.length >= 4 && confidence >= 0.01) {
    return true;
  }

  return confidence >= getVoiceConfidenceThreshold(sensitivity);
}

function customSkinViewToDefinition(skin: CustomSkinView): PetSkinDefinition {
  return {
    id: skin.id,
    name: skin.name,
    layout: skin.layout,
    assetWidth: skin.assetWidth,
    assetHeight: skin.assetHeight,
    hitCalibrationY: skin.hitCalibrationY,
    images: {
      idle: convertFileSrc(skin.images.idle),
      surprised: convertFileSrc(skin.images.surprised),
      blink: convertFileSrc(skin.images.blink),
      mouthTalk: convertFileSrc(skin.images.mouthTalk),
      mouthO: convertFileSrc(skin.images.mouthO),
    },
  };
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

function getPetVisualHeight(skin: PetSkinDefinition): number {
  return (PET_VISUAL_WIDTH * skin.assetHeight) / skin.assetWidth;
}

function getWindowSizeForScale(scale: number): { width: number; height: number } {
  return {
    width: Math.round(BASE_WINDOW_WIDTH * scale),
    height: Math.round(currentBaseWindowHeight * scale),
  };
}

function setCssScale(scale: number): void {
  document.documentElement.style.setProperty("--app-scale", String(scale));
  document.documentElement.style.setProperty("--app-ui-scale", String(1 / scale));
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

async function getPetWindowPosition(): Promise<WindowPosition> {
  return invoke<WindowPosition>("get_pet_window_position");
}

async function openMaskEditorWindow(): Promise<void> {
  await invoke("open_mask_editor");
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
  document.body.dataset.view = IS_MASK_EDITOR_WINDOW ? "mask-editor" : "pet";
  const petApp = must<HTMLElement>(".pet-app");
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
  const floatingKeepOpenInput = must<HTMLInputElement>("#floating-keep-open-input");
  const floatingInputHint = must<HTMLParagraphElement>("#floating-input-hint");
  const settingsForm = must<HTMLFormElement>("#llm-settings-form");
  const settingsStatus = must<HTMLParagraphElement>("#settings-status");
  const settingsCloseButton = must<HTMLButtonElement>("#settings-close-btn");
  const settingsSaveButton = must<HTMLButtonElement>("#settings-save-btn");
  const settingsTestButton = must<HTMLButtonElement>("#settings-test-btn");
  const settingsTabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".settings-tab-btn[data-settings-tab]"));
  const settingsSections = Array.from(document.querySelectorAll<HTMLElement>(".settings-section[data-settings-section]"));
  const llmApiKeyInput = must<HTMLInputElement>("#llm-api-key-input");
  const llmBaseUrlInput = must<HTMLInputElement>("#llm-base-url-input");
  const llmModelInput = must<HTMLInputElement>("#llm-model-input");
  const llmTimeoutInput = must<HTMLInputElement>("#llm-timeout-input");
  const llmSystemPromptInput = must<HTMLTextAreaElement>("#llm-system-prompt-input");
  const llmClearKeyInput = must<HTMLInputElement>("#llm-clear-key-input");
  const voiceEnabledInput = must<HTMLInputElement>("#voice-enabled-input");
  const voiceLanguageSelect = must<HTMLSelectElement>("#voice-language-select");
  const voiceSensitivityInput = must<HTMLInputElement>("#voice-sensitivity-input");
  const voiceSensitivityValue = must<HTMLElement>("#voice-sensitivity-value");
  const voiceStatus = must<HTMLParagraphElement>("#voice-status");
  const voiceTestButton = must<HTMLButtonElement>("#voice-test-btn");
  const voiceRestartButton = must<HTMLButtonElement>("#voice-restart-btn");
  const affectionValue = must<HTMLSpanElement>("#affection-value");
  const moodValue = must<HTMLSpanElement>("#mood-value");
  const scaleValue = must<HTMLSpanElement>("#scale-value");
  const pinButton = must<HTMLButtonElement>("#pin-btn");
  const snapButton = must<HTMLButtonElement>("#snap-btn");
  const chatButton = must<HTMLButtonElement>("#chat-btn");
  const scaleDownButton = must<HTMLButtonElement>("#scale-down-btn");
  const scaleUpButton = must<HTMLButtonElement>("#scale-up-btn");
  const openMaskEditorButton = must<HTMLButtonElement>("#open-mask-editor-btn");
  const sceneButton = must<HTMLButtonElement>("#scene-btn");
  const llmModeButton = must<HTMLButtonElement>("#llm-mode-btn");
  const historyButton = must<HTMLButtonElement>("#history-btn");
  const closeButton = must<HTMLButtonElement>("#close-btn");
  const interactionToolValue = must<HTMLElement>("#interaction-tool-value");
  const interactionToolButtonsContainer = must<HTMLDivElement>(".interaction-tools__buttons");
  const interactionToolEditorSelect = must<HTMLSelectElement>("#interaction-editor-select");
  const interactionToolNameInput = must<HTMLInputElement>("#interaction-tool-name-input");
  const interactionToolVerbInput = must<HTMLInputElement>("#interaction-tool-verb-input");
  const interactionToolIconInput = must<HTMLInputElement>("#interaction-tool-icon-input");
  const interactionToolPromptInput = must<HTMLTextAreaElement>("#interaction-tool-prompt-input");
  const interactionToolAddButton = must<HTMLButtonElement>("#interaction-tool-add-btn");
  const interactionToolDeleteButton = must<HTMLButtonElement>("#interaction-tool-delete-btn");
  const interactionToolResetButton = must<HTMLButtonElement>("#interaction-tool-reset-btn");
  const interactionToolSaveButton = must<HTMLButtonElement>("#interaction-tool-save-btn");
  const interactionToolEditorStatus = must<HTMLParagraphElement>("#interaction-tool-editor-status");
  const skinValue = must<HTMLElement>("#skin-value");
  const skinButtons = must<HTMLDivElement>("#skin-buttons");
  const skinFileInput = must<HTMLInputElement>("#skin-file-input");
  const skinNameInput = must<HTMLInputElement>("#skin-name-input");
  const skinLayoutSelect = must<HTMLSelectElement>("#skin-layout-select");
  const skinTransparentInput = must<HTMLInputElement>("#skin-transparent-input");
  const skinAddButton = must<HTMLButtonElement>("#skin-add-btn");
  const skinImportStatus = must<HTMLParagraphElement>("#skin-import-status");
  const skinPromptSelect = must<HTMLSelectElement>("#skin-prompt-select");
  const skinPromptInput = must<HTMLTextAreaElement>("#skin-prompt-input");
  const skinPromptSaveButton = must<HTMLButtonElement>("#skin-prompt-save-btn");
  const skinPromptClearButton = must<HTMLButtonElement>("#skin-prompt-clear-btn");
  const skinPromptStatus = must<HTMLParagraphElement>("#skin-prompt-status");
  const skinFavoriteList = must<HTMLDivElement>("#skin-favorite-list");
  const skinFavoriteStatus = must<HTMLParagraphElement>("#skin-favorite-status");
  const skinDeleteSelect = must<HTMLSelectElement>("#skin-delete-select");
  const skinDeleteButton = must<HTMLButtonElement>("#skin-delete-btn");
  const maskPartSelect = must<HTMLSelectElement>("#mask-part-select");
  const maskPartList = must<HTMLDivElement>("#mask-part-list");
  const maskPartNameInput = must<HTMLInputElement>("#mask-part-name-input");
  const maskPartPromptInput = must<HTMLTextAreaElement>("#mask-part-prompt-input");
  const maskToolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mask-tool-btn[data-mask-tool]"));
  const maskBrushSizeInput = must<HTMLInputElement>("#mask-brush-size-input");
  const maskBrushSizeValue = must<HTMLElement>("#mask-brush-size-value");
  const maskScaleInput = must<HTMLInputElement>("#mask-scale-input");
  const maskScaleValue = must<HTMLElement>("#mask-scale-value");
  const maskRotationInput = must<HTMLInputElement>("#mask-rotation-input");
  const maskRotationValue = must<HTMLElement>("#mask-rotation-value");
  const maskEditorStatus = must<HTMLParagraphElement>("#mask-editor-status");
  const maskEditorCanvas = must<HTMLCanvasElement>("#mask-editor-canvas");
  const maskResetPartButton = must<HTMLButtonElement>("#mask-reset-part-btn");
  const maskResetAllButton = must<HTMLButtonElement>("#mask-reset-all-btn");
  const maskAddPartButton = must<HTMLButtonElement>("#mask-add-part-btn");
  const maskDeletePartButton = must<HTMLButtonElement>("#mask-delete-part-btn");
  const maskLayerUpButton = must<HTMLButtonElement>("#mask-layer-up-btn");
  const maskLayerDownButton = must<HTMLButtonElement>("#mask-layer-down-btn");
  const maskSaveButton = must<HTMLButtonElement>("#mask-save-btn");
  const fxLayer = must<HTMLDivElement>("#fx-layer");
  const baseLayer = must<HTMLImageElement>("#base-layer");
  const blinkLayer = must<HTMLImageElement>("#blink-layer");
  const talkLayer = must<HTMLImageElement>("#talk-layer");
  const mouthOLayer = must<HTMLImageElement>("#mouth-o-layer");
  let llmRequestId = 0;
  let activeSkin = findPetSkin(state.selectedSkinId);
  let voiceRecognition: SpeechRecognitionLike | null = null;
  let voiceRecognitionId = 0;
  let voiceRestartTimer: number | undefined;
  let voiceIntentionalStop = false;
  let voiceSensitivity = clampVoiceSensitivity(Number(localStorage.getItem(VOICE_SENSITIVITY_STORAGE_KEY) ?? "6"));
  let voiceLanguage = localStorage.getItem(VOICE_LANGUAGE_STORAGE_KEY) || "zh-CN";
  let maskEditorParts = cloneBodyMaskParts(getBodyMasksForSkin(activeSkin));
  let selectedMaskPartId = maskEditorParts[0]?.id ?? "";
  let selectedMaskTool: MaskTool = "move";
  let activeMaskPointerId: number | null = null;
  let activeMaskStroke: BodyMaskStroke | null = null;
  let activeLassoPoints: MaskPoint[] = [];
  let dragMaskSnapshot: BodyMaskPart | null = null;
  let dragMaskStartPoint: MaskPoint | null = null;
  let activeMaskMoveMode: "move" | "scale" | null = null;
  let maskScaleReferencePart: BodyMaskPart | null = null;
  let pendingInteractiveDrag:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        startScreenX: number;
        startScreenY: number;
        currentScreenX: number;
        currentScreenY: number;
        windowX?: number;
        windowY?: number;
        timer?: number;
        dragging: boolean;
      }
    | null = null;
  let suppressNextHitboxClick = false;
  const quickActionIcons = {
    chat:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.2 17.2 4 21l4.7-1.4c1 .4 2.1.6 3.3.6 5 0 9-3.3 9-7.4s-4-7.4-9-7.4-9 3.3-9 7.4c0 1.7.7 3.3 1.9 4.4Z"/><path d="M8 11.2h8M8 14h5.6"/></svg>',
    history:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 8.9"/><path d="M4.5 4.6v4.3h4.3M12 8.2v4.3l3 1.8"/></svg>',
    scene:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2.4"/><path d="m7 16 3.6-4 2.7 3 1.7-1.8 2 2.8M8.2 8.6h.1"/></svg>',
    transparent:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2.4"/><path d="m5.5 18 13-13M8 5v14M16 5v14M4 12h16"/></svg>',
    pinned:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.6 4 5.4 5.4-2.6 1.1-3.3 4.4.3 3.5-1.3 1.3-3.5-4.7-4.7-3.5 1.3-1.3 3.5.3 4.4-3.3L14.6 4Z"/><path d="m9.6 14.9-4.1 4.1"/></svg>',
    unpinned:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.6 4 5.4 5.4-2.6 1.1-3.3 4.4.3 3.5-1.3 1.3-3.5-4.7-4.7-3.5 1.3-1.3 3.5.3 4.4-3.3L14.6 4Z"/><path d="m4 4 16 16"/></svg>',
  };

  function setIconButton(button: HTMLButtonElement, icon: string, label: string, pressed?: boolean): void {
    button.removeAttribute("data-icon");
    button.innerHTML = `<span class="control-icon">${icon}</span>`;
    button.title = label;
    button.setAttribute("aria-label", label);
    if (pressed !== undefined) {
      button.setAttribute("aria-pressed", String(pressed));
    }
  }

  function getInteractionToolButtons(): HTMLButtonElement[] {
    return Array.from(interactionToolButtonsContainer.querySelectorAll<HTMLButtonElement>(".interaction-tool-btn[data-tool]"));
  }

  function renderInteractionToolButtons(): void {
    interactionToolButtonsContainer.replaceChildren();
    for (const tool of interactionTools) {
      const button = document.createElement("button");
      button.className = "interaction-tool-btn";
      button.type = "button";
      button.dataset.tool = tool.id;
      button.dataset.icon = tool.icon;
      button.textContent = tool.label;
      button.title = `${tool.label}：${tool.verb}`;
      button.setAttribute("aria-label", tool.label);
      button.setAttribute("aria-pressed", String(tool.id === state.selectedInteractionTool));
      button.addEventListener("click", () => {
        setInteractionTool(tool.id, { announce: true });
      });
      interactionToolButtonsContainer.appendChild(button);
    }
  }

  function setInteractionToolEditorStatus(text: string): void {
    interactionToolEditorStatus.textContent = text;
  }

  function renderInteractionToolEditorOptions(selectedId = interactionToolEditorSelect.value || state.selectedInteractionTool): void {
    interactionToolEditorSelect.replaceChildren();
    for (const tool of interactionTools) {
      const option = document.createElement("option");
      option.value = tool.id;
      option.textContent = `${tool.icon} ${tool.label}`;
      interactionToolEditorSelect.appendChild(option);
    }

    interactionToolEditorSelect.value = interactionTools.some((tool) => tool.id === selectedId)
      ? selectedId
      : interactionTools[0]?.id ?? "";
  }

  function loadInteractionToolEditor(toolId = interactionToolEditorSelect.value): void {
    const tool = getInteractionTool(toolId);
    interactionToolEditorSelect.value = tool.id;
    interactionToolNameInput.value = tool.label;
    interactionToolVerbInput.value = tool.verb;
    interactionToolIconInput.value = tool.icon;
    interactionToolPromptInput.value = tool.prompt ?? "";
    interactionToolDeleteButton.disabled = interactionTools.length <= 1;
  }

  function syncInteractionToolEditor(selectedId = interactionToolEditorSelect.value || state.selectedInteractionTool): void {
    renderInteractionToolEditorOptions(selectedId);
    loadInteractionToolEditor(interactionToolEditorSelect.value);
  }

  function createInteractionToolId(): string {
    return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function saveSelectedInteractionToolEditor(): void {
    const index = interactionTools.findIndex((tool) => tool.id === interactionToolEditorSelect.value);
    if (index < 0) {
      return;
    }

    const label = interactionToolNameInput.value.trim();
    const verb = interactionToolVerbInput.value.trim();
    const icon = interactionToolIconInput.value.trim();
    if (!label || !verb) {
      setInteractionToolEditorStatus("显示名称和互动方式不能为空。");
      return;
    }

    interactionTools[index] = {
      ...interactionTools[index],
      label,
      verb,
      icon: icon || label.slice(0, 1) || "互",
      prompt: interactionToolPromptInput.value.trim(),
    };
    saveInteractionTools();
    renderInteractionToolButtons();
    syncInteractionToolEditor(interactionTools[index].id);
    setInteractionTool(interactionTools[index].id, { persist: true });
    setInteractionToolEditorStatus(`${label} 已保存。`);
  }

  function addInteractionTool(): void {
    const id = createInteractionToolId();
    const tool: InteractionTool = {
      id,
      label: `新控件 ${interactionTools.length + 1}`,
      verb: "互动",
      icon: "互",
      prompt: "",
    };
    interactionTools = [...interactionTools, tool];
    saveInteractionTools();
    renderInteractionToolButtons();
    syncInteractionToolEditor(id);
    setInteractionTool(id, { persist: true, announce: true });
    setInteractionToolEditorStatus("已添加新控件，编辑后保存即可用于互动。");
  }

  function deleteSelectedInteractionTool(): void {
    if (interactionTools.length <= 1) {
      setInteractionToolEditorStatus("至少保留一个互动控件。");
      return;
    }

    const toolId = interactionToolEditorSelect.value;
    const removed = getInteractionTool(toolId);
    interactionTools = interactionTools.filter((tool) => tool.id !== toolId);
    saveInteractionTools();
    const nextTool = getInteractionTool(state.selectedInteractionTool);
    renderInteractionToolButtons();
    syncInteractionToolEditor(nextTool.id);
    setInteractionTool(nextTool.id, { persist: true });
    setInteractionToolEditorStatus(`${removed.label} 已删除。`);
  }

  function resetInteractionTools(): void {
    interactionTools = DEFAULT_INTERACTION_TOOLS.map(cloneInteractionTool);
    saveInteractionTools();
    renderInteractionToolButtons();
    syncInteractionToolEditor(interactionTools[0]?.id);
    setInteractionTool(interactionTools[0]?.id, { persist: true, announce: true });
    setInteractionToolEditorStatus("互动控件已恢复为默认配置。");
  }

  function preloadSkin(skin: PetSkinDefinition): void {
    const sources = [
      skin.images.idle,
      skin.images.surprised,
      skin.images.blink,
      skin.images.mouthTalk,
      skin.images.mouthO,
    ];

    for (const src of sources) {
      const image = new Image();
      image.src = src;
    }
  }

  function applySkinVisuals(skin: PetSkinDefinition): void {
    activeSkin = skin;
    const petVisualHeight = getPetVisualHeight(skin);
    currentBaseWindowHeight = Math.ceil(petVisualHeight);
    document.documentElement.style.setProperty("--window-base-height", `${currentBaseWindowHeight}px`);
    petRoot.dataset.skinLayout = skin.layout;
    petStage.style.setProperty("--pet-aspect-height", String(skin.assetHeight / skin.assetWidth));
    petStage.style.setProperty("--pet-visual-width", `${PET_VISUAL_WIDTH}px`);
    petStage.style.setProperty("--pet-visual-height", `${petVisualHeight}px`);
    petRoot.style.setProperty("--mouth-mask-x", skin.layout === "fullBody" ? "51%" : "50.4%");
    petRoot.style.setProperty("--mouth-mask-y", skin.layout === "fullBody" ? "37.4%" : "42.7%");
    petRoot.style.setProperty("--mouth-mask-width", skin.layout === "fullBody" ? "8.8%" : "9.8%");
    petRoot.style.setProperty("--mouth-mask-height", skin.layout === "fullBody" ? "2.5%" : "2.8%");
    blinkLayer.src = skin.images.blink;
    talkLayer.src = skin.images.mouthTalk;
    mouthOLayer.src = skin.images.mouthO;
    setBaseExpression(state.surprised ? "surprised" : "idle");
    preloadSkin(skin);
  }

  function getSelectedMaskPart(): BodyMaskPart | null {
    return maskEditorParts.find((part) => part.id === selectedMaskPartId) ?? maskEditorParts[0] ?? null;
  }

  function markMaskEditorLayerOrderExplicit(): void {
    maskEditorParts.forEach((part, index) => {
      part.layer = index;
    });
  }

  function setMaskEditorStatus(text: string): void {
    maskEditorStatus.textContent = text;
  }

  function maskColor(index: number, alpha = 0.3): string {
    const colors = [
      `rgba(43, 125, 190, ${alpha})`,
      `rgba(232, 122, 76, ${alpha})`,
      `rgba(74, 152, 110, ${alpha})`,
      `rgba(202, 116, 174, ${alpha})`,
      `rgba(190, 148, 44, ${alpha})`,
      `rgba(85, 111, 205, ${alpha})`,
    ];
    return colors[index % colors.length];
  }

  function resizeMaskEditorCanvasForSkin(skin: PetSkinDefinition): void {
    const width = 560;
    const height = Math.max(360, Math.round(width * (skin.assetHeight / skin.assetWidth)));
    maskEditorCanvas.width = width;
    maskEditorCanvas.height = height;
  }

  function percentToCanvas(point: MaskPoint): MaskPoint {
    return {
      x: (point.x / 100) * maskEditorCanvas.width,
      y: (point.y / 100) * maskEditorCanvas.height,
    };
  }

  function canvasToPercent(event: PointerEvent): MaskPoint {
    const rect = maskEditorCanvas.getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  }

  function drawMaskPartPath(context: CanvasRenderingContext2D, part: BodyMaskPart): void {
    const center = percentToCanvas({ x: part.x, y: part.y });
    const width = (part.width / 100) * maskEditorCanvas.width;
    const height = (part.height / 100) * maskEditorCanvas.height;

    context.beginPath();
    if (part.shape === "polygon" && part.points && part.points.length >= 3) {
      const rotatedPoints = part.points.map((point) => percentToCanvas(rotatePoint(point, { x: part.x, y: part.y }, part.rotation)));
      context.moveTo(rotatedPoints[0].x, rotatedPoints[0].y);
      for (const point of rotatedPoints.slice(1)) {
        context.lineTo(point.x, point.y);
      }
      context.closePath();
      return;
    }

    context.save();
    context.translate(center.x, center.y);
    context.rotate((part.rotation * Math.PI) / 180);
    if (part.shape === "rect") {
      context.rect(-width / 2, -height / 2, width, height);
    } else {
      context.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
    }
    context.restore();
  }

  function drawMaskStroke(context: CanvasRenderingContext2D, stroke: BodyMaskStroke, color: string): void {
    if (stroke.points.length === 0) {
      return;
    }

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = color;
    context.lineWidth = Math.max(2, (stroke.size / 100) * maskEditorCanvas.width);
    context.beginPath();
    const first = percentToCanvas(stroke.points[0]);
    context.moveTo(first.x, first.y);
    for (const point of stroke.points.slice(1)) {
      const canvasPoint = percentToCanvas(point);
      context.lineTo(canvasPoint.x, canvasPoint.y);
    }
    context.stroke();
    context.restore();
  }

  function getMaskScaleHandle(part: BodyMaskPart): MaskPoint {
    return rotatePoint(
      { x: part.x + part.width / 2, y: part.y + part.height / 2 },
      { x: part.x, y: part.y },
      part.rotation,
    );
  }

  function drawMaskEditor(): void {
    const context = maskEditorCanvas.getContext("2d");
    if (!context) {
      return;
    }

    context.clearRect(0, 0, maskEditorCanvas.width, maskEditorCanvas.height);
    if (baseLayer.complete && baseLayer.naturalWidth > 0) {
      context.save();
      context.globalAlpha = 0.84;
      context.drawImage(baseLayer, 0, 0, maskEditorCanvas.width, maskEditorCanvas.height);
      context.restore();
    }

    maskEditorParts.forEach((part, index) => {
      const selected = part.id === selectedMaskPartId;
      drawMaskPartPath(context, part);
      context.fillStyle = maskColor(index, selected ? 0.34 : 0.18);
      context.strokeStyle = selected ? "rgba(24, 54, 75, 0.92)" : maskColor(index, 0.72);
      context.lineWidth = selected ? 3 : 1.5;
      context.fill();
      context.stroke();

      for (const stroke of part.strokes ?? []) {
        drawMaskStroke(context, stroke, stroke.mode === "erase" ? "rgba(255, 255, 255, 0.88)" : maskColor(index, 0.82));
      }

      if (selected) {
        const handle = percentToCanvas(getMaskScaleHandle(part));
        context.save();
        context.fillStyle = "#ffffff";
        context.strokeStyle = "rgba(24, 54, 75, 0.88)";
        context.lineWidth = 2;
        context.beginPath();
        context.rect(handle.x - 5, handle.y - 5, 10, 10);
        context.fill();
        context.stroke();
        context.restore();
      }
    });

    if (activeLassoPoints.length > 1) {
      context.save();
      context.strokeStyle = "rgba(20, 51, 72, 0.86)";
      context.setLineDash([7, 5]);
      context.lineWidth = 2;
      context.beginPath();
      const first = percentToCanvas(activeLassoPoints[0]);
      context.moveTo(first.x, first.y);
      for (const point of activeLassoPoints.slice(1)) {
        const canvasPoint = percentToCanvas(point);
        context.lineTo(canvasPoint.x, canvasPoint.y);
      }
      context.stroke();
      context.restore();
    }
  }

  function syncMaskToolButtons(): void {
    for (const button of maskToolButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.maskTool === selectedMaskTool));
    }
  }

  function renderMaskPartOptions(): void {
    const previousValue = selectedMaskPartId;
    maskPartSelect.replaceChildren();
    maskPartList.replaceChildren();
    for (const part of maskEditorParts) {
      const option = document.createElement("option");
      option.value = part.id;
      option.textContent = part.label;
      maskPartSelect.appendChild(option);

      const item = document.createElement("button");
      item.className = "mask-part-item";
      item.type = "button";
      item.dataset.maskPart = part.id;
      item.textContent = part.label;
      item.title = part.label;
      item.setAttribute("aria-selected", String(part.id === selectedMaskPartId));
      item.addEventListener("click", () => {
        selectedMaskPartId = part.id;
        maskPartSelect.value = part.id;
        syncMaskControls();
        renderMaskPartOptions();
        drawMaskEditor();
      });
      maskPartList.appendChild(item);
    }
    selectedMaskPartId = maskEditorParts.some((part) => part.id === previousValue)
      ? previousValue
      : maskEditorParts[0]?.id ?? "";
    maskPartSelect.value = selectedMaskPartId;
    for (const item of maskPartList.querySelectorAll<HTMLButtonElement>(".mask-part-item[data-mask-part]")) {
      item.setAttribute("aria-selected", String(item.dataset.maskPart === selectedMaskPartId));
    }
  }

  function syncMaskControls(resetScale = true): void {
    const part = getSelectedMaskPart();
    maskBrushSizeValue.textContent = `${maskBrushSizeInput.value}%`;
    if (!part) {
      maskPartNameInput.value = "";
      maskPartPromptInput.value = "";
      return;
    }

    maskPartNameInput.value = part.label;
    maskPartPromptInput.value = part.prompt ?? "";
    maskRotationInput.value = String(Math.round(part.rotation));
    maskRotationValue.textContent = `${Math.round(part.rotation)}°`;
    if (resetScale) {
      maskScaleInput.value = "100";
      maskScaleValue.textContent = "100%";
      maskScaleReferencePart = cloneBodyMaskPart(part);
    }
  }

  function loadMaskEditorForSkin(skin: PetSkinDefinition): void {
    maskEditorParts = cloneBodyMaskParts(getBodyMasksForSkin(skin));
    selectedMaskPartId = maskEditorParts[0]?.id ?? "";
    resizeMaskEditorCanvasForSkin(skin);
    renderMaskPartOptions();
    syncMaskControls();
    drawMaskEditor();
  }

  function moveMaskPart(part: BodyMaskPart, dx: number, dy: number): void {
    part.x += dx;
    part.y += dy;
    part.points = part.points?.map((point) => ({ x: point.x + dx, y: point.y + dy }));
    part.strokes = part.strokes?.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
    }));
  }

  function scaleMaskPartFromSnapshot(part: BodyMaskPart, snapshot: BodyMaskPart, factor: number): void {
    const center = { x: snapshot.x, y: snapshot.y };
    part.x = snapshot.x;
    part.y = snapshot.y;
    part.width = Math.max(1, snapshot.width * factor);
    part.height = Math.max(1, snapshot.height * factor);
    part.points = snapshot.points?.map((point) => ({
      x: center.x + (point.x - center.x) * factor,
      y: center.y + (point.y - center.y) * factor,
    }));
    part.strokes = snapshot.strokes?.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({
        x: center.x + (point.x - center.x) * factor,
        y: center.y + (point.y - center.y) * factor,
      })),
    }));
  }

  function scaleSelectedMaskPart(factor: number): void {
    const part = getSelectedMaskPart();
    if (!part) {
      return;
    }

    scaleMaskPartFromSnapshot(part, cloneBodyMaskPart(part), factor);
    maskScaleReferencePart = cloneBodyMaskPart(part);
    maskScaleInput.value = "100";
    maskScaleValue.textContent = "100%";
    drawMaskEditor();
  }

  function replaceMaskPart(nextPart: BodyMaskPart): void {
    const index = maskEditorParts.findIndex((part) => part.id === nextPart.id);
    if (index >= 0) {
      maskEditorParts[index] = nextPart;
    }
  }

  function findMaskPartForArea(area: string | undefined | null): BodyMaskPart | null {
    const normalizedArea = area?.trim();
    if (!normalizedArea) {
      return null;
    }

    return getBodyMasksForSkin(activeSkin).find((part) => part.label === normalizedArea) ?? null;
  }

  function isNearMaskHandle(part: BodyMaskPart, point: MaskPoint): boolean {
    const handle = getMaskScaleHandle(part);
    return Math.hypot(handle.x - point.x, handle.y - point.y) <= 2.8;
  }

  function finishMaskPointer(): void {
    const part = getSelectedMaskPart();
    if (selectedMaskTool === "lasso" && part && activeLassoPoints.length >= 3) {
      const xs = activeLassoPoints.map((point) => point.x);
      const ys = activeLassoPoints.map((point) => point.y);
      part.shape = "polygon";
      part.points = activeLassoPoints.map((point) => ({ ...point }));
      part.x = (Math.min(...xs) + Math.max(...xs)) / 2;
      part.y = (Math.min(...ys) + Math.max(...ys)) / 2;
      part.width = Math.max(1, Math.max(...xs) - Math.min(...xs));
      part.height = Math.max(1, Math.max(...ys) - Math.min(...ys));
      part.rotation = 0;
      setMaskEditorStatus(`${part.label} 已替换为套索边界，记得保存。`);
    }

    activeMaskPointerId = null;
    activeMaskStroke = null;
    activeLassoPoints = [];
    dragMaskSnapshot = null;
    dragMaskStartPoint = null;
    activeMaskMoveMode = null;
    syncMaskControls();
    drawMaskEditor();
  }

  function beginMaskPointer(event: PointerEvent): void {
    const part = getSelectedMaskPart();
    if (!part || event.button !== 0) {
      return;
    }

    const point = canvasToPercent(event);
    activeMaskPointerId = event.pointerId;
    try {
      maskEditorCanvas.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the WebView cancels the gesture mid-frame.
    }

    event.preventDefault();
    if (selectedMaskTool === "brush" || selectedMaskTool === "eraser") {
      activeMaskStroke = {
        mode: selectedMaskTool === "eraser" ? "erase" : "paint",
        size: Number(maskBrushSizeInput.value),
        points: [point],
      };
      part.strokes = [...(part.strokes ?? []), activeMaskStroke];
      drawMaskEditor();
      return;
    }

    if (selectedMaskTool === "lasso") {
      activeLassoPoints = [point];
      drawMaskEditor();
      return;
    }

    const selectedPart = getSelectedMaskPart();
    if (!selectedPart) {
      return;
    }

    dragMaskSnapshot = cloneBodyMaskPart(selectedPart);
    dragMaskStartPoint = point;
    activeMaskMoveMode = isNearMaskHandle(selectedPart, point) ? "scale" : "move";
    syncMaskControls(false);
    drawMaskEditor();
  }

  function updateMaskPointer(event: PointerEvent): void {
    if (activeMaskPointerId !== event.pointerId) {
      return;
    }

    const point = canvasToPercent(event);
    event.preventDefault();
    if (activeMaskStroke) {
      activeMaskStroke.points.push(point);
      drawMaskEditor();
      return;
    }

    if (selectedMaskTool === "lasso") {
      activeLassoPoints.push(point);
      drawMaskEditor();
      return;
    }

    const part = getSelectedMaskPart();
    if (!part || !dragMaskSnapshot || !dragMaskStartPoint || !activeMaskMoveMode) {
      return;
    }

    const nextPart = cloneBodyMaskPart(dragMaskSnapshot);
    if (activeMaskMoveMode === "scale") {
      const startDistance = Math.max(0.1, Math.hypot(dragMaskStartPoint.x - dragMaskSnapshot.x, dragMaskStartPoint.y - dragMaskSnapshot.y));
      const currentDistance = Math.max(0.1, Math.hypot(point.x - dragMaskSnapshot.x, point.y - dragMaskSnapshot.y));
      scaleMaskPartFromSnapshot(nextPart, dragMaskSnapshot, currentDistance / startDistance);
    } else {
      moveMaskPart(nextPart, point.x - dragMaskStartPoint.x, point.y - dragMaskStartPoint.y);
    }
    replaceMaskPart(nextPart);
    drawMaskEditor();
  }

  function setBaseExpression(expression: BaseExpression): void {
    baseLayer.src = expression === "surprised" ? activeSkin.images.surprised : activeSkin.images.idle;
    baseLayer.dataset.expression = expression;
  }

  function renderSkinButtons(): void {
    skinButtons.replaceChildren();
    const favoriteIds = getFavoritePetSkinIds();
    const favoriteIdSet = new Set(favoriteIds);
    const orderedSkins = [
      ...favoriteIds.map((id) => findPetSkin(id)),
      ...availablePetSkins.filter((skin) => !favoriteIdSet.has(skin.id)),
    ];
    const favoriteGroup = document.createElement("div");
    const extraGroup = document.createElement("div");
    favoriteGroup.className = "skin-switcher__favorites";
    extraGroup.className = "skin-switcher__extras";

    for (const skin of orderedSkins) {
      const button = document.createElement("button");
      button.className = "skin-switcher__btn";
      button.type = "button";
      button.dataset.skin = skin.id;
      button.dataset.skinPriority = favoriteIdSet.has(skin.id) ? "favorite" : "extra";
      button.title = skin.name;
      button.setAttribute("aria-label", `切换皮肤：${skin.name}`);
      button.setAttribute("aria-pressed", String(skin.id === state.selectedSkinId));

      const thumbnail = document.createElement("img");
      thumbnail.src = skin.images.idle;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      button.appendChild(thumbnail);

      button.addEventListener("click", () => {
        setPetSkin(skin.id, { announce: true });
      });
      if (favoriteIdSet.has(skin.id)) {
        favoriteGroup.appendChild(button);
      } else {
        extraGroup.appendChild(button);
      }
    }

    skinButtons.append(favoriteGroup, extraGroup);
    renderSkinPromptOptions();
    renderFavoriteSkinEditor();
    renderSkinDeleteOptions();
  }

  function renderFavoriteSkinEditor(): void {
    skinFavoriteList.replaceChildren();
    const favoriteIds = getFavoritePetSkinIds();
    const favoriteIdSet = new Set(favoriteIds);

    for (const skin of availablePetSkins) {
      const label = document.createElement("label");
      label.className = "skin-favorite-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = favoriteIdSet.has(skin.id);
      checkbox.disabled = !checkbox.checked && favoriteIds.length >= MAX_FAVORITE_SKINS;
      checkbox.addEventListener("change", () => {
        const currentIds = getFavoritePetSkinIds();
        if (checkbox.checked) {
          if (currentIds.length >= MAX_FAVORITE_SKINS) {
            checkbox.checked = false;
            skinFavoriteStatus.textContent = `最多只能常驻 ${MAX_FAVORITE_SKINS} 个皮肤。`;
            return;
          }
          favoritePetSkinIds = [...currentIds, skin.id];
        } else {
          if (currentIds.length <= 1) {
            checkbox.checked = true;
            skinFavoriteStatus.textContent = "至少保留 1 个常用皮肤，侧边栏才不会空掉。";
            return;
          }
          favoritePetSkinIds = currentIds.filter((id) => id !== skin.id);
        }

        favoritePetSkinIds = uniqueAvailableSkinIds(favoritePetSkinIds).slice(0, MAX_FAVORITE_SKINS);
        saveFavoritePetSkins();
        renderSkinButtons();
      });

      const thumbnail = document.createElement("img");
      thumbnail.src = skin.images.idle;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";

      const name = document.createElement("span");
      name.textContent = skin.name;

      label.append(checkbox, thumbnail, name);
      skinFavoriteList.appendChild(label);
    }

    skinFavoriteStatus.textContent = `已选择 ${favoriteIds.length}/${MAX_FAVORITE_SKINS} 个常用皮肤；其余皮肤会在悬停皮肤栏时向左展开。`;
  }

  function renderSkinPromptOptions(): void {
    const previousValue = skinPromptSelect.value || state.selectedSkinId;
    skinPromptSelect.replaceChildren();

    for (const skin of availablePetSkins) {
      const option = document.createElement("option");
      option.value = skin.id;
      option.textContent = skin.name;
      skinPromptSelect.appendChild(option);
    }

    const nextValue = availablePetSkins.some((skin) => skin.id === previousValue)
      ? previousValue
      : state.selectedSkinId;
    skinPromptSelect.value = nextValue;
    loadSkinPromptEditor(nextValue);
  }

  function loadSkinPromptEditor(skinId: string): void {
    const skin = findPetSkin(skinId);
    skinPromptSelect.value = skin.id;
    skinPromptInput.value = getSkinPrompt(skin.id);
    skinPromptStatus.textContent = skinPromptInput.value
      ? `${skin.name} 已有专属设定，LLM 交互会自动带上。`
      : `${skin.name} 目前使用全局提示词。`;
  }

  function renderSkinDeleteOptions(): void {
    skinDeleteSelect.replaceChildren();

    const removableSkins = availablePetSkins.filter((skin) => skin.id !== DEFAULT_PET_SKIN_ID);

    if (removableSkins.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "没有可删除或隐藏的皮肤";
      skinDeleteSelect.appendChild(option);
      skinDeleteButton.disabled = true;
      return;
    }

    for (const skin of removableSkins) {
      const option = document.createElement("option");
      option.value = skin.id;
      option.textContent = isRuntimeCustomSkin(skin.id) ? `${skin.name}（本地文件）` : `${skin.name}（隐藏）`;
      skinDeleteSelect.appendChild(option);
    }

    skinDeleteButton.disabled = false;
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

    setIconButton(
      pinButton,
      state.alwaysOnTop ? quickActionIcons.pinned : quickActionIcons.unpinned,
      state.alwaysOnTop ? "取消置顶" : "重新置顶",
      state.alwaysOnTop,
    );
    setIconButton(
      sceneButton,
      state.sceneMode ? quickActionIcons.transparent : quickActionIcons.scene,
      state.sceneMode ? "切回透明模式" : "开启背景模式",
      state.sceneMode,
    );
    llmModeButton.textContent = state.llmInteractionMode ? "LLM 互动" : "本地互动";
    llmModeButton.setAttribute("aria-pressed", String(state.llmInteractionMode));

    const selectedTool = getInteractionTool(state.selectedInteractionTool);
    interactionToolValue.textContent = selectedTool.label;
    for (const button of getInteractionToolButtons()) {
      button.setAttribute("aria-pressed", String(button.dataset.tool === selectedTool.id));
    }

    const selectedSkin = findPetSkin(state.selectedSkinId);
    skinValue.textContent = selectedSkin.name;
    for (const button of skinButtons.querySelectorAll<HTMLButtonElement>(".skin-switcher__btn[data-skin]")) {
      button.setAttribute("aria-pressed", String(button.dataset.skin === selectedSkin.id));
    }
  }

  function setPetSkin(skinId: string | null | undefined, options: { persist?: boolean; announce?: boolean } = {}): void {
    const previousSkinId = state.selectedSkinId;
    const skin = findPetSkin(skinId);
    state.selectedSkinId = skin.id;
    applySkinVisuals(skin);
    loadMaskEditorForSkin(skin);
    if (!IS_MASK_EDITOR_WINDOW) {
      void applyScale(state.scale, {
        persist: false,
        showBubble: false,
        ensureDocked: state.dockedToCorner,
        forceResize: true,
      });
    }

    if (options.persist ?? true) {
      localStorage.setItem(PET_SKIN_STORAGE_KEY, skin.id);
    }

    updateStatus();
    if (bubble.dataset.show === "true") {
      window.requestAnimationFrame(positionBubble);
    }
    if (!settingsPanel.hidden && (skinPromptSelect.value === previousSkinId || skinPromptSelect.value === skin.id)) {
      loadSkinPromptEditor(skin.id);
    }

    if (options.announce) {
      setBubble(`已换成 ${skin.name}，部位映射使用${skin.layout === "fullBody" ? "全身立绘" : "半身"}版。`, "hint", 2100);
    }
  }

  function setSkinImportStatus(text: string): void {
    skinImportStatus.textContent = text;
  }

  function setSkinImportBusy(busy: boolean, text?: string): void {
    skinAddButton.disabled = busy;
    skinNameInput.disabled = busy;
    skinLayoutSelect.disabled = busy;
    skinTransparentInput.disabled = busy;
    if (text) {
      setSkinImportStatus(text);
    }
  }

  function getSelectedSkinLayout(): PetSkinLayoutId {
    return skinLayoutSelect.value === "fullBody" ? "fullBody" : "halfBody";
  }

  function getFileBaseName(file: File): string {
    return file.name.replace(/\.[^.]+$/, "").trim() || "自定义皮肤";
  }

  function slugifySkinId(value: string): string {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || `custom-skin-${Date.now()}`;
  }

  function upsertCustomSkin(skin: CustomSkinView): PetSkinDefinition {
    const definition = customSkinViewToDefinition(skin);
    customPetSkins = [definition, ...customPetSkins.filter((item) => item.id !== definition.id)];
    syncAvailablePetSkins();
    renderSkinButtons();
    return definition;
  }

  async function loadCustomPetSkins(preferredSkinId?: string | null): Promise<void> {
    try {
      const skins = await invoke<CustomSkinView[]>("list_custom_skins");
      customPetSkins = skins.map(customSkinViewToDefinition);
      syncAvailablePetSkins();
      renderSkinButtons();

      if (preferredSkinId && availablePetSkins.some((skin) => skin.id === preferredSkinId)) {
        setPetSkin(preferredSkinId, { persist: false });
      } else {
        updateStatus();
      }
    } catch (error) {
      console.error(error);
      setSkinImportStatus(`读取自定义皮肤失败：${String(error)}`);
    }
  }

  async function loadImageFileToCanvas(file: File): Promise<HTMLCanvasElement> {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.src = objectUrl;

    try {
      await image.decode();
      const maxEdge = 1800;
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("无法创建图片画布。");
      }

      context.drawImage(image, 0, 0, width, height);
      return canvas;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function transparentizeEdgeBackground(canvas: HTMLCanvasElement, tolerance = 34): number {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || canvas.width === 0 || canvas.height === 0) {
      return 0;
    }

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height } = imageData;
    const baseR = data[0];
    const baseG = data[1];
    const baseB = data[2];
    const threshold = tolerance * tolerance;
    const visited = new Uint8Array(width * height);
    const queue: number[] = [];

    const pushIfBackground = (x: number, y: number): void => {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        return;
      }

      const index = y * width + x;
      if (visited[index]) {
        return;
      }

      const offset = index * 4;
      const dr = data[offset] - baseR;
      const dg = data[offset + 1] - baseG;
      const db = data[offset + 2] - baseB;
      if (data[offset + 3] > 0 && dr * dr + dg * dg + db * db <= threshold) {
        visited[index] = 1;
        queue.push(index);
      }
    };

    for (let x = 0; x < width; x += 1) {
      pushIfBackground(x, 0);
      pushIfBackground(x, height - 1);
    }

    for (let y = 0; y < height; y += 1) {
      pushIfBackground(0, y);
      pushIfBackground(width - 1, y);
    }

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      const x = index % width;
      const y = Math.floor(index / width);
      pushIfBackground(x + 1, y);
      pushIfBackground(x - 1, y);
      pushIfBackground(x, y + 1);
      pushIfBackground(x, y - 1);
    }

    for (const index of queue) {
      data[index * 4 + 3] = 0;
    }

    context.putImageData(imageData, 0, 0);
    return queue.length;
  }

  function createBlankSkinOverlayDataUrl(width: number, height: number): string {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas.toDataURL("image/png");
  }

  async function buildCustomSkinRequest(file: File): Promise<SaveCustomSkinRequest> {
    const name = skinNameInput.value.trim() || getFileBaseName(file);
    const layout = getSelectedSkinLayout();
    const canvas = await loadImageFileToCanvas(file);
    const removedPixels = skinTransparentInput.checked ? transparentizeEdgeBackground(canvas) : 0;
    const idleDataUrl = canvas.toDataURL("image/png");
    const blankOverlay = createBlankSkinOverlayDataUrl(canvas.width, canvas.height);

    setSkinImportStatus(
      skinTransparentInput.checked
        ? `已处理边缘背景 ${removedPixels.toLocaleString("zh-CN")} 像素，正在保存皮肤...`
        : "保留原图背景，正在保存皮肤...",
    );

    return {
      id: `user-${slugifySkinId(name)}`,
      name,
      layout,
      assetWidth: canvas.width,
      assetHeight: canvas.height,
      hitCalibrationY: layout === "halfBody" ? 7.2 : 0,
      images: {
        idleDataUrl,
        surprisedDataUrl: idleDataUrl,
        blinkDataUrl: blankOverlay,
        mouthTalkDataUrl: blankOverlay,
        mouthODataUrl: blankOverlay,
      },
    };
  }

  async function importCustomSkinFile(file: File): Promise<void> {
    if (!file.type.startsWith("image/")) {
      setSkinImportStatus("请选择 PNG、JPEG、WebP 等图片文件。");
      return;
    }

    setSkinImportBusy(true, "正在读取图片并生成皮肤文件...");

    try {
      const request = await buildCustomSkinRequest(file);
      const savedSkin = await invoke<CustomSkinView>("save_custom_skin", { request });
      const skin = upsertCustomSkin(savedSkin);
      setPetSkin(skin.id, { announce: true });
      skinNameInput.value = "";
      setSkinImportStatus(`已添加 ${skin.name}，以后启动也会保留。`);
    } catch (error) {
      console.error(error);
      setSkinImportStatus(`添加失败：${String(error)}`);
    } finally {
      skinFileInput.value = "";
      setSkinImportBusy(false);
    }
  }

  function saveSelectedSkinPrompt(): void {
    const skin = findPetSkin(skinPromptSelect.value);
    const prompt = skinPromptInput.value.trim();

    if (prompt) {
      skinPromptOverrides = { ...skinPromptOverrides, [skin.id]: prompt };
      skinPromptStatus.textContent = `${skin.name} 的专属设定已保存。`;
    } else {
      const { [skin.id]: _removed, ...rest } = skinPromptOverrides;
      skinPromptOverrides = rest;
      skinPromptStatus.textContent = `${skin.name} 已恢复为全局提示词。`;
    }

    saveSkinPromptOverrides();
    setBubble(`${skin.name} 的性格设定已更新。`, "hint", 1700);
  }

  function clearSelectedSkinPrompt(): void {
    const skin = findPetSkin(skinPromptSelect.value);
    const { [skin.id]: _removed, ...rest } = skinPromptOverrides;
    skinPromptOverrides = rest;
    skinPromptInput.value = "";
    saveSkinPromptOverrides();
    skinPromptStatus.textContent = `${skin.name} 已清空专属设定，会使用全局提示词。`;
  }

  async function deleteSelectedCustomSkin(): Promise<void> {
    const skinId = skinDeleteSelect.value;
    if (!skinId) {
      setSkinImportStatus("没有选中的皮肤。");
      return;
    }

    const skin = availablePetSkins.find((item) => item.id === skinId);
    const skinName = skin?.name ?? skinId;
    const wasRuntimeCustomSkin = isRuntimeCustomSkin(skinId);

    try {
      skinDeleteButton.disabled = true;
      if (wasRuntimeCustomSkin) {
        await invoke("delete_custom_skin", { id: skinId });
        customPetSkins = customPetSkins.filter((item) => item.id !== skinId);
      } else {
        hiddenPetSkinIds.add(skinId);
        saveHiddenPetSkins();
      }

      const { [skinId]: _removedPrompt, ...restPrompts } = skinPromptOverrides;
      skinPromptOverrides = restPrompts;
      saveSkinPromptOverrides();
      favoritePetSkinIds = favoritePetSkinIds.filter((id) => id !== skinId);
      syncAvailablePetSkins();
      if (uniqueAvailableSkinIds(favoritePetSkinIds).length === 0 && availablePetSkins.length > 0) {
        favoritePetSkinIds = [availablePetSkins[0].id];
      }
      saveFavoritePetSkins();
      renderSkinButtons();

      if (state.selectedSkinId === skinId) {
        setPetSkin(DEFAULT_PET_SKIN_ID, { announce: true });
      } else {
        updateStatus();
      }

      setSkinImportStatus(wasRuntimeCustomSkin ? `已删除 ${skinName}。` : `已隐藏 ${skinName}。`);
    } catch (error) {
      console.error(error);
      setSkinImportStatus(`删除失败：${String(error)}`);
    } finally {
      renderSkinPromptOptions();
      renderSkinDeleteOptions();
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

  function setVoiceStatus(text: string, tone: Tone | "idle" = "idle"): void {
    voiceStatus.textContent = text;
    voiceStatus.dataset.tone = tone;
  }

  function syncVoiceControls(): void {
    voiceEnabledInput.checked = state.voiceEnabled;
    voiceLanguageSelect.value = voiceLanguage;
    voiceSensitivityInput.value = String(voiceSensitivity);
    voiceSensitivityValue.textContent = String(voiceSensitivity);
    const threshold = Math.round(getVoiceConfidenceThreshold(voiceSensitivity) * 100);
    voiceRestartButton.disabled = !state.voiceEnabled;

    if (!getSpeechRecognitionConstructor()) {
      voiceEnabledInput.disabled = true;
      voiceTestButton.disabled = true;
      voiceRestartButton.disabled = true;
      setVoiceStatus("当前 WebView 不支持系统语音识别。可以更新 WebView2，或之后接入外部 STT API。", "alert");
      return;
    }

    voiceEnabledInput.disabled = false;
    voiceTestButton.disabled = false;
    if (!state.voiceEnabled) {
      setVoiceStatus(`语音识别未开启。当前灵敏度 ${voiceSensitivity}，短句置信度阈值约 ${threshold}%；较完整文本会优先采用。`, "idle");
    }
  }

  function stopVoiceRecognition(options: { persist?: boolean; announce?: boolean } = {}): void {
    state.voiceEnabled = false;
    voiceIntentionalStop = true;
    voiceRecognitionId += 1;
    clearTimer(voiceRestartTimer);
    voiceRestartTimer = undefined;

    if (options.persist ?? true) {
      localStorage.setItem(VOICE_ENABLED_STORAGE_KEY, "0");
    }

    try {
      voiceRecognition?.stop();
    } catch (error) {
      console.warn("Failed to stop voice recognition:", error);
    }

    syncVoiceControls();
    if (options.announce) {
      setBubble("语音监听已关闭。", "hint", 1400);
    }
  }

  function handleVoiceResult(event: SpeechRecognitionEventLike): void {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results.item(index);
      if (!result.isFinal || result.length === 0) {
        continue;
      }

      const alternative = result.item(0);
      const transcript = alternative.transcript.trim();
      const confidence = Number.isFinite(alternative.confidence) ? alternative.confidence : 1;
      if (!transcript) {
        continue;
      }

      if (!shouldAcceptVoiceTranscript(transcript, confidence, voiceSensitivity)) {
        setVoiceStatus(
          `听到了“${transcript}”，但它太短且置信度偏低，已忽略。可以调高灵敏度或说完整一点。`,
          "hint",
        );
        setBubble("我听见了一点，但不太确定。", "hint", 1600);
        continue;
      }

      setVoiceStatus(`识别到：${transcript}（置信度 ${Math.round(confidence * 100)}%）`, "warm");
      void runLlmInteraction("voice", "语音命令", undefined, transcript);
    }
  }

  function createVoiceRecognition(recognitionId: number): SpeechRecognitionLike | null {
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      return null;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = voiceLanguage;
    recognition.onaudiostart = () => {
      setVoiceStatus("麦克风已连接，正在听语音命令。", "warm");
    };
    recognition.onspeechstart = () => {
      setVoiceStatus("听到声音了，正在识别...", "warm");
    };
    recognition.onspeechend = () => {
      setVoiceStatus("一句话结束了，等待识别结果...", "idle");
    };
    recognition.onresult = (event) => {
      if (recognitionId === voiceRecognitionId) {
        handleVoiceResult(event);
      }
    };
    recognition.onerror = (event) => {
      if (recognitionId !== voiceRecognitionId) {
        return;
      }

      const message =
        event.error === "not-allowed"
          ? "麦克风权限被拒绝，请在系统或 WebView 权限里允许麦克风。"
          : `语音识别出错：${event.error}${event.message ? `，${event.message}` : ""}`;
      setVoiceStatus(message, "alert");
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        stopVoiceRecognition({ announce: true });
      }
    };
    recognition.onend = () => {
      if (recognitionId !== voiceRecognitionId) {
        return;
      }

      voiceRecognition = null;
      if (!state.voiceEnabled || voiceIntentionalStop) {
        return;
      }

      setVoiceStatus("语音监听短暂断开，正在自动重连...", "idle");
      voiceRestartTimer = window.setTimeout(() => {
        void startVoiceRecognition({ announce: false });
      }, 700);
    };

    return recognition;
  }

  async function requestMicrophonePermission(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  async function startVoiceRecognition(options: { persist?: boolean; announce?: boolean } = {}): Promise<void> {
    if (!getSpeechRecognitionConstructor()) {
      syncVoiceControls();
      setBubble("当前环境不支持语音识别。", "alert", 2200);
      return;
    }

    state.voiceEnabled = true;
    voiceIntentionalStop = false;
    clearTimer(voiceRestartTimer);
    voiceRestartTimer = undefined;

    if (options.persist ?? true) {
      localStorage.setItem(VOICE_ENABLED_STORAGE_KEY, "1");
    }

    try {
      await requestMicrophonePermission();
      const previousRecognition = voiceRecognition;
      const recognitionId = ++voiceRecognitionId;
      previousRecognition?.abort();
      voiceRecognition = createVoiceRecognition(recognitionId);
      voiceRecognition?.start();
      syncVoiceControls();
      setVoiceStatus("语音监听已开启，说话会自动交给 LLM 互动。", "warm");
      if (options.announce) {
        setBubble("语音监听开启啦，你可以直接说命令。", "hint", 1900);
      }
    } catch (error) {
      console.error(error);
      state.voiceEnabled = false;
      localStorage.setItem(VOICE_ENABLED_STORAGE_KEY, "0");
      syncVoiceControls();
      setVoiceStatus(`麦克风启动失败：${String(error)}`, "alert");
      setBubble("麦克风没有接上，检查一下权限。", "alert", 2200);
    }
  }

  function restartVoiceRecognition(): void {
    if (!state.voiceEnabled) {
      return;
    }

    voiceIntentionalStop = true;
    voiceRecognitionId += 1;
    try {
      voiceRecognition?.abort();
    } catch (error) {
      console.warn("Failed to restart voice recognition:", error);
    }
    voiceRecognition = null;
    window.setTimeout(() => {
      void startVoiceRecognition({ persist: false, announce: false });
    }, 180);
  }

  function setInteractionTool(toolId: string | null | undefined, options: { persist?: boolean; announce?: boolean } = {}): void {
    const tool = getInteractionTool(toolId);
    state.selectedInteractionTool = tool.id;
    petApp.dataset.interactionTool = tool.id;

    if (options.persist ?? true) {
      localStorage.setItem(INTERACTION_TOOL_STORAGE_KEY, tool.id);
    }

    updateStatus();

    if (options.announce) {
      setBubble(`已切换为${tool.label}，接下来会用它${tool.verb}桌宠。`, "hint", 1700);
    }
  }

  function positionBubble(): void {
    const appHeight = petApp.offsetHeight;
    const appWidth = petApp.offsetWidth;
    const petTop = petStage.offsetTop + petFrame.offsetTop + petRoot.offsetTop;
    const petLeft = petStage.offsetLeft + petFrame.offsetLeft + petRoot.offsetLeft;
    const bubbleWidth = bubble.offsetWidth || 310;
    const bubbleHeight = bubble.offsetHeight || 58;
    const anchorRatio = activeSkin.layout === "fullBody" ? 0.1 : 0.11;
    const anchorY = petTop + petRoot.offsetHeight * anchorRatio;
    const top = Math.min(Math.max(12, anchorY - bubbleHeight - 10), Math.max(12, appHeight - bubbleHeight - 18));
    const left = Math.min(Math.max(bubbleWidth / 2 + 10, petLeft + petRoot.offsetWidth / 2), appWidth - bubbleWidth / 2 - 10);

    bubble.style.setProperty("--bubble-top", `${Math.round(top)}px`);
    bubble.style.setProperty("--bubble-left", `${Math.round(left)}px`);
  }

  function setBubble(text: string, tone: Tone = "warm", duration = 2200): void {
    clearTimer(state.bubbleTimeout);
    bubble.dataset.show = "true";
    bubble.dataset.tone = tone;
    bubble.textContent = text;
    window.requestAnimationFrame(positionBubble);
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
    const skin = findPetSkin(state.selectedSkinId);
    const skinPrompt = getSkinPrompt(skin.id);
    const skinPromptText = skinPrompt
      ? `\n当前皮肤：${skin.name}。\n皮肤专属设定：${skinPrompt}`
      : `\n当前皮肤：${skin.name}。`;

    return [
      {
        role: "system",
        content: `${PET_LLM_SYSTEM_PROMPT}${skinPromptText}`,
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
    if (IS_MASK_EDITOR_WINDOW) {
      settingsPanel.hidden = false;
      settingsPanel.dataset.show = "true";
      setSettingsTab("mask");
      return;
    }

    settingsPanel.hidden = false;
    settingsPanel.dataset.show = "true";
    renderSkinPromptOptions();
    renderSkinDeleteOptions();
    syncInteractionToolEditor();
    syncVoiceControls();
    void loadLlmSettings();
  }

  function closeSettings(): void {
    if (IS_MASK_EDITOR_WINDOW) {
      void closePet();
      return;
    }

    settingsPanel.dataset.show = "false";
    window.setTimeout(() => {
      if (settingsPanel.dataset.show !== "true") {
        settingsPanel.hidden = true;
      }
    }, 180);
  }

  function setSettingsTab(tab: string): void {
    settingsPanel.dataset.activeTab = tab;
    for (const button of settingsTabButtons) {
      button.setAttribute("aria-selected", String(button.dataset.settingsTab === tab));
    }

    for (const section of settingsSections) {
      section.hidden = section.dataset.settingsSection !== tab;
    }
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
    const renderedImageHeight = renderedImageWidth * (activeSkin.assetHeight / activeSkin.assetWidth);
    const imageLeft = petRect.left;
    const imageTop = petRect.bottom - renderedImageHeight;

    const xPercent = Math.min(100, Math.max(0, ((event.clientX - imageLeft) / renderedImageWidth) * 100));
    const rawYPercent = ((event.clientY - imageTop) / renderedImageHeight) * 100;
    const yPercent = Math.min(100, Math.max(0, rawYPercent + (activeSkin.hitCalibrationY ?? 0)));
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
    const matchedMask = getBodyMasksForHitTesting(activeSkin).find((part) => isPointInBodyMaskPart(position, part));
    if (matchedMask) {
      return matchedMask.label;
    }

    const matchedRule = getHitAreaRules(activeSkin).find((rule) => isPointInHitRule(position, rule));
    return matchedRule?.label ?? fallback;
  }

  function resolvePetActionZone(event: MouseEvent, fallback: string | undefined): "head" | "body" {
    const areaLabel = resolvePetHitArea(event, fallback === "head" ? "头部" : "身体");
    const headKeywords = ["头", "脸", "眼", "鼻", "嘴", "耳", "发", "刘海", "呆毛"];
    return headKeywords.some((keyword) => areaLabel.includes(keyword)) ? "head" : "body";
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

    if (source === "voice") {
      return "语音命令";
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
    window.requestAnimationFrame(positionBubble);

    state.bubbleTimeout = window.setInterval(() => {
      if (requestId !== llmRequestId) {
        clearTimer(state.bubbleTimeout);
        return;
      }

      dotCount = dotCount >= 6 ? 1 : dotCount + 1;
      bubble.textContent = "·".repeat(dotCount);
      positionBubble();
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
    window.requestAnimationFrame(positionBubble);
    updateStatus();
  }

  function updateStreamingTalking(text: string): void {
    bubble.dataset.show = "true";
    bubble.dataset.tone = "warm";
    bubble.textContent = text || "·";
    window.requestAnimationFrame(positionBubble);
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
    const interactionTool = source === "click" ? `${selectedTool.label}（${selectedTool.verb}）` : null;
    const skin = findPetSkin(state.selectedSkinId);
    const interactionToolPrompt = selectedTool.prompt?.trim();
    const interactionToolPromptText = source === "click"
      ? [
          `当前互动控件「${selectedTool.label}」的互动方式：${selectedTool.verb}`,
          interactionToolPrompt ? `控件专属提示：${interactionToolPrompt}` : "",
        ].filter(Boolean).join("。")
      : "";
    const bodyMaskPart = findMaskPartForArea(area);
    const bodyMaskPrompt = bodyMaskPart?.prompt?.trim();
    const bodyMaskPromptText = bodyMaskPart && bodyMaskPrompt
      ? `当前互动部位「${bodyMaskPart.label}」的专属提示：${bodyMaskPrompt}`
      : "";
    const mergedSkinPrompt = [getSkinPrompt(skin.id), interactionToolPromptText, bodyMaskPromptText]
      .filter(Boolean)
      .join("\n");
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
          skinId: skin.id,
          skinName: skin.name,
          skinPrompt: mergedSkinPrompt || null,
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
    if (floatingKeepOpenInput.checked) {
      floatingInputHint.textContent = "保持打开中，可以继续输入下一句。";
      window.setTimeout(() => {
        floatingTextInput.focus();
      }, 0);
    } else {
      closeFloatingInput();
    }

    await runLlmInteraction("shortcut", "悬浮输入框", undefined, text);

    if (floatingKeepOpenInput.checked) {
      window.setTimeout(() => {
        floatingTextInput.focus();
      }, 0);
    }
  }

  async function applyScale(nextScale: number, options: ApplyScaleOptions = {}): Promise<void> {
    const persist = options.persist ?? true;
    const showBubble = options.showBubble ?? true;
    const ensureDocked = options.ensureDocked ?? false;
    const forceResize = options.forceResize ?? false;
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
      if (scaleChanged || forceResize) {
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

  function clearPendingInteractiveDrag(): void {
    clearTimer(pendingInteractiveDrag?.timer);
    pendingInteractiveDrag = null;
  }

  async function moveInteractiveDragTo(screenX: number, screenY: number): Promise<void> {
    const drag = pendingInteractiveDrag;
    if (!drag?.dragging || drag.windowX === undefined || drag.windowY === undefined) {
      return;
    }

    const x = drag.windowX + screenX - drag.startScreenX;
    const y = drag.windowY + screenY - drag.startScreenY;
    await movePetWindow(x, y);
  }

  async function beginInteractiveDrag(event?: PointerEvent): Promise<void> {
    if (!pendingInteractiveDrag || pendingInteractiveDrag.dragging) {
      return;
    }

    const drag = pendingInteractiveDrag;
    drag.dragging = true;
    suppressNextHitboxClick = true;
    state.dockedToCorner = false;
    clearTimer(drag.timer);
    if (event) {
      drag.currentScreenX = event.screenX;
      drag.currentScreenY = event.screenY;
    }
    event?.preventDefault();

    try {
      const position = await getPetWindowPosition();
      if (pendingInteractiveDrag !== drag) {
        return;
      }
      drag.windowX = position.x;
      drag.windowY = position.y;
      await moveInteractiveDragTo(drag.currentScreenX, drag.currentScreenY);
    } catch (error) {
      console.error(error);
      clearPendingInteractiveDrag();
      setBubble("拖动暂时失败了。", "alert", 1800);
    }
  }

  function startInteractiveDragGesture(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }

    clearPendingInteractiveDrag();
    pendingInteractiveDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      currentScreenX: event.screenX,
      currentScreenY: event.screenY,
      dragging: false,
    };

    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Some WebView elements may decline capture; movement tracking still works while hovered.
    }

    pendingInteractiveDrag.timer = window.setTimeout(() => {
      void beginInteractiveDrag();
    }, INTERACTIVE_DRAG_DELAY_MS);
  }

  function updateInteractiveDragGesture(event: PointerEvent): void {
    if (!pendingInteractiveDrag || pendingInteractiveDrag.pointerId !== event.pointerId) {
      return;
    }

    pendingInteractiveDrag.currentScreenX = event.screenX;
    pendingInteractiveDrag.currentScreenY = event.screenY;

    if (pendingInteractiveDrag.dragging) {
      event.preventDefault();
      void moveInteractiveDragTo(event.screenX, event.screenY).catch((error) => {
        console.error(error);
      });
      return;
    }

    const distance = Math.hypot(event.clientX - pendingInteractiveDrag.startX, event.clientY - pendingInteractiveDrag.startY);
    if (distance >= INTERACTIVE_DRAG_DISTANCE_PX) {
      void beginInteractiveDrag(event);
    }
  }

  function finishInteractiveDragGesture(event: PointerEvent): void {
    if (!pendingInteractiveDrag || pendingInteractiveDrag.pointerId !== event.pointerId) {
      return;
    }

    clearPendingInteractiveDrag();
  }

  function startImmediateWindowDrag(event: PointerEvent): void {
    startInteractiveDragGesture(event);
    void beginInteractiveDrag(event);
  }

  function trackWindowDragTarget(element: HTMLElement): void {
    element.addEventListener("pointermove", updateInteractiveDragGesture);
    element.addEventListener("pointerup", finishInteractiveDragGesture);
    element.addEventListener("pointercancel", finishInteractiveDragGesture);
    element.addEventListener("lostpointercapture", () => {
      clearPendingInteractiveDrag();
    });
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
    button.addEventListener("pointerdown", startInteractiveDragGesture);
    trackWindowDragTarget(button);
    button.addEventListener("click", (event) => {
      if (suppressNextHitboxClick) {
        suppressNextHitboxClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (resolvePetActionZone(event, button.dataset.area) === "head") {
        reactToHead(event);
      } else {
        reactToBody(event);
      }
    });
  });

  petRoot.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target !== petRoot) {
      return;
    }
    event.preventDefault();
    startImmediateWindowDrag(event);
  });
  trackWindowDragTarget(petRoot);

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
      startImmediateWindowDrag(event);
    }
  });
  trackWindowDragTarget(petFrame);

  petRoot.addEventListener("contextmenu", (event) => {
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

  for (const button of settingsTabButtons) {
    button.addEventListener("click", () => {
      setSettingsTab(button.dataset.settingsTab ?? "llm");
    });
  }

  for (const button of maskToolButtons) {
    button.addEventListener("click", () => {
      const nextTool = button.dataset.maskTool;
      if (nextTool === "move" || nextTool === "brush" || nextTool === "lasso" || nextTool === "eraser") {
        selectedMaskTool = nextTool;
        syncMaskToolButtons();
        setMaskEditorStatus(`已切换到${button.textContent ?? "工具"}工具。`);
      }
    });
  }

  maskPartSelect.addEventListener("change", () => {
    selectedMaskPartId = maskPartSelect.value;
    syncMaskControls();
    renderMaskPartOptions();
    drawMaskEditor();
  });

  maskPartNameInput.addEventListener("input", () => {
    const part = getSelectedMaskPart();
    if (!part) {
      return;
    }
    part.label = maskPartNameInput.value.trim() || "未命名部位";
    renderMaskPartOptions();
    maskPartSelect.value = part.id;
    setMaskEditorStatus("部位名称已更新，记得保存蒙版。");
    drawMaskEditor();
  });

  maskPartPromptInput.addEventListener("input", () => {
    const part = getSelectedMaskPart();
    if (!part) {
      return;
    }
    part.prompt = maskPartPromptInput.value.trim();
    setMaskEditorStatus("部位提示词已更新，记得保存蒙版。");
  });

  maskBrushSizeInput.addEventListener("input", () => {
    syncMaskControls(false);
  });

  maskScaleInput.addEventListener("input", () => {
    const part = getSelectedMaskPart();
    if (!part || !maskScaleReferencePart) {
      return;
    }
    scaleMaskPartFromSnapshot(part, maskScaleReferencePart, Number(maskScaleInput.value) / 100);
    maskScaleValue.textContent = `${maskScaleInput.value}%`;
    drawMaskEditor();
  });

  maskScaleInput.addEventListener("change", () => {
    const part = getSelectedMaskPart();
    if (part) {
      maskScaleReferencePart = cloneBodyMaskPart(part);
      maskScaleInput.value = "100";
      maskScaleValue.textContent = "100%";
    }
  });

  maskRotationInput.addEventListener("input", () => {
    const part = getSelectedMaskPart();
    if (!part) {
      return;
    }
    part.rotation = Number(maskRotationInput.value);
    maskRotationValue.textContent = `${maskRotationInput.value}°`;
    drawMaskEditor();
  });

  maskEditorCanvas.addEventListener("pointerdown", beginMaskPointer);
  maskEditorCanvas.addEventListener("pointermove", updateMaskPointer);
  maskEditorCanvas.addEventListener("pointerup", finishMaskPointer);
  maskEditorCanvas.addEventListener("pointercancel", finishMaskPointer);
  maskEditorCanvas.addEventListener("lostpointercapture", finishMaskPointer);
  maskEditorCanvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    scaleSelectedMaskPart(factor);
    const part = getSelectedMaskPart();
    setMaskEditorStatus(part ? `${part.label} 已通过滚轮缩放。` : "请选择一个部位蒙版。");
  }, { passive: false });
  baseLayer.addEventListener("load", drawMaskEditor);

  maskSaveButton.addEventListener("click", () => {
    bodyMaskOverrides[activeSkin.id] = cloneBodyMaskParts(maskEditorParts);
    saveBodyMaskOverrides();
    setMaskEditorStatus(`${activeSkin.name} 的部位蒙版已保存。`);
  });

  maskAddPartButton.addEventListener("click", () => {
    const id = `custom-${Date.now().toString(36)}`;
    const newPart: BodyMaskPart = {
      id,
      label: `新部位 ${maskEditorParts.length + 1}`,
      prompt: "",
      shape: "ellipse",
      x: 50,
      y: 50,
      width: 18,
      height: 14,
      rotation: 0,
    };
    maskEditorParts.push(newPart);
    selectedMaskPartId = id;
    renderMaskPartOptions();
    syncMaskControls();
    drawMaskEditor();
    setMaskEditorStatus("已添加新部位，调整后保存即可用于命中和 LLM。");
  });

  maskDeletePartButton.addEventListener("click", () => {
    if (maskEditorParts.length <= 1) {
      setMaskEditorStatus("至少保留一个部位蒙版。");
      return;
    }
    const index = maskEditorParts.findIndex((part) => part.id === selectedMaskPartId);
    if (index < 0) {
      return;
    }
    const [removed] = maskEditorParts.splice(index, 1);
    selectedMaskPartId = maskEditorParts[Math.min(index, maskEditorParts.length - 1)]?.id ?? "";
    renderMaskPartOptions();
    syncMaskControls();
    drawMaskEditor();
    setMaskEditorStatus(`${removed.label} 已删除，记得保存蒙版。`);
  });

  maskLayerUpButton.addEventListener("click", () => {
    const index = maskEditorParts.findIndex((part) => part.id === selectedMaskPartId);
    if (index < 0 || index >= maskEditorParts.length - 1) {
      setMaskEditorStatus("当前部位已经在最上层。");
      return;
    }
    [maskEditorParts[index], maskEditorParts[index + 1]] = [maskEditorParts[index + 1], maskEditorParts[index]];
    markMaskEditorLayerOrderExplicit();
    renderMaskPartOptions();
    drawMaskEditor();
    setMaskEditorStatus("当前部位已上移一层，重叠命中会更优先。");
  });

  maskLayerDownButton.addEventListener("click", () => {
    const index = maskEditorParts.findIndex((part) => part.id === selectedMaskPartId);
    if (index <= 0) {
      setMaskEditorStatus("当前部位已经在最下层。");
      return;
    }
    [maskEditorParts[index], maskEditorParts[index - 1]] = [maskEditorParts[index - 1], maskEditorParts[index]];
    markMaskEditorLayerOrderExplicit();
    renderMaskPartOptions();
    drawMaskEditor();
    setMaskEditorStatus("当前部位已下移一层。");
  });

  maskResetPartButton.addEventListener("click", () => {
    const part = getSelectedMaskPart();
    if (!part) {
      return;
    }
    const defaultPart = buildDefaultBodyMasks(activeSkin).find((candidate) => candidate.id === part.id);
    if (defaultPart) {
      replaceMaskPart(cloneBodyMaskPart(defaultPart));
      setMaskEditorStatus(`${defaultPart.label} 已恢复为自动推测边界。`);
      syncMaskControls();
      drawMaskEditor();
    }
  });

  maskResetAllButton.addEventListener("click", () => {
    maskEditorParts = buildDefaultBodyMasks(activeSkin);
    selectedMaskPartId = maskEditorParts[0]?.id ?? "";
    delete bodyMaskOverrides[activeSkin.id];
    saveBodyMaskOverrides();
    renderMaskPartOptions();
    syncMaskControls();
    drawMaskEditor();
    setMaskEditorStatus(`${activeSkin.name} 的自定义蒙版已清空。`);
  });

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveLlmSettings();
  });

  settingsTestButton.addEventListener("click", () => {
    void testLlmSettings();
  });

  voiceEnabledInput.addEventListener("change", () => {
    if (voiceEnabledInput.checked) {
      void startVoiceRecognition({ announce: true });
    } else {
      stopVoiceRecognition({ announce: true });
    }
  });

  voiceLanguageSelect.addEventListener("change", () => {
    voiceLanguage = voiceLanguageSelect.value || "zh-CN";
    localStorage.setItem(VOICE_LANGUAGE_STORAGE_KEY, voiceLanguage);
    setVoiceStatus(`识别语言已切换为 ${voiceLanguage}。`, "idle");
    restartVoiceRecognition();
  });

  voiceSensitivityInput.addEventListener("input", () => {
    voiceSensitivity = clampVoiceSensitivity(Number(voiceSensitivityInput.value));
    localStorage.setItem(VOICE_SENSITIVITY_STORAGE_KEY, String(voiceSensitivity));
    syncVoiceControls();
  });

  voiceTestButton.addEventListener("click", () => {
    void requestMicrophonePermission()
      .then(() => {
        setVoiceStatus("麦克风权限正常，可以开启语音命令。", "warm");
        setBubble("麦克风能听见啦。", "hint", 1500);
      })
      .catch((error) => {
        console.error(error);
        setVoiceStatus(`麦克风测试失败：${String(error)}`, "alert");
      });
  });

  voiceRestartButton.addEventListener("click", () => {
    restartVoiceRecognition();
    setVoiceStatus("正在重启语音监听...", "idle");
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

  interactionToolEditorSelect.addEventListener("change", () => {
    loadInteractionToolEditor(interactionToolEditorSelect.value);
  });

  interactionToolSaveButton.addEventListener("click", () => {
    saveSelectedInteractionToolEditor();
  });

  interactionToolAddButton.addEventListener("click", () => {
    addInteractionTool();
  });

  interactionToolDeleteButton.addEventListener("click", () => {
    deleteSelectedInteractionTool();
  });

  interactionToolResetButton.addEventListener("click", () => {
    resetInteractionTools();
  });

  skinAddButton.addEventListener("click", () => {
    skinFileInput.click();
  });

  skinFileInput.addEventListener("change", () => {
    const file = skinFileInput.files?.[0];
    if (file) {
      void importCustomSkinFile(file);
    }
  });

  skinPromptSelect.addEventListener("change", () => {
    loadSkinPromptEditor(skinPromptSelect.value);
  });

  skinPromptSaveButton.addEventListener("click", () => {
    saveSelectedSkinPrompt();
  });

  skinPromptClearButton.addEventListener("click", () => {
    clearSelectedSkinPrompt();
  });

  skinDeleteButton.addEventListener("click", () => {
    void deleteSelectedCustomSkin();
  });

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
      if (target.closest(".side-dock")) {
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

  openMaskEditorButton.addEventListener("click", () => {
    void openMaskEditorWindow().catch((error) => {
      console.error(error);
      setBubble("蒙版编辑器打开失败了。", "alert", 1800);
    });
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

  setIconButton(chatButton, quickActionIcons.chat, "聊天");
  setIconButton(historyButton, quickActionIcons.history, "历史");
  renderInteractionToolButtons();
  syncInteractionToolEditor();
  syncAvailablePetSkins();
  renderSkinButtons();
  setSettingsTab(IS_MASK_EDITOR_WINDOW ? "mask" : "llm");
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
  const savedSkin = localStorage.getItem(PET_SKIN_STORAGE_KEY);
  const savedVoiceEnabled = localStorage.getItem(VOICE_ENABLED_STORAGE_KEY) === "1";

  setPetSkin(savedSkin, { persist: false });
  setSceneMode(savedSceneMode, { persist: false });
  setLlmInteractionMode(savedLlmInteractionMode, { persist: false });
  setInteractionTool(savedInteractionTool, { persist: false });
  state.voiceEnabled = savedVoiceEnabled;
  syncVoiceControls();
  if (savedVoiceEnabled && !IS_MASK_EDITOR_WINDOW) {
    void startVoiceRecognition({ persist: false, announce: false });
  }
  if (IS_MASK_EDITOR_WINDOW) {
    settingsPanel.hidden = false;
    settingsPanel.dataset.show = "true";
    loadMaskEditorForSkin(findPetSkin(savedSkin));
  } else {
    void applyScale(savedScale, { persist: false, showBubble: false, ensureDocked: true });
  }
  void loadCustomPetSkins(savedSkin);

  if (!IS_MASK_EDITOR_WINDOW) {
    void listen("pet-open-input", () => {
      openFloatingInput();
    });
  }

  if (!IS_MASK_EDITOR_WINDOW) {
    setBubble("可以拖动我，也可以用滚轮或 +/- 调整大小。", "hint", 3400);
    scheduleBlink();
    startIdleChatter();
  }
});
