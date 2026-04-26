import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const repoRoot = process.cwd();
const skinsRoot = path.join(repoRoot, "src", "assets", "skins");
const generatedRegistryPath = path.join(repoRoot, "src", "generated", "skins.ts");

function parseArgs(argv) {
  const args = {
    layout: "halfBody",
    tolerance: 34,
    refresh: false,
    keepBackground: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    if (key === "refresh") {
      args.refresh = true;
      continue;
    }

    if (key === "keep-background") {
      args.keepBackground = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();

  return slug || `skin-${Date.now()}`;
}

function assertSafeId(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error("Skin id can only contain lowercase letters, numbers, and hyphens.");
  }
}

function normalizeLayout(layout) {
  return layout === "fullBody" ? "fullBody" : "halfBody";
}

function createImportName(id, suffix) {
  const pascal = id
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  return `skin${pascal}${suffix}`;
}

function toImportPath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function readImage(filePath) {
  const { data, info } = await sharp(filePath)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width: info.width,
    height: info.height,
    data: Buffer.from(data),
  };
}

async function writePng(filePath, image) {
  await sharp(image.data, {
    raw: {
      width: image.width,
      height: image.height,
      channels: 4,
    },
  })
    .png()
    .toFile(filePath);
}

function isCloseToColor(image, pixelIndex, color, tolerance) {
  const offset = pixelIndex * 4;
  const alpha = image.data[offset + 3];
  if (alpha === 0) {
    return false;
  }

  const dr = image.data[offset] - color.r;
  const dg = image.data[offset + 1] - color.g;
  const db = image.data[offset + 2] - color.b;
  return dr * dr + dg * dg + db * db <= tolerance * tolerance;
}

function makeEdgeBackgroundTransparent(image, tolerance) {
  const { width, height } = image;
  const topLeft = {
    r: image.data[0],
    g: image.data[1],
    b: image.data[2],
  };
  const visited = new Uint8Array(width * height);
  const queue = [];

  function pushIfBackground(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return;
    }

    const pixelIndex = y * width + x;
    if (visited[pixelIndex] || !isCloseToColor(image, pixelIndex, topLeft, tolerance)) {
      return;
    }

    visited[pixelIndex] = 1;
    queue.push(pixelIndex);
  }

  for (let x = 0; x < width; x += 1) {
    pushIfBackground(x, 0);
    pushIfBackground(x, height - 1);
  }

  for (let y = 0; y < height; y += 1) {
    pushIfBackground(0, y);
    pushIfBackground(width - 1, y);
  }

  for (let head = 0; head < queue.length; head += 1) {
    const pixelIndex = queue[head];
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);

    pushIfBackground(x + 1, y);
    pushIfBackground(x - 1, y);
    pushIfBackground(x, y + 1);
    pushIfBackground(x, y - 1);
  }

  for (const pixelIndex of queue) {
    const offset = pixelIndex * 4;
    image.data[offset + 3] = 0;
  }

  return queue.length;
}

function createBlankOverlay(width, height) {
  return {
    width,
    height,
    data: Buffer.alloc(width * height * 4),
  };
}

function loadManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function refreshRegistry() {
  fs.mkdirSync(path.dirname(generatedRegistryPath), { recursive: true });
  fs.mkdirSync(skinsRoot, { recursive: true });

  const entries = fs
    .readdirSync(skinsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const imports = ['import type { PetSkinDefinition } from "../skinTypes";', ""];
  const definitions = [];

  for (const id of entries) {
    const manifestPath = path.join(skinsRoot, id, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    const manifest = loadManifest(manifestPath);
    const assets = manifest.assets ?? {};
    const imageEntries = [
      ["Idle", "idle"],
      ["Surprised", "surprised"],
      ["Blink", "blink"],
      ["MouthTalk", "mouthTalk"],
      ["MouthO", "mouthO"],
    ];
    const vars = {};

    for (const [suffix, key] of imageEntries) {
      const assetName = assets[key];
      if (!assetName) {
        throw new Error(`Missing ${key} asset in ${manifestPath}`);
      }

      const assetPath = path.join(skinsRoot, id, assetName);
      if (!fs.existsSync(assetPath)) {
        throw new Error(`Missing skin asset: ${assetPath}`);
      }

      const importName = createImportName(id, suffix);
      vars[key] = importName;
      imports.push(`import ${importName} from "../assets/skins/${id}/${toImportPath(assetName)}";`);
    }

    definitions.push(`  {
    id: ${JSON.stringify(manifest.id ?? id)},
    name: ${JSON.stringify(manifest.name ?? id)},
    layout: ${JSON.stringify(normalizeLayout(manifest.layout))},
    assetWidth: ${Number(manifest.width) || 1},
    assetHeight: ${Number(manifest.height) || 1},
    hitCalibrationY: ${Number(manifest.hitCalibrationY ?? 0)},
    images: {
      idle: ${vars.idle},
      surprised: ${vars.surprised},
      blink: ${vars.blink},
      mouthTalk: ${vars.mouthTalk},
      mouthO: ${vars.mouthO},
    },
  }`);
  }

  const source = `${imports.join("\n")}

export const GENERATED_SKINS: PetSkinDefinition[] = [
${definitions.join(",\n")}
];
`;

  fs.writeFileSync(generatedRegistryPath, source, "utf8");
  console.log(`Refreshed ${path.relative(repoRoot, generatedRegistryPath)} with ${definitions.length} generated skin(s).`);
}

async function generateSkin(args) {
  if (!args.image) {
    throw new Error('Missing --image. Example: npm run skin:generate -- --image "../my-pet.png" --id my-pet --name "我的皮肤"');
  }

  const imagePath = path.resolve(repoRoot, args.image);
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  const id = args.id ? slugify(args.id) : slugify(path.basename(imagePath, path.extname(imagePath)));
  assertSafeId(id);

  const name = args.name ?? id;
  const layout = normalizeLayout(args.layout);
  const tolerance = Math.max(0, Math.min(96, Number(args.tolerance) || 34));
  const skinDir = path.join(skinsRoot, id);
  fs.mkdirSync(skinDir, { recursive: true });

  const base = await readImage(imagePath);
  const removedPixels = args.keepBackground ? 0 : makeEdgeBackgroundTransparent(base, tolerance);
  const { width, height } = base;

  const idlePath = path.join(skinDir, "idle.png");
  const surprisedPath = path.join(skinDir, "surprised.png");
  await writePng(idlePath, base);
  await writePng(surprisedPath, base);

  const overlayAssets = ["blink_overlay.png", "mouth_talk_overlay.png", "mouth_o_overlay.png"];
  for (const asset of overlayAssets) {
    await writePng(path.join(skinDir, asset), createBlankOverlay(width, height));
  }

  const manifest = {
    schemaVersion: 1,
    id,
    name,
    layout,
    width,
    height,
    hitCalibrationY: layout === "halfBody" ? 7.2 : 0,
    generatedAt: new Date().toISOString(),
    generator: {
      command: "npm run skin:generate",
      background: args.keepBackground ? "kept" : "edge-transparent",
      tolerance,
      removedPixels,
    },
    assets: {
      idle: "idle.png",
      surprised: "surprised.png",
      blink: "blink_overlay.png",
      mouthTalk: "mouth_talk_overlay.png",
      mouthO: "mouth_o_overlay.png",
    },
  };

  fs.writeFileSync(path.join(skinDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  refreshRegistry();
  console.log(`Generated skin "${name}" at ${path.relative(repoRoot, skinDir)}.`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.refresh) {
    refreshRegistry();
  } else {
    await generateSkin(args);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
