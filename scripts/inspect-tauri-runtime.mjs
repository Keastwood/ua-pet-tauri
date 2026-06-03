const CDP_URL = process.env.TAURI_CDP_URL ?? "http://127.0.0.1:9222";

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${url}`);
  }
  return response.json();
}

async function connectToPage() {
  const targets = await getJson(`${CDP_URL}/json/list`);
  const target = targets.find((item) => item.type === "page" && item.title.includes("Silver Pet")) ?? targets[0];
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No debuggable Silver Pet page found at ${CDP_URL}. Start Tauri with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222.`);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(JSON.stringify(message.error)));
    } else {
      waiter.resolve(message.result);
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  function call(method, params = {}) {
    const id = nextId;
    nextId += 1;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  return { socket, call };
}

const expression = `
(async () => {
  const base = document.querySelector("#base-layer");
  const pet = document.querySelector("#pet");
  const frame = document.querySelector("#pet-frame");
  const skinButtons = Array.from(document.querySelectorAll(".skin-switcher__btn")).map((button) => ({
    label: button.getAttribute("aria-label") || button.textContent,
    title: button.getAttribute("title"),
    pressed: button.getAttribute("aria-pressed"),
    img: button.querySelector("img")?.src || null,
  }));

  let customSkins = null;
  let customSkinError = null;
  try {
    const invoker = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
    customSkins = invoker ? await invoker("list_custom_skins") : null;
  } catch (error) {
    customSkinError = String(error);
  }

  let alphaReadable = null;
  if (base?.complete && base.naturalWidth > 0 && base.naturalHeight > 0) {
    const canvas = document.createElement("canvas");
    canvas.width = base.naturalWidth;
    canvas.height = base.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    try {
      context.drawImage(base, 0, 0);
      const sample = context.getImageData(0, 0, 1, 1).data;
      alphaReadable = { ok: true, sample: Array.from(sample), crossOrigin: base.crossOrigin };
    } catch (error) {
      alphaReadable = { ok: false, error: String(error), crossOrigin: base.crossOrigin };
    }
  }

  return {
    href: location.href,
    hasTauriInternals: Boolean(window.__TAURI_INTERNALS__),
    selectedSkin: localStorage.getItem("silver-pet.skin.v1"),
    savedScale: localStorage.getItem("silver-pet.scale.v2"),
    bodyView: document.body.dataset.view,
    baseSrc: base?.src || null,
    natural: base ? { width: base.naturalWidth, height: base.naturalHeight, complete: base.complete } : null,
    petRect: pet ? pet.getBoundingClientRect().toJSON() : null,
    frameRect: frame ? frame.getBoundingClientRect().toJSON() : null,
    alphaReadable,
    skinButtons,
    customSkins,
    customSkinError,
  };
})()
`;

const { socket, call } = await connectToPage();
try {
  await call("Runtime.enable");
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails, null, 2));
  }
  console.log(JSON.stringify(result.result.value, null, 2));
} finally {
  socket.close();
}
