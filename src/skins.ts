import idleBase from "./assets/pet/full_idle_smile.png";
import surpriseBase from "./assets/pet/full_surprised_original.png";
import blinkOverlay from "./assets/pet/eyes_blink_overlay.png";
import mouthTalkOverlay from "./assets/pet/mouth_talk_overlay.png";
import mouthOOverlay from "./assets/pet/mouth_o_overlay.png";
import { GENERATED_SKINS } from "./generated/skins";
import type { PetSkinDefinition } from "./skinTypes";

export const DEFAULT_PET_SKIN_ID = "silver-half-body";

const DEFAULT_SKIN: PetSkinDefinition = {
  id: DEFAULT_PET_SKIN_ID,
  name: "银白半身 UA",
  layout: "halfBody",
  assetWidth: 1170,
  assetHeight: 2532,
  hitCalibrationY: 7.2,
  images: {
    idle: idleBase,
    surprised: surpriseBase,
    blink: blinkOverlay,
    mouthTalk: mouthTalkOverlay,
    mouthO: mouthOOverlay,
  },
};

export const PET_SKINS: PetSkinDefinition[] = [DEFAULT_SKIN, ...GENERATED_SKINS];

export function getPetSkin(id: string | null | undefined): PetSkinDefinition {
  return PET_SKINS.find((skin) => skin.id === id) ?? DEFAULT_SKIN;
}
