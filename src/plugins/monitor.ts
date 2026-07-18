import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

const CONFIG_STORAGE_KEY = "silver-pet.monitor-plugin.v1";
const DEFAULT_MONITOR_URL = "http://192.168.50.13:8012";
const MAX_SEEN_EVENT_IDS = 500;

export type MonitorConnectionState =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface MonitorPluginConfig {
  enabled: boolean;
  baseUrl: string;
  token: string;
  desktopNotifications: boolean;
}

export interface MonitorEvent {
  id: number;
  event_type: string;
  subject_uid: number;
  target_uid?: number | null;
  entity_type: string;
  entity_id: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  detected_at: string;
}

export interface MonitorStatus {
  state: MonitorConnectionState;
  message: string;
  retryInSeconds?: number;
}

interface MonitorStatusResponse {
  protocolVersion: number;
  service: string;
  status: string;
}

interface MonitorEventsResponse {
  protocolVersion: number;
  events: MonitorEvent[];
}

interface MonitorSocketMessage {
  type: string;
  protocolVersion?: number;
  event?: MonitorEvent;
}

interface MonitorPluginCallbacks {
  onStatus: (status: MonitorStatus) => void;
  onEvent: (event: MonitorEvent) => void;
}

const DEFAULT_CONFIG: MonitorPluginConfig = {
  enabled: false,
  baseUrl: DEFAULT_MONITOR_URL,
  token: "",
  desktopNotifications: true,
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseStoredConfig(value: string | null): MonitorPluginConfig {
  if (!value) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const parsed = JSON.parse(value) as Partial<MonitorPluginConfig>;
    return {
      enabled: parsed.enabled === true,
      baseUrl: normalizeBaseUrl(parsed.baseUrl || DEFAULT_CONFIG.baseUrl),
      token: typeof parsed.token === "string" ? parsed.token.trim() : "",
      desktopNotifications: parsed.desktopNotifications !== false,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function toSocketUrl(baseUrl: string): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/plugin/v1/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function eventMessage(event: MonitorEvent): string {
  const summary = event.summary.trim();
  return summary && summary !== event.title ? `${event.title}：${summary}` : event.title;
}

export class MonitorPlugin {
  private config = parseStoredConfig(localStorage.getItem(CONFIG_STORAGE_KEY));
  private socket: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private reconnectAttempts = 0;
  private generation = 0;
  private seenEventIds = new Set<number>();
  private seenEventOrder: number[] = [];

  constructor(private readonly callbacks: MonitorPluginCallbacks) {}

  getConfig(): MonitorPluginConfig {
    return { ...this.config };
  }

  async saveConfig(config: MonitorPluginConfig): Promise<void> {
    this.config = {
      enabled: config.enabled,
      baseUrl: normalizeBaseUrl(config.baseUrl),
      token: config.token.trim(),
      desktopNotifications: config.desktopNotifications,
    };
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config));

    if (this.config.enabled && this.config.desktopNotifications) {
      await this.ensureNotificationPermission();
    }
    await this.start();
  }

  async start(): Promise<void> {
    this.stopConnection();
    if (!this.config.enabled) {
      this.callbacks.onStatus({ state: "disabled", message: "监控插件未启用" });
      return;
    }
    if (!this.config.baseUrl || !this.config.token) {
      this.callbacks.onStatus({
        state: "error",
        message: "请填写服务地址和配对令牌",
      });
      return;
    }

    await this.connect(this.generation);
  }

  stop(): void {
    this.config.enabled = false;
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config));
    this.stopConnection();
    this.callbacks.onStatus({ state: "disabled", message: "监控插件未启用" });
  }

  destroy(): void {
    this.stopConnection();
  }

  async testConnection(config = this.config): Promise<MonitorStatusResponse> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/api/plugin/v1/status`, {
        headers: {
          "X-DGates-Token": config.token.trim(),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await this.describeHttpError(response));
      }
      const body = (await response.json()) as MonitorStatusResponse;
      if (body.protocolVersion !== 1 || body.status !== "ok") {
        throw new Error("监控服务协议不兼容");
      }
      return body;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private stopConnection(): void {
    this.generation += 1;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
  }

  private async connect(generation: number): Promise<void> {
    if (generation !== this.generation || !this.config.enabled) {
      return;
    }

    this.callbacks.onStatus({
      state: this.reconnectAttempts > 0 ? "reconnecting" : "connecting",
      message: this.reconnectAttempts > 0 ? "正在重新连接监控服务" : "正在连接监控服务",
    });

    try {
      await this.testConnection();
    } catch (error) {
      this.scheduleReconnect(generation, this.errorMessage(error));
      return;
    }

    if (generation !== this.generation || !this.config.enabled) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(toSocketUrl(this.config.baseUrl), [
        "dgates-v1",
        `dgates-token.${this.config.token}`,
      ]);
    } catch (error) {
      this.scheduleReconnect(generation, this.errorMessage(error));
      return;
    }

    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.generation) {
        socket.close();
        return;
      }
      this.reconnectAttempts = 0;
      this.callbacks.onStatus({ state: "connected", message: "已连接，正在等待新事件" });
      void this.primeRecentEvents(generation);
    };
    socket.onmessage = (message) => {
      this.handleSocketMessage(message.data);
    };
    socket.onerror = () => {
      if (generation === this.generation) {
        this.callbacks.onStatus({ state: "error", message: "监控连接发生错误" });
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (generation === this.generation && this.config.enabled) {
        this.scheduleReconnect(generation, "与监控服务的连接已断开");
      }
    };
  }

  private scheduleReconnect(generation: number, reason: string): void {
    if (generation !== this.generation || !this.config.enabled) {
      return;
    }
    window.clearTimeout(this.reconnectTimer);
    const retrySeconds = Math.min(30, 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts += 1;
    this.callbacks.onStatus({
      state: "reconnecting",
      message: `${reason}，${retrySeconds} 秒后重试`,
      retryInSeconds: retrySeconds,
    });
    this.reconnectTimer = window.setTimeout(() => {
      void this.connect(generation);
    }, retrySeconds * 1000);
  }

  private async primeRecentEvents(generation: number): Promise<void> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/plugin/v1/events?limit=80`, {
        headers: {
          "X-DGates-Token": this.config.token,
        },
      });
      if (!response.ok) {
        throw new Error(await this.describeHttpError(response));
      }
      const body = (await response.json()) as MonitorEventsResponse;
      if (generation !== this.generation || body.protocolVersion !== 1) {
        return;
      }
      for (const event of [...body.events].reverse()) {
        this.rememberEvent(event.id);
      }
    } catch (error) {
      console.warn("Unable to load monitor event backlog", error);
    }
  }

  private handleSocketMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }
    try {
      const message = JSON.parse(raw) as MonitorSocketMessage;
      if (message.type !== "event.created" || !message.event) {
        return;
      }
      if (this.seenEventIds.has(message.event.id)) {
        return;
      }

      this.rememberEvent(message.event.id);
      this.callbacks.onEvent(message.event);
      if (this.config.desktopNotifications) {
        void this.notify(message.event);
      }
    } catch (error) {
      console.warn("Ignored invalid monitor plugin message", error);
    }
  }

  private rememberEvent(id: number): void {
    if (this.seenEventIds.has(id)) {
      return;
    }
    this.seenEventIds.add(id);
    this.seenEventOrder.push(id);
    while (this.seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
      const oldest = this.seenEventOrder.shift();
      if (oldest !== undefined) {
        this.seenEventIds.delete(oldest);
      }
    }
  }

  private async ensureNotificationPermission(): Promise<boolean> {
    try {
      if (await isPermissionGranted()) {
        return true;
      }
      return (await requestPermission()) === "granted";
    } catch (error) {
      console.warn("Unable to request notification permission", error);
      return false;
    }
  }

  private async notify(event: MonitorEvent): Promise<void> {
    if (!(await this.ensureNotificationPermission())) {
      return;
    }
    sendNotification({
      title: event.title || "监控发现新事件",
      body: event.summary || "打开桌宠查看最新提醒",
    });
  }

  private async describeHttpError(response: Response): Promise<string> {
    if (response.status === 401) {
      return "配对令牌不正确";
    }
    if (response.status === 503) {
      return "Mac 端还没有启用桌宠插件接口";
    }
    try {
      const body = (await response.json()) as { detail?: string };
      return body.detail || `监控服务返回 ${response.status}`;
    } catch {
      return `监控服务返回 ${response.status}`;
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof DOMException && error.name === "AbortError") {
      return "连接监控服务超时";
    }
    if (error instanceof Error) {
      return error.message || "无法连接监控服务";
    }
    return "无法连接监控服务";
  }
}

export function formatMonitorEvent(event: MonitorEvent, maxLength = 54): string {
  const message = eventMessage(event).replace(/\s+/g, " ").trim();
  const characters = Array.from(message);
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join("")}…`
    : message;
}
