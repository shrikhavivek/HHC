"use client";
import { useEffect, useState } from "react";
import { CroppedPhotoPreview, type PhotoPreviewOption } from "./cropped-photo-preview";

type Panel = { id: string; image_path: string; label: string };
type Options = Record<string, PhotoPreviewOption & { width_scale?: number }>;
export type LayoutGeometry = { width: number; height: number; cells: [number, number, number, number][] };
const defaultOption: PhotoPreviewOption = { crop_mode: "fit" };
const sourceUrl = (path: string) => "/media" + path;

export function useLayoutPreviews(panels: Panel[], options: Options, canvasFormat: string) {
  const [layouts, setLayouts] = useState<Record<string, LayoutGeometry>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify({ panels: panels.map(p => ({ id: p.id, image_path: p.image_path })), options, canvasFormat });
  useEffect(() => {
    const controller = new AbortController();
    setLayouts({}); setError(""); setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const input = JSON.parse(key);
        if (!input.panels.length) { setLoading(false); return; }
        const photos = await Promise.all(input.panels.map((panel: Panel) => new Promise<{ width: number; height: number; width_scale: number }>((resolve, reject) => {
          const image = new Image();
          image.onerror = () => reject(new Error("A photo could not be loaded."));
          image.onload = () => {
            const option = input.options[panel.id] || defaultOption;
            let width = image.naturalWidth, height = image.naturalHeight;
            if (option.crop_mode === "crop" && option.crop_rect) {
              const r = option.crop_rect;
              width = Math.max(1, Math.round((r.x + r.width) * width) - Math.round(r.x * width));
              height = Math.max(1, Math.round((r.y + r.height) * height) - Math.round(r.y * height));
            }
            if ([90, 270].includes(option.rotation_degrees)) [width, height] = [height, width];
            resolve({ width, height, width_scale: option.width_scale || 1 });
          };
          image.src = sourceUrl(panel.image_path);
        })));
        if (controller.signal.aborted) return;
        const response = await fetch("/api/backend/collage/layouts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ photos, canvas_format: input.canvasFormat }), signal: controller.signal });
        if (!response.ok) throw new Error("Layout preview unavailable. Try changing the layout again.");
        const data = await response.json();
        if (!controller.signal.aborted) setLayouts(data);
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key]);
  return { layouts, error, loading };
}

export function CollageLayoutPreview({ panels, options, geometry, layout, label }: { panels: Panel[]; options: Options; geometry: LayoutGeometry; layout: string; label: string }) {
  return <div className="live-layout-canvas" role="img" aria-label={label} style={{ aspectRatio: `${geometry.width} / ${geometry.height}`, maxWidth: `min(100%, ${Math.max(1, 420 * geometry.width / geometry.height)}px)` }}>
    {geometry.cells.map(([x, y, width, height], index) => {
      const panel = panels[index];
      if (!panel) return null;
      const option = options[panel.id] || defaultOption;
      return <div key={panel.id} className={`live-layout-cell ${layout === "side_by_side" ? "stretch-photo" : "fill-photo"}`} style={{ left: `${x / geometry.width * 100}%`, top: `${y / geometry.height * 100}%`, width: `${width / geometry.width * 100}%`, height: `${height / geometry.height * 100}%` }}>
        <CroppedPhotoPreview image={sourceUrl(panel.image_path)} label={panel.label} option={option}/>
      </div>;
    })}
  </div>;
}
