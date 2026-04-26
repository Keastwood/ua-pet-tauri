export type PetSkinLayoutId = "halfBody" | "fullBody";

export interface PetSkinImages {
  idle: string;
  surprised: string;
  blink: string;
  mouthTalk: string;
  mouthO: string;
}

export interface PetSkinDefinition {
  id: string;
  name: string;
  layout: PetSkinLayoutId;
  assetWidth: number;
  assetHeight: number;
  hitCalibrationY?: number;
  images: PetSkinImages;
}
