import type { PetSkinDefinition } from "../skinTypes";

import skinHeartEyeUaIdle from "../assets/skins/heart-eye-ua/idle.png";
import skinHeartEyeUaSurprised from "../assets/skins/heart-eye-ua/surprised.png";
import skinHeartEyeUaBlink from "../assets/skins/heart-eye-ua/blink_overlay.png";
import skinHeartEyeUaMouthTalk from "../assets/skins/heart-eye-ua/mouth_talk_overlay.png";
import skinHeartEyeUaMouthO from "../assets/skins/heart-eye-ua/mouth_o_overlay.png";

export const GENERATED_SKINS: PetSkinDefinition[] = [
  {
    id: "heart-eye-ua",
    name: "爱心眼 UA",
    layout: "fullBody",
    assetWidth: 710,
    assetHeight: 1536,
    hitCalibrationY: 0,
    images: {
      idle: skinHeartEyeUaIdle,
      surprised: skinHeartEyeUaSurprised,
      blink: skinHeartEyeUaBlink,
      mouthTalk: skinHeartEyeUaMouthTalk,
      mouthO: skinHeartEyeUaMouthO,
    },
  }
];
