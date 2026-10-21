"use client";
import { useEffect, useRef, useState } from "react";

export type PhotoPreviewOption = {
  crop_mode: "fit" | "crop";
  crop_rect?: { x: number; y: number; width: number; height: number } | null;
  rotation_degrees?: number;
  flip_horizontal?: boolean;
  flip_vertical?: boolean;
  adjustments?: { brightness: number; contrast: number; saturation: number; grayscale: number };
};

export function CroppedPhotoPreview({ image, label, option, className, frameAspect }: { image: string; label: string; option: PhotoPreviewOption; className?: string; frameAspect?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let active = true;
    setSource(null);
    const photo = new Image();
    photo.onload = () => { if (active) setSource(photo); };
    photo.src = image;
    return () => { active = false; };
  }, [image]);
  useEffect(() => {
    const target = canvas.current;
    if (!source || !target) return;
    const rect = option.crop_mode === "crop" && option.crop_rect ? option.crop_rect : { x: 0, y: 0, width: 1, height: 1 };
    const left = Math.max(0, Math.min(source.naturalWidth - 1, Math.round(rect.x * source.naturalWidth)));
    const top = Math.max(0, Math.min(source.naturalHeight - 1, Math.round(rect.y * source.naturalHeight)));
    const width = Math.max(1, Math.min(source.naturalWidth, Math.round((rect.x + rect.width) * source.naturalWidth)) - left);
    const height = Math.max(1, Math.min(source.naturalHeight, Math.round((rect.y + rect.height) * source.naturalHeight)) - top);
    const rotation = option.rotation_degrees || 0;
    const scale = Math.min(1, 600 / Math.max(width, height));
    const turned = rotation === 90 || rotation === 270;
    target.width = Math.max(1, Math.round((turned ? height : width) * scale));
    target.height = Math.max(1, Math.round((turned ? width : height) * scale));
    const context = target.getContext("2d");
    if (!context) return;
    context.translate(target.width / 2, target.height / 2);
    // The saved renderer crops first, rotates clockwise, then mirrors.
    context.scale(option.flip_horizontal ? -1 : 1, option.flip_vertical ? -1 : 1);
    context.rotate(rotation * Math.PI / 180);
    context.drawImage(source, left, top, width, height, -width * scale / 2, -height * scale / 2, width * scale, height * scale);
    if (frameAspect && frameAspect > 0) {
      const fullCrop = document.createElement("canvas");
      fullCrop.width = target.width; fullCrop.height = target.height;
      fullCrop.getContext("2d")!.drawImage(target, 0, 0);
      const cropWidth = Math.min(fullCrop.width, fullCrop.height * frameAspect);
      const cropHeight = Math.min(fullCrop.height, fullCrop.width / frameAspect);
      target.width = Math.max(1, Math.round(Math.min(600, 600 * frameAspect)));
      target.height = Math.max(1, Math.round(target.width / frameAspect));
      target.getContext("2d")!.drawImage(fullCrop, (fullCrop.width - cropWidth) / 2, (fullCrop.height - cropHeight) / 2, cropWidth, cropHeight, 0, 0, target.width, target.height);
    }
  }, [source, option, frameAspect]);
  const adjustments = option.adjustments;
  return <canvas ref={canvas} className={className} role="img" aria-label={label} style={{ filter: adjustments ? `brightness(${adjustments.brightness}) contrast(${adjustments.contrast}) saturate(${adjustments.saturation}) grayscale(${adjustments.grayscale})` : undefined }} />;
}
