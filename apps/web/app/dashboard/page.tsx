"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type WorkspaceView = "today" | "women" | "men" | "both" | "pending" | "reviewed";
type Dashboard = {
  total: number;
  review_ready: number;
  needs_attention: number;
  review_queue: number;
  archive_total: number;
  rights_pending: number;
  rights_blocked: number;
  status_counts: Record<string, number>;
  source_mode: string;
  automation_enabled: boolean;
  last_run?: { id: string; status: string; created_at: string } | null;
};
type CaseSummary = {
  id: string;
  title: string;
  celebrity: string;
  designer: string;
  event_name: string;
  event_date?: string;
  status: string;
  match_type: string;
  confidence: number;
  risk_level: string;
  base_image: string;
  demo_data: boolean;
  source_type: string;
  fashion_category: "women" | "men" | "mixed" | "unclassified";
  created_at: string;
};
type Evidence = { publisher: string; url: string; grade: string; quote: string; credit?: string; retrieved_at?: string };
type Candidate = {
  id: string;
  person: string;
  designer: string;
  event_name: string;
  event_date?: string;
  image_path: string;
  proposed_match_type: string;
  status: string;
  visual_score: number;
  source_grade: string;
  rights_status: string;
  evidence: Evidence[];
  checks: { same_photo?: boolean; same_event?: boolean; chronology?: boolean; identity?: boolean; contradictions?: string[]; landmarks?: string[] };
  decision?: { id?: string; decision: string; reason: string; editor_id: string };
};
type OutfitAsset = {
  id: string;
  role: "current_angle" | "designer_reference" | "editor_upload";
  label: string;
  person: string;
  designer: string;
  image_path: string;
  source_url: string;
  publisher: string;
  credit: string;
  retrieved_at?: string;
  rights_status: string;
  source_grade: string;
  official_source: boolean;
  verified_source: boolean;
  source_kind: string;
  image_source_url?: string;
  exact_match: boolean;
  include_in_collage: boolean;
  fallback_only: boolean;
  notes: string;
};
type CollagePanel = {
  id: string;
  role: string;
  label: string;
  person: string;
  designer: string;
  event?: string;
  date?: string;
  image_path: string;
  source_url: string;
  publisher: string;
  rights_status: string;
  source_grade: string;
};
type CropRectangle = { x: number; y: number; width: number; height: number };
type PanelLayoutOption = {
  width_scale: number;
  crop_mode: "fit" | "crop";
  focal_x: number;
  focal_y: number;
  zoom: number;
  crop_rect?: CropRectangle | null;
};
type ImageAdjustments = {
  brightness: number;
  contrast: number;
  saturation: number;
  grayscale: number;
};
type WatermarkAsset = {
  id: string;
  image_path: string;
  original_filename: string;
  metadata?: { output_width?: number; output_height?: number; has_transparency?: boolean };
  uploaded_at?: string;
  editor_id?: string;
};
type WatermarkLayout = {
  enabled: boolean;
  asset_id: string;
  image_path: string;
  center_x: number;
  center_y: number;
  width: number;
  height: number | null;
  rotation_degrees: number;
  opacity: number;
  adjustments: ImageAdjustments;
};
type CollageEditor = {
  panels: CollagePanel[];
  default_ids: string[];
  selected_ids: string[];
  panel_options: Record<string, PanelLayoutOption>;
  collage_adjustments: ImageAdjustments;
  watermark_asset?: WatermarkAsset | null;
  watermark?: WatermarkLayout | null;
  customized: boolean;
  updated_at?: string;
  editor_id?: string;
};
type CaseDetail = CaseSummary & {
  body: string;
  permalink: string;
  extraction: Record<string, unknown>;
  assets: OutfitAsset[];
  candidates: Candidate[];
  collage_editor: CollageEditor;
  latest_collage?: { id: string; preview_url: string; base_preview_url?: string; source_preview_url?: string; bundle_url: string; created_at: string } | null;
};
type CollageResult = { previewUrl: string; bundleUrl: string; assetCount: number };

const PENDING_STATUSES = new Set(["review_ready", "context_review", "needs_research", "research_queued"]);
const REVIEWED_STATUSES = new Set(["approved", "rejected", "auto_rejected", "similar_not_same"]);
const DEFAULT_CROP_RECT: CropRectangle = { x: 0, y: 0, width: 1, height: 1 };
const DEFAULT_PANEL_OPTION: PanelLayoutOption = { width_scale: 1, crop_mode: "fit", focal_x: .5, focal_y: .5, zoom: 1, crop_rect: DEFAULT_CROP_RECT };
const DEFAULT_IMAGE_ADJUSTMENTS: ImageAdjustments = { brightness: 1, contrast: 1, saturation: 1, grayscale: 0 };
const DEFAULT_WATERMARK_LAYOUT = { enabled: true, center_x: .82, center_y: .9, width: .2, height: null, rotation_degrees: 0, opacity: .72, adjustments: DEFAULT_IMAGE_ADJUSTMENTS };

const VIEW_META: Record<WorkspaceView, { label: string; short: string; title: string; accent: string; description: string; listTitle: string; listKicker: string }> = {
  today: {
    label: "Today's edit",
    short: "Daily desk",
    title: "Today’s fashion intelligence.",
    accent: "Every look, one clear story.",
    description: "New Bollywood fashion posts, outfit matches and editor-ready collage plans in one focused workspace.",
    listTitle: "Looks in focus",
    listKicker: "The daily rail",
  },
  women: {
    label: "Women’s fashion",
    short: "Women’s desk",
    title: "Women’s fashion intelligence.",
    accent: "Every appearance, clearly filed.",
    description: "Women’s looks from the daily Reddit intake, with outfit research and collage status together.",
    listTitle: "Women’s looks",
    listKicker: "Dedicated content desk",
  },
  men: {
    label: "Men’s fashion",
    short: "Men’s desk",
    title: "Men’s fashion intelligence.",
    accent: "A sharper menswear archive.",
    description: "Men’s looks separated into a focused listing without losing their editorial evidence.",
    listTitle: "Men’s looks",
    listKicker: "Dedicated content desk",
  },
  both: {
    label: "Both fashion",
    short: "Shared desk",
    title: "Women and men, together.",
    accent: "Group appearances, clearly filed.",
    description: "Looks featuring both women and men are collected in their own section for focused group-post review.",
    listTitle: "Both fashion looks",
    listKicker: "Shared appearances",
  },
  pending: {
    label: "Pending review",
    short: "Pending",
    title: "Pending editorial review.",
    accent: "Resolve what needs a human eye.",
    description: "Review context gaps, verify garment identity and make defensible decisions before any collage is produced.",
    listTitle: "Awaiting action",
    listKicker: "Human review",
  },
  reviewed: {
    label: "Reviewed",
    short: "Reviewed",
    title: "Reviewed outfit stories.",
    accent: "Decisions preserved for the next edit.",
    description: "Revisit approved and closed outfit research, then reopen its collage, archive evidence and source-rights record.",
    listTitle: "Reviewed stories",
    listKicker: "Editorial history",
  },
};

const FILTERS: Record<WorkspaceView, string[]> = {
  today: ["all", "review_ready", "context_review", "needs_research", "approved"],
  women: ["all", "review_ready", "context_review", "needs_research", "approved"],
  men: ["all", "review_ready", "context_review", "needs_research", "approved"],
  both: ["all", "review_ready", "context_review", "needs_research", "approved"],
  pending: ["all", "review_ready", "context_review", "needs_research", "research_queued"],
  reviewed: ["all", "approved", "auto_rejected", "rejected", "similar_not_same"],
};

const pretty = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
const fashionCategoryLabel = (value: CaseSummary["fashion_category"]) => value === "mixed" ? "Both" : value === "unclassified" ? "Unfiled" : pretty(value);
const asset = (path: string) => path.startsWith("http") ? path : path.startsWith("/static/") || path.startsWith("/outputs/") || path.startsWith("/media-files/") ? `/media${path}` : path;
const isHistorical = (value: string) => /^(same_item|same_outfit)_/.test(value);
const isBlocked = (value: string) => ["do_not_use", "blocked", "unknown_blocked"].includes(value);
const assetRoleLabel = (role: OutfitAsset["role"]) => role === "designer_reference" ? "Original outfit" : role === "editor_upload" ? "Editor upload" : "Current angle";

function belongsToView(item: CaseSummary, view: WorkspaceView) {
  if (view === "women") return item.fashion_category === "women";
  if (view === "men") return item.fashion_category === "men";
  if (view === "both") return item.fashion_category === "mixed";
  if (view === "pending") return PENDING_STATUSES.has(item.status);
  if (view === "reviewed") return REVIEWED_STATUSES.has(item.status);
  return true;
}

function newestPostFirst(left: CaseSummary, right: CaseSummary) {
  const parsedLeftPostDate = left.event_date ? Date.parse(left.event_date) : Number.NaN;
  const parsedRightPostDate = right.event_date ? Date.parse(right.event_date) : Number.NaN;
  const leftPostDate = Number.isFinite(parsedLeftPostDate) ? parsedLeftPostDate : Number.NEGATIVE_INFINITY;
  const rightPostDate = Number.isFinite(parsedRightPostDate) ? parsedRightPostDate : Number.NEGATIVE_INFINITY;
  if (leftPostDate !== rightPostDate) return rightPostDate - leftPostDate;
  const leftIngested = Date.parse(left.created_at) || 0;
  const rightIngested = Date.parse(right.created_at) || 0;
  if (leftIngested !== rightIngested) return rightIngested - leftIngested;
  return left.id.localeCompare(right.id);
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    queue: <><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3" cy="6" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="3" cy="18" r="1"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>,
    spark: <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm7 13 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    arrow: <path d="m9 18 6-6-6-6"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    close: <path d="M6 6l12 12M18 6 6 18"/>,
    logout: <><path d="M10 5H5v14h5"/><path d="M14 8l4 4-4 4M18 12H9"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></>,
    download: <><path d="M12 3v12m0 0 5-5m-5 5-5-5"/><path d="M5 21h14"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
    archive: <><path d="M4 8h16v12H4zM3 4h18v4H3z"/><path d="M9 12h6"/></>,
    refresh: <><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18 9a7 7 0 0 0-12-2L4 11M6 15a7 7 0 0 0 12 2l2-4"/></>,
    external: <><path d="M14 3h7v7M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 15-5-5L5 20"/></>,
    edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></>,
    up: <path d="m6 15 6-6 6 6"/>,
    down: <path d="m6 9 6 6 6-6"/>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/><path d="M10 11v6M14 11v6"/></>,
    woman: <><circle cx="12" cy="7" r="4"/><path d="M12 11v10M8 16h8M9 21h6"/></>,
    man: <><circle cx="10" cy="9" r="4"/><path d="m13 6 6-3m0 0v5m0-5h-5M10 13v8"/></>,
    both: <><circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M3 20v-2a5 5 0 0 1 5-5h1M21 20v-2a5 5 0 0 0-5-5h-1M12 13v8"/></>,
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 15v5h16v-5"/></>,
    tune: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[name]}</svg>;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status status-${status}`}><i />{pretty(status)}</span>;
}

function ManualCropEditor({ image, label, option, onChange }: {
  image: string;
  label: string;
  option: PanelLayoutOption;
  onChange: (patch: Partial<PanelLayoutOption>) => void;
}) {
  const [sourceAspect, setSourceAspect] = useState(.75);
  const [drawingNew, setDrawingNew] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rect = { ...DEFAULT_CROP_RECT, ...(option.crop_rect || {}) };
  const drag = useRef<{
    pointerId: number;
    mode: string;
    startX: number;
    startY: number;
    rect: CropRectangle;
  } | null>(null);
  const minimum = .05;
  const limit = (value: number, lower: number, upper: number) => Math.max(lower, Math.min(upper, value));

  function commit(next: CropRectangle) {
    onChange({
      crop_rect: {
        x: Math.round(next.x * 10000) / 10000,
        y: Math.round(next.y * 10000) / 10000,
        width: Math.round(next.width * 10000) / 10000,
        height: Math.round(next.height * 10000) / 10000,
      },
      focal_x: .5,
      focal_y: .5,
      zoom: 1,
    });
  }

  function beginDrag(event: React.PointerEvent<HTMLElement>, mode: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const stage = stageRef.current;
    if (!stage) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = stage.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId,
      mode,
      startX: (event.clientX - bounds.left) / Math.max(1, bounds.width),
      startY: (event.clientY - bounds.top) / Math.max(1, bounds.height),
      rect: { ...rect },
    };
    stage.setPointerCapture(event.pointerId);
    setDragging(mode);
    if (mode === "draw") setDrawingNew(false);
  }

  function moveCrop(event: React.PointerEvent<HTMLDivElement>) {
    const origin = drag.current;
    const stage = stageRef.current;
    if (!origin || origin.pointerId !== event.pointerId || !stage) return;
    const bounds = stage.getBoundingClientRect();
    const currentX = limit((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    const currentY = limit((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1);
    const dx = currentX - origin.startX;
    const dy = currentY - origin.startY;
    const start = origin.rect;

    if (origin.mode === "draw") {
      let left = Math.min(origin.startX, currentX);
      let top = Math.min(origin.startY, currentY);
      let right = Math.max(origin.startX, currentX);
      let bottom = Math.max(origin.startY, currentY);
      if (right - left < minimum) right = Math.min(1, left + minimum);
      if (bottom - top < minimum) bottom = Math.min(1, top + minimum);
      left = Math.min(left, right - minimum);
      top = Math.min(top, bottom - minimum);
      commit({ x: left, y: top, width: right - left, height: bottom - top });
      return;
    }

    if (origin.mode === "move") {
      commit({
        ...start,
        x: limit(start.x + dx, 0, 1 - start.width),
        y: limit(start.y + dy, 0, 1 - start.height),
      });
      return;
    }

    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;
    if (origin.mode.includes("w")) left = limit(start.x + dx, 0, right - minimum);
    if (origin.mode.includes("e")) right = limit(start.x + start.width + dx, left + minimum, 1);
    if (origin.mode.includes("n")) top = limit(start.y + dy, 0, bottom - minimum);
    if (origin.mode.includes("s")) bottom = limit(start.y + start.height + dy, top + minimum, 1);
    commit({ x: left, y: top, width: right - left, height: bottom - top });
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(null);
  }

  function moveWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? .05 : .01;
    let x = rect.x;
    let y = rect.y;
    if (event.key === "ArrowLeft") x = limit(rect.x - step, 0, 1 - rect.width);
    else if (event.key === "ArrowRight") x = limit(rect.x + step, 0, 1 - rect.width);
    else if (event.key === "ArrowUp") y = limit(rect.y - step, 0, 1 - rect.height);
    else if (event.key === "ArrowDown") y = limit(rect.y + step, 0, 1 - rect.height);
    else return;
    event.preventDefault();
    commit({ ...rect, x, y });
  }

  function setCropWidth(width: number) {
    const nextWidth = limit(width, minimum, 1);
    const center = rect.x + rect.width / 2;
    commit({ ...rect, x: limit(center - nextWidth / 2, 0, 1 - nextWidth), width: nextWidth });
  }

  function setCropHeight(height: number) {
    const nextHeight = limit(height, minimum, 1);
    const center = rect.y + rect.height / 2;
    commit({ ...rect, y: limit(center - nextHeight / 2, 0, 1 - nextHeight), height: nextHeight });
  }

  const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  return <div className="manual-crop-editor">
    <div className="manual-crop-heading"><div><small>Manual crop</small><strong>Keep only what you need</strong><p>Draw a box around the model, then drag its edges or corners to set the crop width and height independently.</p></div><div><button type="button" className={drawingNew ? "active" : ""} onClick={() => setDrawingNew(current => !current)}>{drawingNew ? "Draw on image…" : "Draw new crop"}</button><button type="button" onClick={() => { commit(DEFAULT_CROP_RECT); setDrawingNew(false); }}>Use full image</button></div></div>
    <div className={`manual-crop-stage-shell ${drawingNew ? "is-drawing" : ""}`}>
      <div
        ref={stageRef}
        className={`manual-crop-stage ${dragging ? "is-dragging" : ""}`}
        style={{ width: `min(100%, ${Math.max(48, Math.round(320 * sourceAspect))}px)`, aspectRatio: sourceAspect }}
        onPointerDown={drawingNew ? event => beginDrag(event, "draw") : undefined}
        onPointerMove={moveCrop}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <img
          src={image}
          alt={label}
          draggable={false}
          onDragStart={event => event.preventDefault()}
          onLoad={event => {
            const nextAspect = event.currentTarget.naturalWidth / Math.max(1, event.currentTarget.naturalHeight);
            if (Number.isFinite(nextAspect) && nextAspect > 0) setSourceAspect(nextAspect);
          }}
        />
        <div
          className={`crop-selection ${drawingNew ? "is-disabled" : ""}`}
          style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
          role="group"
          tabIndex={drawingNew ? -1 : 0}
          aria-label={`Selected crop for ${label}: ${Math.round(rect.width * 100)} percent wide and ${Math.round(rect.height * 100)} percent high. Drag to move, use handles to resize, or use arrow keys.`}
          onPointerDown={event => beginDrag(event, "move")}
          onKeyDown={moveWithKeyboard}
        >
          <span className="selection-grid selection-grid-v-one"/><span className="selection-grid selection-grid-v-two"/><span className="selection-grid selection-grid-h-one"/><span className="selection-grid selection-grid-h-two"/>
          {handles.map(handle => <span key={handle} className={`crop-handle crop-handle-${handle}`} onPointerDown={event => beginDrag(event, handle)} aria-hidden/>)}
          <span className="selection-size">{Math.round(rect.width * 100)}% × {Math.round(rect.height * 100)}%</span>
        </div>
        {drawingNew && <span className="draw-crop-prompt">Drag around the model</span>}
      </div>
    </div>
    <div className="crop-dimension-controls">
      <label><span>Crop width <b>{Math.round(rect.width * 100)}%</b></span><input type="range" min="5" max="100" step="1" value={Math.round(rect.width * 100)} onChange={event => setCropWidth(Number(event.target.value) / 100)}/><small>Narrow</small><small>Full width</small></label>
      <label><span>Crop height <b>{Math.round(rect.height * 100)}%</b></span><input type="range" min="5" max="100" step="1" value={Math.round(rect.height * 100)} onChange={event => setCropHeight(Number(event.target.value) / 100)}/><small>Short</small><small>Full height</small></label>
    </div>
    <p className="crop-keyboard-note">Move the selected box directly, resize any of its eight handles, or use arrow keys for precise positioning. Hold Shift for larger steps.</p>
  </div>;
}

const IMAGE_FILTER_PRESETS: { label: string; value: ImageAdjustments }[] = [
  { label: "Original", value: DEFAULT_IMAGE_ADJUSTMENTS },
  { label: "Editorial", value: { brightness: 1.04, contrast: 1.1, saturation: 1.04, grayscale: 0 } },
  { label: "Soft", value: { brightness: 1.08, contrast: .88, saturation: .9, grayscale: 0 } },
  { label: "Vivid", value: { brightness: 1.02, contrast: 1.14, saturation: 1.22, grayscale: 0 } },
  { label: "Mono", value: { brightness: 1, contrast: 1.08, saturation: 0, grayscale: 1 } },
];

function imageFilter(value: ImageAdjustments) {
  return `brightness(${value.brightness}) contrast(${value.contrast}) saturate(${value.saturation}) grayscale(${value.grayscale})`;
}

function ImageAdjustmentControls({ value, onChange }: { value: ImageAdjustments; onChange: (next: ImageAdjustments) => void }) {
  const update = (patch: Partial<ImageAdjustments>) => onChange({ ...value, ...patch });
  const percentage = (key: keyof ImageAdjustments) => Math.round(value[key] * 100);
  return <div className="image-adjustment-controls">
    <div className="filter-presets" aria-label="Image filter presets">
      {IMAGE_FILTER_PRESETS.map(preset => <button
        type="button"
        key={preset.label}
        className={Object.keys(preset.value).every(key => Math.abs(value[key as keyof ImageAdjustments] - preset.value[key as keyof ImageAdjustments]) < .001) ? "active" : ""}
        onClick={() => onChange({ ...preset.value })}
      >{preset.label}</button>)}
    </div>
    <div className="image-adjustment-ranges">
      <label><span>Brightness <b>{percentage("brightness")}%</b></span><input type="range" min="25" max="200" step="1" value={percentage("brightness")} onChange={event => update({ brightness: Number(event.target.value) / 100 })}/></label>
      <label><span>Contrast <b>{percentage("contrast")}%</b></span><input type="range" min="25" max="200" step="1" value={percentage("contrast")} onChange={event => update({ contrast: Number(event.target.value) / 100 })}/></label>
      <label><span>Colour <b>{percentage("saturation")}%</b></span><input type="range" min="0" max="200" step="1" value={percentage("saturation")} onChange={event => update({ saturation: Number(event.target.value) / 100 })}/></label>
      <label><span>B&amp;W <b>{percentage("grayscale")}%</b></span><input type="range" min="0" max="100" step="1" value={percentage("grayscale")} onChange={event => update({ grayscale: Number(event.target.value) / 100 })}/></label>
    </div>
  </div>;
}

function CollageAdjustmentEditor({ baseImage, adjustments, onChange }: {
  baseImage: string;
  adjustments: ImageAdjustments;
  onChange: (next: ImageAdjustments) => void;
}) {
  return <details className="collage-filter-panel" open>
    <summary><span><Icon name="tune" size={15}/><b>Collage colour &amp; filters</b></span><small>Applied below the watermark</small></summary>
    <div className="collage-filter-content">
      {baseImage && <div className="collage-filter-preview"><img src={baseImage} alt="Filtered collage preview" style={{ filter: imageFilter(adjustments) }}/></div>}
      <ImageAdjustmentControls value={adjustments} onChange={onChange}/>
      <p>These settings affect the complete collage while leaving every source file unchanged.</p>
    </div>
  </details>;
}

function WatermarkEditor({ baseImage, collageAdjustments, watermark, onChange, onUpload, uploadBusy }: {
  baseImage: string;
  collageAdjustments: ImageAdjustments;
  watermark: WatermarkLayout | null;
  onChange: (watermark: WatermarkLayout) => void;
  onUpload: (event: FormEvent<HTMLFormElement>) => void;
  uploadBusy: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageAspect, setStageAspect] = useState(1);
  const [logoAspect, setLogoAspect] = useState(3);
  const [expanded, setExpanded] = useState(true);
  type DragMode = "move" | "resize-both" | "resize-x" | "resize-y" | "rotate";
  const [dragging, setDragging] = useState<DragMode | null>(null);
  const drag = useRef<{
    pointerId: number;
    mode: DragMode;
    startX: number;
    startY: number;
    startAngle: number;
    watermark: WatermarkLayout;
  } | null>(null);
  const limit = (value: number, lower: number, upper: number) => Math.max(lower, Math.min(upper, value));
  const round = (value: number, places = 4) => Number(value.toFixed(places));
  const normalizeAngle = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;
  const watermarkAdjustments = { ...DEFAULT_IMAGE_ADJUSTMENTS, ...(watermark?.adjustments || {}) };
  const effectiveHeight = watermark
    ? limit(watermark.height ?? watermark.width * stageAspect / Math.max(.01, logoAspect), .02, 1)
    : .08;

  function update(patch: Partial<WatermarkLayout>) {
    if (!watermark) return;
    onChange({ ...watermark, ...patch });
  }

  function beginDrag(event: React.PointerEvent<HTMLElement>, mode: DragMode) {
    if (!watermark || (event.pointerType === "mouse" && event.button !== 0)) return;
    const stage = stageRef.current;
    if (!stage) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = stage.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    const centerX = watermark.center_x * bounds.width;
    const centerY = watermark.center_y * bounds.height;
    drag.current = {
      pointerId: event.pointerId,
      mode,
      startX: pointerX / Math.max(1, bounds.width),
      startY: pointerY / Math.max(1, bounds.height),
      startAngle: Math.atan2(pointerY - centerY, pointerX - centerX),
      watermark: { ...watermark, height: effectiveHeight, adjustments: watermarkAdjustments },
    };
    stage.setPointerCapture(event.pointerId);
    setDragging(mode);
  }

  function transformWatermark(event: React.PointerEvent<HTMLDivElement>) {
    const origin = drag.current;
    const stage = stageRef.current;
    if (!origin || origin.pointerId !== event.pointerId || !stage) return;
    const bounds = stage.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    if (origin.mode === "move") {
      const nextX = origin.watermark.center_x + pointerX / Math.max(1, bounds.width) - origin.startX;
      const nextY = origin.watermark.center_y + pointerY / Math.max(1, bounds.height) - origin.startY;
      update({ center_x: round(limit(nextX, 0, 1)), center_y: round(limit(nextY, 0, 1)) });
      return;
    }
    const centerX = origin.watermark.center_x * bounds.width;
    const centerY = origin.watermark.center_y * bounds.height;
    if (origin.mode.startsWith("resize")) {
      const rotation = origin.watermark.rotation_degrees * Math.PI / 180;
      const dx = pointerX - centerX;
      const dy = pointerY - centerY;
      const localX = dx * Math.cos(rotation) + dy * Math.sin(rotation);
      const localY = -dx * Math.sin(rotation) + dy * Math.cos(rotation);
      const patch: Partial<WatermarkLayout> = {};
      if (origin.mode !== "resize-y") patch.width = round(limit(2 * Math.abs(localX) / Math.max(1, bounds.width), .05, 1));
      if (origin.mode !== "resize-x") patch.height = round(limit(2 * Math.abs(localY) / Math.max(1, bounds.height), .02, 1));
      update(patch);
      return;
    }
    const angle = Math.atan2(pointerY - centerY, pointerX - centerX);
    const delta = (angle - origin.startAngle) * 180 / Math.PI;
    update({ rotation_degrees: round(normalizeAngle(origin.watermark.rotation_degrees + delta), 1) });
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(null);
  }

  function moveWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!watermark) return;
    const step = event.shiftKey ? .04 : .008;
    if (event.key === "ArrowLeft") update({ center_x: round(limit(watermark.center_x - step, 0, 1)) });
    else if (event.key === "ArrowRight") update({ center_x: round(limit(watermark.center_x + step, 0, 1)) });
    else if (event.key === "ArrowUp") update({ center_y: round(limit(watermark.center_y - step, 0, 1)) });
    else if (event.key === "ArrowDown") update({ center_y: round(limit(watermark.center_y + step, 0, 1)) });
    else if (event.key === "[") update({ rotation_degrees: round(normalizeAngle(watermark.rotation_degrees - (event.shiftKey ? 5 : 1)), 1) });
    else if (event.key === "]") update({ rotation_degrees: round(normalizeAngle(watermark.rotation_degrees + (event.shiftKey ? 5 : 1)), 1) });
    else return;
    event.preventDefault();
  }

  return <details className="watermark-editor-panel" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span><Icon name="spark" size={15}/><b>HHC watermark</b></span><small>{watermark ? watermark.enabled ? "Visible in final render" : "Hidden from final render" : "Optional brand layer"}</small></summary>
    <div className="watermark-editor-content">
      {watermark ? <>
        <div className="watermark-toolbar"><div><strong>Place the brand mark</strong><span>Drag, stretch width or height independently, rotate, and tune its appearance.</span></div><div><button type="button" className={watermark.enabled ? "active" : ""} onClick={() => update({ enabled: !watermark.enabled })}>{watermark.enabled ? "Hide watermark" : "Show watermark"}</button><button type="button" onClick={() => onChange({ ...watermark, ...DEFAULT_WATERMARK_LAYOUT, adjustments: { ...DEFAULT_IMAGE_ADJUSTMENTS } })}>Reset</button></div></div>
        <div className="watermark-stage-shell">
          <div
            ref={stageRef}
            className={`watermark-stage ${dragging ? `is-${dragging}` : ""}`}
            style={{ width: `min(100%, ${Math.max(96, Math.min(520, Math.round(300 * stageAspect)))}px)`, aspectRatio: stageAspect }}
            onPointerMove={transformWatermark}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {baseImage ? <img className="watermark-collage-preview" src={baseImage} alt="Watermark-free collage preview" draggable={false} style={{ filter: imageFilter(collageAdjustments) }} onDragStart={event => event.preventDefault()} onLoad={event => { const next = event.currentTarget.naturalWidth / Math.max(1, event.currentTarget.naturalHeight); if (Number.isFinite(next) && next > 0) setStageAspect(next); }}/>: <span className="watermark-preview-missing">Save a collage once to create its positioning preview.</span>}
            <div
              className={`watermark-overlay ${watermark.enabled ? "" : "is-disabled"}`}
              style={{ left: `${watermark.center_x * 100}%`, top: `${watermark.center_y * 100}%`, width: `${watermark.width * 100}%`, height: `${effectiveHeight * 100}%`, transform: `translate(-50%, -50%) rotate(${watermark.rotation_degrees}deg)` }}
              tabIndex={0}
              role="group"
              aria-label="HHC watermark. Drag to move, use edge handles for width or height, corner handles for both, and the round handle to rotate."
              onPointerDown={event => beginDrag(event, "move")}
              onKeyDown={moveWithKeyboard}
            >
              <img src={asset(watermark.image_path)} alt="HHC watermark" draggable={false} style={{ opacity: watermark.enabled ? watermark.opacity : .24, filter: imageFilter(watermarkAdjustments) }} onLoad={event => { const next = event.currentTarget.naturalWidth / Math.max(1, event.currentTarget.naturalHeight); if (Number.isFinite(next) && next > 0) setLogoAspect(next); }} onDragStart={event => event.preventDefault()}/>
              {(["nw", "ne", "se", "sw"] as const).map(handle => <span key={handle} className={`watermark-resize-handle watermark-resize-${handle}`} onPointerDown={event => beginDrag(event, "resize-both")} aria-hidden/>)}
              {(["n", "s"] as const).map(handle => <span key={handle} className={`watermark-resize-handle watermark-resize-${handle} watermark-resize-edge`} onPointerDown={event => beginDrag(event, "resize-y")} aria-hidden/>)}
              {(["e", "w"] as const).map(handle => <span key={handle} className={`watermark-resize-handle watermark-resize-${handle} watermark-resize-edge`} onPointerDown={event => beginDrag(event, "resize-x")} aria-hidden/>)}
              <span className="watermark-rotate-line" aria-hidden/><button type="button" className="watermark-rotate-handle" onPointerDown={event => beginDrag(event, "rotate")} aria-label="Drag to rotate watermark"><Icon name="refresh" size={11}/></button>
            </div>
          </div>
        </div>
        <div className="watermark-controls">
          <label><span>Width <b>{Math.round(watermark.width * 100)}%</b></span><input type="range" min="5" max="100" step="1" value={Math.round(watermark.width * 100)} onChange={event => update({ width: Number(event.target.value) / 100, height: effectiveHeight })}/></label>
          <label><span>Height <b>{Math.round(effectiveHeight * 100)}%</b></span><input type="range" min="2" max="100" step="1" value={Math.round(effectiveHeight * 100)} onChange={event => update({ height: Number(event.target.value) / 100 })}/></label>
          <label><span>Opacity <b>{Math.round(watermark.opacity * 100)}%</b></span><input type="range" min="5" max="100" step="1" value={Math.round(watermark.opacity * 100)} onChange={event => update({ opacity: Number(event.target.value) / 100 })}/></label>
          <label><span>Tilt <b>{Math.round(watermark.rotation_degrees)} deg</b></span><input type="range" min="-180" max="180" step="1" value={Math.round(watermark.rotation_degrees)} onChange={event => update({ rotation_degrees: Number(event.target.value) })}/></label>
        </div>
        <div className="watermark-filter-section"><div><small>Watermark-only appearance</small><strong>Colour &amp; filters</strong></div><ImageAdjustmentControls value={watermarkAdjustments} onChange={adjustments => update({ adjustments })}/></div>
        <div className="watermark-position-readout"><span>X {Math.round(watermark.center_x * 100)}%</span><span>Y {Math.round(watermark.center_y * 100)}%</span><span>W {Math.round(watermark.width * 100)}%</span><span>H {Math.round(effectiveHeight * 100)}%</span><span>{watermark.enabled ? "Included" : "Not included"}</span></div>
      </> : <div className="watermark-empty"><Icon name="image" size={24}/><strong>Add the HHC logo or wordmark</strong><p>A transparent PNG or WebP works best. The source logo stays untouched.</p></div>}
      <form className="watermark-upload-form" onSubmit={onUpload}>
        <label><span>{watermark ? "Replace brand asset" : "Choose brand asset"}</span><input name="image" type="file" accept="image/png,image/webp,image/jpeg" required disabled={uploadBusy}/></label>
        <button type="submit" disabled={uploadBusy}><Icon name={uploadBusy ? "refresh" : "upload"} size={13}/>{uploadBusy ? "Uploadingâ€¦" : watermark ? "Replace logo" : "Upload watermark"}</button>
      </form>
      <p className="watermark-note">Use only a client-authorized brand asset. Side handles change width, top and bottom handles change height, and corners change both. Arrow keys move precisely; [ and ] rotate.</p>
    </div>
  </details>;
}

function AssetBoard({ assets }: { assets: OutfitAsset[] }) {
  if (!assets.length) return null;
  return <section className="asset-board" aria-label="Additional outfit sources">
    <header><div><small>Per-outfit source board</small><h3>All post images &amp; outfit references</h3></div><span>{assets.length.toString().padStart(2, "0")} supporting images</span></header>
    <div className="asset-board-grid">
      {assets.map(item => <article className={`asset-tile asset-${item.role}`} key={item.id}>
        <div className="asset-tile-image"><img src={asset(item.image_path)} alt={`${item.label} for ${item.designer}`}/><span>{assetRoleLabel(item.role)}</span></div>
        <div className="asset-tile-copy">
          <div className="asset-badges"><b>Grade {item.source_grade}</b><i className={item.exact_match && item.verified_source ? "verified" : "pending"}>{item.exact_match && item.verified_source ? "Exact outfit verified" : "Verify outfit"}</i></div>
          <strong>{item.label}</strong><p>{item.publisher}</p>
          <footer><span>{item.include_in_collage ? "Included in collage" : "Reference only"} · {pretty(item.rights_status)}</span><a href={item.source_url} target="_blank" rel="noreferrer">Source <Icon name="external" size={10}/></a></footer>
        </div>
      </article>)}
    </div>
  </section>;
}

function CollageArchiveRights({ selected }: { selected: CaseDetail }) {
  const rightsEntries = [
    {
      id: "current-source",
      label: "Current source image",
      detail: `${selected.celebrity} · ${selected.event_name}`,
      status: "editorial_review_required",
      source: selected.permalink,
      exact: true,
      official: false,
    },
    ...selected.candidates.map(item => ({
      id: `candidate-${item.id}`,
      label: item.person,
      detail: `Historical candidate · Grade ${item.source_grade}`,
      status: item.rights_status,
      source: item.evidence[0]?.url || "",
      exact: Boolean(item.checks.identity),
      official: false,
    })),
    ...selected.assets.map(item => ({
      id: `asset-${item.id}`,
      label: item.label,
      detail: `${item.publisher} · Grade ${item.source_grade}`,
      status: item.rights_status,
      source: item.source_url,
      exact: item.exact_match,
      official: item.verified_source,
    })),
  ];
  const blocked = rightsEntries.filter(item => isBlocked(item.status)).length;
  const verified = rightsEntries.filter(item => item.official).length;

  return <details className="collage-context-panel" open>
    <summary><span><Icon name="shield" size={15}/><b>Fashion archive &amp; rights</b></span><small>{selected.candidates.length} archive lead{selected.candidates.length === 1 ? "" : "s"} · {rightsEntries.length} sources</small></summary>
    <div className="collage-context-content">
      <section className="collage-archive-section">
        <header><div><small>Fashion archive</small><strong>Past outfit research</strong></div><span>{selected.candidates.length}</span></header>
        {selected.candidates.length ? <div className="collage-archive-list">{selected.candidates.map(item => <article key={item.id}>
          <img src={asset(item.image_path)} alt={`${item.person} archive reference`}/>
          <div><small>{item.event_date || "Date unresolved"}</small><strong>{item.person}</strong><p>{pretty(item.proposed_match_type)} · {Math.round(item.visual_score * 100)}% signal</p></div>
          <span>{item.decision ? pretty(item.decision.decision) : "Pending"}</span>
        </article>)}</div> : <p className="collage-context-empty">No exact historical outfit has qualified yet.</p>}
      </section>

      <section className="collage-rights-section">
        <header><div><small>Rights review</small><strong>Sources attached to this collage</strong></div><span className={blocked ? "has-blocked" : ""}>{blocked ? `${blocked} blocked` : `${verified} verified`}</span></header>
        <div className="collage-rights-notice"><Icon name="shield" size={14}/><span>A public URL is not a publishing licence. Confirm usage and credit before publishing.</span></div>
        <div className="collage-rights-list">{rightsEntries.map(item => <article className={isBlocked(item.status) ? "is-blocked" : ""} key={item.id}>
          <div><strong>{item.label}</strong><small>{item.detail}</small></div>
          <div className="collage-rights-tags"><span>{isBlocked(item.status) ? "Blocked" : pretty(item.status)}</span>{item.official && <span>Official</span>}{item.exact && <span>Exact</span>}</div>
          {item.source ? <a href={item.source} target="_blank" rel="noreferrer" aria-label={`Open source for ${item.label}`}><Icon name="external" size={12}/></a> : <i title="Source URL missing">—</i>}
        </article>)}</div>
      </section>
    </div>
  </details>;
}

export default function DashboardPage() {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [selected, setSelected] = useState<CaseDetail | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("today");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [researchBusy, setResearchBusy] = useState(false);
  const [collageBusy, setCollageBusy] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [sourceImportBusy, setSourceImportBusy] = useState(false);
  const [decisionMode, setDecisionMode] = useState<"approved" | "rejected" | "similar_not_same" | "needs_more_research" | null>(null);
  const [reason, setReason] = useState("");
  const [showIntake, setShowIntake] = useState(false);
  const [toast, setToast] = useState("");
  const [dateLabel, setDateLabel] = useState("Preparing today’s edition");
  const [editionCode, setEditionCode] = useState("Daily / —");
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [collageResult, setCollageResult] = useState<CollageResult | null>(null);
  const [showCollageEditor, setShowCollageEditor] = useState(false);
  const [editorPanelIds, setEditorPanelIds] = useState<string[]>([]);
  const [editorPanelOptions, setEditorPanelOptions] = useState<Record<string, PanelLayoutOption>>({});
  const [editorCollageAdjustments, setEditorCollageAdjustments] = useState<ImageAdjustments>({ ...DEFAULT_IMAGE_ADJUSTMENTS });
  const [editorWatermark, setEditorWatermark] = useState<WatermarkLayout | null>(null);
  const [tuningPanelId, setTuningPanelId] = useState<string | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [watermarkBusy, setWatermarkBusy] = useState(false);
  const [categoryBusy, setCategoryBusy] = useState(false);

  async function openCase(id: string) {
    const response = await fetch(`/api/backend/cases/${id}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load case");
    setSelected(await response.json());
    setCandidateIndex(0);
  }

  async function load(silent = false) {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const session = await fetch("/api/auth/session", { cache: "no-store" });
      if (!session.ok) { router.replace("/"); return; }
      const [dashboardResponse, casesResponse] = await Promise.all([
        fetch("/api/backend/dashboard", { cache: "no-store" }),
        fetch("/api/backend/cases", { cache: "no-store" }),
      ]);
      if (!dashboardResponse.ok || !casesResponse.ok) throw new Error("Research API unavailable");
      setDashboard(await dashboardResponse.json());
      setCases(await casesResponse.json());
      if (silent) setToast("Daily edition refreshed.");
    } catch {
      setToast("The research API is unavailable. Check Docker services.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
  }

  async function runAutomation() {
    setAutomationBusy(true);
    try {
      const response = await fetch("/api/backend/runs/daily", { method: "POST" });
      const data = await response.json();
      if (!response.ok) return setToast(data.detail || "Daily automation could not run.");
      setWorkspaceView("today");
      setFilter("all");
      setSearch("");
      await load();
      if (data.case_ids?.[0]) await openCase(data.case_ids[0]);
      setToast(data.created
        ? `${data.created} outfit drafts and ${data.collages} collages created from Reddit.`
        : `Feed checked automatically. ${data.skipped || 0} existing outfits were already up to date.`);
    } catch {
      setToast("Daily automation could not reach the research service.");
    } finally {
      setAutomationBusy(false);
    }
  }

  useEffect(() => {
    const now = new Date();
    setDateLabel(new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now));
    const start = new Date(now.getFullYear(), 0, 0);
    const dayNumber = Math.floor((now.getTime() - start.getTime()) / 86400000);
    setEditionCode(`Daily / ${dayNumber.toString().padStart(3, "0")}`);
    void load();
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = ["INPUT", "TEXTAREA"].includes(target.tagName);
      if (event.key === "/" && !editing) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === "Escape" && document.activeElement === searchRef.current) { setSearch(""); searchRef.current?.blur(); }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  const visibleCases = useMemo(() => cases.filter(item => {
    if (!belongsToView(item, workspaceView)) return false;
    const filterMatch = filter === "all" || item.status === filter;
    const haystack = `${item.celebrity} ${item.designer} ${item.event_name} ${item.title} ${item.match_type} ${item.fashion_category}`.toLowerCase();
    return filterMatch && haystack.includes(search.trim().toLowerCase());
  }).sort(newestPostFirst), [cases, filter, search, workspaceView]);

  useEffect(() => {
    if (loading) return;
    if (!visibleCases.length) { setSelected(null); return; }
    if (!selected || !visibleCases.some(item => item.id === selected.id)) void openCase(visibleCases[0].id);
  }, [visibleCases, loading]);

  const candidate = selected?.candidates?.[candidateIndex];
  const historicalMatch = candidate ? isHistorical(candidate.proposed_match_type) : false;
  const approvedCandidates = selected?.candidates.filter(item => item.decision?.decision === "approved") || [];
  const previewCandidates = approvedCandidates.length ? approvedCandidates : (candidate ? [candidate] : []);
  const historicalCandidates = previewCandidates.filter(item => isHistorical(item.proposed_match_type));
  const hasHistoricalPlan = historicalCandidates.length > 0;
  const supplementaryAssets = selected?.assets || [];
  const automaticPanelCount = Number((selected?.extraction?.automatic_collage as { panels?: number } | undefined)?.panels || 1);
  const eligibleOriginal = supplementaryAssets.find(item => item.role === "designer_reference" && item.include_in_collage && item.exact_match && item.verified_source && !isBlocked(item.rights_status));
  const currentPostAngles = supplementaryAssets.filter(item => item.role === "current_angle" && item.include_in_collage && item.exact_match && !isBlocked(item.rights_status));
  const plannedAssets = selected ? [
    { id: "today", image_path: selected.base_image, label: "Today" },
    ...currentPostAngles.map(item => ({ id: item.id, image_path: item.image_path, label: "Current angle" })),
    ...historicalCandidates.map(item => ({ id: item.id, image_path: item.image_path, label: item.person })),
    ...(!hasHistoricalPlan && eligibleOriginal ? [{ id: eligibleOriginal.id, image_path: eligibleOriginal.image_path, label: "Original outfit" }] : []),
  ] : [];
  const pendingCount = cases.filter(item => PENDING_STATUSES.has(item.status)).length;
  const reviewedCount = cases.filter(item => REVIEWED_STATUSES.has(item.status)).length;
  const womenCount = cases.filter(item => item.fashion_category === "women").length;
  const menCount = cases.filter(item => item.fashion_category === "men").length;
  const bothCount = cases.filter(item => item.fashion_category === "mixed").length;
  const providersLive = ["rss", "live", "approved_api"].includes(dashboard?.source_mode || "");
  const meta = VIEW_META[workspaceView];
  const editorCatalog = selected?.collage_editor?.panels || [];
  const editorCatalogById = new Map(editorCatalog.map(item => [item.id, item]));
  const editorSelectedPanels = editorPanelIds.map(id => editorCatalogById.get(id)).filter((item): item is CollagePanel => Boolean(item));
  const editorAvailablePanels = editorCatalog.filter(item => !editorPanelIds.includes(item.id));
  const selectedCurrentPanelCount = editorSelectedPanels.filter(item => ["current_primary", "current_angle"].includes(item.role)).length;

  function switchView(next: WorkspaceView) {
    setWorkspaceView(next);
    setFilter("all");
    setSearch("");
    setCandidateIndex(0);
  }

  async function submitDecision() {
    if (!candidate || !decisionMode || reason.trim().length < 12) return setToast("Add a clear editorial reason of at least 12 characters.");
    setDecisionBusy(true);
    try {
      const response = await fetch(`/api/backend/candidates/${candidate.id}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: decisionMode, reason, editor_id: "editor@atelier" }) });
      const data = await response.json();
      if (!response.ok) return setToast(data.detail || "Decision could not be saved.");
      const caseId = selected?.id;
      setToast(`${pretty(decisionMode)} decision saved to the audit trail.`);
      setDecisionMode(null);
      setReason("");
      await load();
      if (caseId && workspaceView !== "pending") await openCase(caseId);
      if (workspaceView === "pending") setSelected(null);
    } finally { setDecisionBusy(false); }
  }

  async function queueResearch() {
    if (!selected) return;
    setResearchBusy(true);
    try {
      const response = await fetch(`/api/backend/cases/${selected.id}/research`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) return setToast(data.detail || "Research could not be queued.");
      setToast(data.search?.status === "unavailable"
        ? "Reddit is rate-limiting archive search; the daily automation will retry without manual work."
        : data.matches
          ? `${data.matches} exact archive match${data.matches === 1 ? "" : "es"} found and the collage was rebuilt.`
          : "Automated Reddit archive search completed; no exact outfit match was forced.");
      await load();
      await openCase(selected.id);
    } finally { setResearchBusy(false); }
  }

  async function generateCollage() {
    if (!selected || !candidate) return;
    setCollageBusy(true);
    try {
      const response = await fetch(`/api/backend/cases/${selected.id}/collage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidate_id: candidate.id }) });
      const data = await response.json();
      if (!response.ok) return setToast(data.detail || "Collage could not be generated.");
      const cacheKey = Date.now();
      setCollageResult({ previewUrl: `${asset(data.preview_url)}?v=${cacheKey}`, bundleUrl: data.bundle_url.replace(/^\/api\//, "/api/backend/"), assetCount: data.asset_count });
      setToast(`${data.asset_count}-image collage and evidence bundle created.`);
    } finally { setCollageBusy(false); }
  }

  function openCollageEditor() {
    if (!selected?.collage_editor) return;
    setEditorPanelIds(selected.collage_editor.selected_ids.length
      ? selected.collage_editor.selected_ids
      : selected.collage_editor.default_ids);
    setEditorPanelOptions(selected.collage_editor.panel_options || {});
    setEditorCollageAdjustments({ ...DEFAULT_IMAGE_ADJUSTMENTS, ...(selected.collage_editor.collage_adjustments || {}) });
    const savedWatermark = selected.collage_editor.watermark;
    setEditorWatermark(savedWatermark ? {
      ...savedWatermark,
      height: savedWatermark.height ?? null,
      adjustments: { ...DEFAULT_IMAGE_ADJUSTMENTS, ...(savedWatermark.adjustments || {}) },
    } : null);
    setTuningPanelId(null);
    setShowCollageEditor(true);
  }

  function panelOption(panelId: string): PanelLayoutOption {
    const saved = editorPanelOptions[panelId] || {};
    return {
      ...DEFAULT_PANEL_OPTION,
      ...saved,
      crop_rect: { ...DEFAULT_CROP_RECT, ...(saved.crop_rect || {}) },
    };
  }

  function updatePanelOption(panelId: string, patch: Partial<PanelLayoutOption>) {
    setEditorPanelOptions(current => ({
      ...current,
      [panelId]: { ...DEFAULT_PANEL_OPTION, ...(current[panelId] || {}), ...patch },
    }));
  }

  function resetCollageLayout() {
    if (!selected?.collage_editor) return;
    setEditorPanelIds(selected.collage_editor.default_ids);
    setEditorPanelOptions({});
    setTuningPanelId(null);
  }

  function moveEditorPanel(index: number, direction: -1 | 1) {
    setEditorPanelIds(current => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function saveCollageEdit() {
    if (!selected || !editorPanelIds.length) return setToast("Keep at least one image from the current source post in the collage.");
    setEditorBusy(true);
    try {
      const selectedOptions = Object.fromEntries(
        editorPanelIds.map(panelId => [panelId, panelOption(panelId)]),
      );
      const response = await fetch(`/api/backend/cases/${selected.id}/collage/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          panel_ids: editorPanelIds,
          panel_options: selectedOptions,
          collage_adjustments: editorCollageAdjustments,
          watermark: editorWatermark ? {
            enabled: editorWatermark.enabled,
            center_x: editorWatermark.center_x,
            center_y: editorWatermark.center_y,
            width: editorWatermark.width,
            height: editorWatermark.height,
            rotation_degrees: editorWatermark.rotation_degrees,
            opacity: editorWatermark.opacity,
            adjustments: editorWatermark.adjustments,
          } : null,
          editor_id: "editor@atelier",
        }),
      });
      const data = await response.json();
      if (!response.ok) return setToast(data.detail || "The collage edit could not be saved.");
      const caseId = selected.id;
      const cacheKey = Date.now();
      setShowCollageEditor(false);
      setCollageResult({
        previewUrl: `${asset(data.preview_url)}?v=${cacheKey}`,
        bundleUrl: data.bundle_url.replace(/^\/api\//, "/api/backend/"),
        assetCount: data.asset_count,
      });
      setToast(`Collage updated with ${data.asset_count} source-backed panel${data.asset_count === 1 ? "" : "s"}${data.watermark?.enabled ? " and the HHC watermark" : ""}.`);
      await openCase(caseId);
    } finally { setEditorBusy(false); }
  }

  async function uploadCollageImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const formElement = event.currentTarget;
    const payload = new FormData(formElement);
    payload.set("editor_id", "editor@atelier");
    setUploadBusy(true);
    try {
      const response = await fetch(`/api/backend/cases/${selected.id}/collage/assets`, { method: "POST", body: payload });
      const data = await response.json();
      if (!response.ok) return setToast(data.detail || "The image could not be uploaded.");
      const caseId = selected.id;
      await openCase(caseId);
      setEditorPanelIds(current => current.includes(data.asset.id) ? current : [...current, data.asset.id]);
      setEditorPanelOptions(current => ({ ...current, [data.asset.id]: { ...DEFAULT_PANEL_OPTION } }));
      setTuningPanelId(data.asset.id);
      formElement.reset();
      setToast("Image added. Adjust its size or crop, then save and re-render.");
    } catch {
      setToast("The image upload could not reach the research service.");
    } finally { setUploadBusy(false); }
  }

  async function uploadWatermark(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const formElement = event.currentTarget;
    const payload = new FormData(formElement);
    payload.set("editor_id", "editor@atelier");
    setWatermarkBusy(true);
    try {
      const response = await fetch(`/api/backend/cases/${selected.id}/collage/watermark`, { method: "POST", body: payload });
      const data = await response.json();
      if (!response.ok) return setToast(data.detail || "The watermark could not be uploaded.");
      setEditorWatermark(data.watermark);
      formElement.reset();
      await openCase(selected.id);
      setToast("Watermark uploaded. Drag, resize or tilt it, then save and re-render.");
    } catch {
      setToast("The watermark upload could not reach the research service.");
    } finally { setWatermarkBusy(false); }
  }

  async function updateFashionCategory(category: CaseSummary["fashion_category"]) {
    if (!selected || selected.fashion_category === category) return;
    setCategoryBusy(true);
    try {
      const response = await fetch(`/api/backend/cases/${selected.id}/fashion-category`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, editor_id: "editor@atelier" }),
      });
      const data = await response.json();
      if (!response.ok) return setToast(data.detail || "The content desk could not be updated.");
      const caseId = selected.id;
      await load(true);
      await openCase(caseId);
      setToast(`Moved to ${category === "mixed" ? "the Both section" : `${pretty(category)}’s fashion`}.`);
    } catch {
      setToast("The content listing could not reach the research service.");
    } finally { setCategoryBusy(false); }
  }

  async function submitIntake(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/backend/intake/reddit-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form.entries())) });
    const data = await response.json();
    if (!response.ok) return setToast(data.detail || "Could not create case.");
    setShowIntake(false);
    setWorkspaceView("today");
    setFilter("all");
    setSearch("");
    setToast("New Reddit case added to Context Review.");
    await load();
    await openCase(data.id);
  }

  async function submitSourceUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = { ...Object.fromEntries(form.entries()), editor_id: "editor@atelier" };
    setSourceImportBusy(true);
    try {
      const response = await fetch("/api/backend/intake/source-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) return setToast(typeof data.detail === "string" ? data.detail : "The public post could not be imported.");
      setShowIntake(false);
      setWorkspaceView("today");
      setFilter("all");
      setSearch("");
      formElement.reset();
      await load();
      await openCase(data.case_id);
      setCollageResult({
        previewUrl: `${asset(data.preview_url)}?v=${Date.now()}`,
        bundleUrl: data.bundle_url.replace(/^\/api\//, "/api/backend/"),
        assetCount: data.asset_count,
      });
      setToast(`${data.platform} post imported with ${data.source_image_count} public image${data.source_image_count === 1 ? "" : "s"}; the research collage is ready.`);
    } catch {
      setToast("The URL importer could not reach the research service.");
    } finally {
      setSourceImportBusy(false);
    }
  }

  return <main className="shell studio-shell">
    <aside className="sidebar studio-sidebar">
      <div className="brand"><span className="brand-mark">H</span><div><strong>High Heel<br/>Confidential</strong><small>Outfit intelligence studio</small></div></div>
      <button type="button" className="edition-card" onClick={() => void load(true)} title="Refresh this daily edition">
        <span><small>Edition</small><strong>{editionCode}</strong></span><Icon name="refresh" size={15}/>
      </button>
      <nav aria-label="Workspace navigation">
        <button type="button" className={`nav-item ${workspaceView === "today" ? "active" : ""}`} onClick={() => switchView("today")} aria-current={workspaceView === "today" ? "page" : undefined}><Icon name="grid"/><span className="nav-copy"><strong>Today&apos;s edit</strong><small>Daily outfit desk</small></span><b>{cases.length}</b></button>
        <button type="button" className={`nav-item ${workspaceView === "women" ? "active" : ""}`} onClick={() => switchView("women")} aria-current={workspaceView === "women" ? "page" : undefined}><Icon name="woman"/><span className="nav-copy"><strong>Women&apos;s fashion</strong><small>Women-only looks</small></span><b>{womenCount}</b></button>
        <button type="button" className={`nav-item ${workspaceView === "men" ? "active" : ""}`} onClick={() => switchView("men")} aria-current={workspaceView === "men" ? "page" : undefined}><Icon name="man"/><span className="nav-copy"><strong>Men&apos;s fashion</strong><small>Men-only looks</small></span><b>{menCount}</b></button>
        <button type="button" className={`nav-item ${workspaceView === "both" ? "active" : ""}`} onClick={() => switchView("both")} aria-current={workspaceView === "both" ? "page" : undefined}><Icon name="both"/><span className="nav-copy"><strong>Both fashion</strong><small>Women &amp; men together</small></span><b>{bothCount}</b></button>
        <button type="button" className={`nav-item ${workspaceView === "pending" ? "active" : ""}`} onClick={() => switchView("pending")} aria-current={workspaceView === "pending" ? "page" : undefined}><Icon name="queue"/><span className="nav-copy"><strong>Pending review</strong><small>Needs your decision</small></span><b>{pendingCount}</b></button>
        <button type="button" className={`nav-item ${workspaceView === "reviewed" ? "active" : ""}`} onClick={() => switchView("reviewed")} aria-current={workspaceView === "reviewed" ? "page" : undefined}><Icon name="archive"/><span className="nav-copy"><strong>Reviewed</strong><small>Completed decisions</small></span><b>{reviewedCount}</b></button>
      </nav>
      <div className="sidebar-spacer"/>
      <div className="system-card"><div className={`pulse ${providersLive ? "" : "standby"}`}/><div><strong>{providersLive ? "Research connected" : "Curated demo mode"}</strong><small>{providersLive ? "Live providers operational" : "Live providers pending"}</small></div></div>
      <div className="profile"><span>SK</span><div><strong>Senior editor</strong><small>Secure demo session</small></div></div>
    </aside>

    <section className="content studio-content">
      <header className="command-bar">
        <div className="workspace-crumb"><span>HHC Studio</span><Icon name="arrow" size={12}/><strong>{meta.label}</strong></div>
        <div className="global-search"><Icon name="search" size={16}/><input ref={searchRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search celebrity, designer, event…" aria-label="Search outfits"/>{search ? <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><Icon name="close" size={13}/></button> : <kbd>/</kbd>}</div>
        <div className="command-actions">
          <button type="button" className="icon-button" onClick={() => void load(true)} title="Refresh" disabled={refreshing}><Icon name="refresh"/></button>
          <button type="button" className="source-import-button" onClick={() => setShowIntake(true)}><Icon name="link"/><span>Import post URL</span></button>
          <button type="button" className="primary" onClick={() => void runAutomation()} disabled={automationBusy} title="Run daily automation" aria-label="Run daily automation"><Icon name={automationBusy ? "refresh" : "spark"}/><span>{automationBusy ? "Building drafts…" : "Run daily automation"}</span></button>
          <button type="button" className="header-logout-button" onClick={logout} title="Log out and use different credentials" aria-label="Log out and return to credential entry"><Icon name="logout" size={16}/><span>Log out</span></button>
        </div>
      </header>

      <header className="editorial-header studio-hero">
        <div className="header-rail"><span>{meta.short} / {editionCode}</span><i/><span>{dateLabel}</span></div>
        <div className="hero-row"><div><div className="eyebrow"><span/>Reddit + editor-selected public posts</div><h1>{meta.title} <em>{meta.accent}</em></h1><p>{meta.description}</p></div><div className="hero-seal"><span>{visibleCases.length.toString().padStart(2, "0")}</span><small>Visible<br/>outfits</small></div></div>
      </header>

      <section className={`provider-strip ${providersLive ? "is-live" : "is-demo"}`} aria-label="Research provider status">
        <div className="provider-summary"><span className="provider-icon"><Icon name={providersLive ? "spark" : "clock"} size={17}/></span><div><small>Research environment</small><strong>{providersLive ? "Live intelligence" : "Curated demonstration"}</strong></div></div>
        <p>{providersLive ? "Reddit discovery and editor-selected public URL imports share title-and-description extraction, archive matching and draft collage rendering." : "The automated Reddit provider is waiting for configuration; public URL intake remains editor initiated."}</p>
        <div className="provider-stages"><span className={providersLive ? "ready" : "waiting"}><i/>Reddit intake<small>{providersLive ? "Automatic" : "Waiting"}</small></span><span className={providersLive ? "ready" : "waiting"}><i/>Look extraction<small>{providersLive ? "Automatic" : "Waiting"}</small></span><span className={providersLive ? "ready" : "waiting"}><i/>Archive search<small>{providersLive ? "Local archive" : "Waiting"}</small></span><span className="ready"><i/>Collage studio<small>Automatic</small></span></div>
      </section>

      <section className="metrics" aria-label="Editorial summary">
        <article><span className="metric-number">01</span><div><small>Outfit cases</small><strong>{dashboard?.total ?? "—"}</strong><span>Current edition</span></div></article>
        <article><span className="metric-number">02</span><div><small>Pending review</small><strong>{pendingCount}</strong><span>Needs a decision</span></div></article>
        <article><span className="metric-number">03</span><div><small>Reviewed</small><strong>{reviewedCount}</strong><span>Approved or closed</span></div></article>
        <article className="guardrail"><div className="guardrail-orbit"><Icon name="shield" size={18}/></div><span>Editorial promise</span><strong>Human taste. Machine speed.</strong><small>Nothing publishes without your final word.</small></article>
      </section>

      <section className="workspace studio-workspace">
        <div className="queue-panel">
          <div className="panel-heading"><div><small>{meta.listKicker}</small><h2>{meta.listTitle}</h2></div><span className="queue-count">{visibleCases.length.toString().padStart(2, "0")}</span></div>
          <div className="filters">{FILTERS[workspaceView].map(item => <button type="button" key={item} className={filter === item ? "selected" : ""} onClick={() => setFilter(item)}>{item === "all" ? "All" : pretty(item)}</button>)}</div>
          <div className="case-list">
            {loading && <div className="loading-card"><i/><span>Preparing the edit…</span></div>}
            {!loading && visibleCases.map((item, index) => <button type="button" key={item.id} className={`case-card ${selected?.id === item.id ? "current" : ""}`} onClick={() => void openCase(item.id)}>
              <span className="case-index">{(index + 1).toString().padStart(2, "0")}</span><div className="case-thumb"><img src={asset(item.base_image)} alt={`${item.celebrity} in ${item.designer}`}/></div>
              <div className="case-copy"><div><StatusPill status={item.status}/><span className={`fashion-chip fashion-${item.fashion_category}`}>{fashionCategoryLabel(item.fashion_category)}</span><span className={`risk risk-${item.risk_level}`}>{item.risk_level}</span></div><strong>{item.celebrity}</strong><p>{item.designer} · {item.event_name}</p><footer><span>{item.event_date || "Date unresolved"}</span><b>{Math.round(item.confidence * 100)}% signal</b></footer></div><Icon name="arrow" size={15}/>
            </button>)}
            {!loading && !visibleCases.length && <div className="empty enhanced-empty"><Icon name="search"/><strong>No matching outfits</strong><span>Clear the search or choose another filter.</span><button type="button" className="ghost" onClick={() => { setSearch(""); setFilter("all"); }}>Reset view</button></div>}
          </div>
        </div>

        <div className="review-panel">
          {!selected ? <div className="review-empty"><span>HHC</span><h2>No outfit selected</h2><p>Choose a look from the rail to open its editorial file.</p></div> : <>
            <div className="review-heading"><div><div className="review-meta"><StatusPill status={selected.status}/><span className={`fashion-chip fashion-${selected.fashion_category}`}>{selected.fashion_category === "unclassified" ? "Content desk open" : fashionCategoryLabel(selected.fashion_category)}</span>{selected.demo_data && <span className="demo-chip">Demonstration</span>}</div><h2>{selected.celebrity}</h2><p><b>{selected.designer}</b><i/>{selected.event_name}</p></div><div className="review-heading-actions"><div className="category-editor"><small>Content listing</small><div>{(["women", "men", "mixed"] as const).map(category => <button type="button" key={category} className={selected.fashion_category === category ? "active" : ""} onClick={() => void updateFashionCategory(category)} disabled={categoryBusy}>{category === "mixed" ? "Both" : pretty(category)}</button>)}</div></div><a className="source-link" href={selected.permalink} target="_blank" rel="noreferrer"><Icon name="external"/>{selected.source_type === "reddit_rss" ? "Reddit source" : "Public source"}</a></div></div>

            {selected.latest_collage && <section className="automatic-draft-card">
              <div className="automatic-draft-image"><img src={asset(selected.latest_collage.preview_url)} alt={`Automatic collage for ${selected.celebrity}`}/><span>Generated automatically</span></div>
              <div className="automatic-draft-copy"><small>Today’s ready-to-review output</small><h3>Single-image collage complete</h3><p>Every usable image from the source post is arranged edge-to-edge in one collage, followed by the historical or exact original-outfit comparison when available.</p><div><span><Icon name="check" size={13}/>{automaticPanelCount} source panel{automaticPanelCount === 1 ? "" : "s"} in one image</span><span><Icon name="shield" size={13}/>Draft only — never auto-published</span></div><footer><button type="button" className="primary" onClick={() => setCollageResult({ previewUrl: asset(selected.latest_collage!.preview_url), bundleUrl: selected.latest_collage!.bundle_url.replace(/^\/api\//, "/api/backend/"), assetCount: automaticPanelCount })}><Icon name="eye"/>View collage</button><button type="button" className="ghost" onClick={openCollageEditor}><Icon name="edit"/>Edit collage &amp; sources</button><a className="ghost" href={selected.latest_collage.bundle_url.replace(/^\/api\//, "/api/backend/")} target="_blank" rel="noreferrer"><Icon name="download"/>Evidence bundle</a></footer></div>
            </section>}

            {!candidate && <>
              <AssetBoard assets={supplementaryAssets}/>
              <div className="no-candidate-state"><span><Icon name="search" size={22}/></span><small>Archive discovery</small><h3>No exact historical match found yet</h3><p>This source-only collage was still created automatically. Research can recheck the growing Reddit and imported-post archive using the title, description, designer attribution and image signals.</p><button type="button" className="primary" onClick={() => void queueResearch()} disabled={researchBusy}>{researchBusy ? "Checking sources…" : "Check for new outfits now"}</button></div>
            </>}

            {candidate && <>
              {selected.candidates.length > 1 && <div className="candidate-rail"><span>Research candidates</span><div>{selected.candidates.map((item, index) => <button type="button" key={item.id} className={candidateIndex === index ? "active" : ""} onClick={() => setCandidateIndex(index)}><b>{(index + 1).toString().padStart(2, "0")}</b>{item.person}<small>{Math.round(item.visual_score * 100)}%</small></button>)}</div></div>}
              <div className="comparison">
                <figure><div className="image-label"><span>Today / Source look</span><b>{selected.event_date || "Date open"}</b></div><div className="image-mat"><img src={asset(selected.base_image)} alt={`${selected.celebrity} wearing ${selected.designer}`}/></div>{selected.demo_data && <span className="demo-image-stamp">Demo visual · live media pending</span>}<figcaption><span>01</span><div><small>Current appearance</small><strong>{selected.celebrity}</strong><p>{selected.event_name}</p></div></figcaption></figure>
                <div className="compare-axis"><span>+</span><i/></div>
                <figure><div className="image-label candidate"><span>Archive / Related look</span><b>{candidate.event_date || "Date open"}</b></div><div className="image-mat"><img src={asset(candidate.image_path)} alt={`${candidate.person} wearing ${candidate.designer}`}/></div>{selected.demo_data && <span className="demo-image-stamp">Demo visual · live archive pending</span>}<figcaption><span>02</span><div><small>Research candidate</small><strong>{candidate.person}</strong><p>{candidate.event_name}</p></div></figcaption></figure>
              </div>
              <div className="storyline"><span>Why they belong together</span><p>{pretty(candidate.proposed_match_type)} · researched through title, description, designer attribution and garment landmarks.</p></div>
              <AssetBoard assets={supplementaryAssets}/>
              <section className="collage-blueprint" aria-label="Planned collage treatment"><div className="blueprint-copy"><small>Proposed story treatment</small><strong>{historicalMatch ? "Then & now outfit story" : "Complete multi-angle outfit study"}</strong><p>{historicalMatch ? "Place every current-post image and each approved historical match into one edge-to-edge collage." : "Place every current-post image and the verified original outfit, when available, into one edge-to-edge collage."}</p></div><div className="blueprint-preview" aria-hidden>{plannedAssets.slice(0, 6).map(item => <div key={item.id}><img src={asset(item.image_path)} alt=""/><span>{item.label}</span></div>)}</div><div className="blueprint-output"><small>One final image</small><strong>{plannedAssets.length} full-frame panels</strong><span>Edge-to-edge · zero gaps · source-tracked</span></div></section>
              <div className="assessment-strip"><div><small>Relationship</small><strong>{pretty(candidate.proposed_match_type)}</strong></div><div><small>Visual signal</small><strong>{Math.round(candidate.visual_score * 100)}%</strong><span>Discovery aid</span></div><div><small>Source quality</small><strong className={`grade grade-${candidate.source_grade}`}>Grade {candidate.source_grade}</strong><span>{candidate.evidence[0]?.publisher}</span></div><div><small>Image rights</small><strong>{pretty(candidate.rights_status)}</strong></div></div>
              <div className="evidence-grid"><section className="evidence-card"><div className="section-title"><div><small>Editorial verification</small><h3>The confidence file</h3></div><span>{candidate.checks.contradictions?.length ? "Review conflict" : "Clear"}</span></div><ul className="checks"><li className={!candidate.checks.same_photo ? "pass" : "fail"}><span><Icon name={!candidate.checks.same_photo ? "check" : "close"}/></span><div><strong>Original image check</strong><small>{candidate.checks.same_photo ? "Image hash indicates a duplicate" : "A distinct source photograph was found"}</small></div></li><li className={!candidate.checks.same_event ? "pass" : "fail"}><span><Icon name={!candidate.checks.same_event ? "check" : "close"}/></span><div><strong>Appearance check</strong><small>{candidate.checks.same_event ? "The same event and date were detected" : "This is an independently eligible appearance"}</small></div></li><li className={candidate.checks.identity ? "pass" : "warn"}><span><Icon name={candidate.checks.identity ? "check" : "search"}/></span><div><strong>Garment identity</strong><small>{candidate.checks.identity ? `Aligned: ${candidate.checks.landmarks?.join(", ")}` : "Stronger source support is still needed"}</small></div></li></ul></section><section className="source-card"><div className="section-title"><div><small>Provenance</small><h3>Source notes</h3></div><span className={`grade grade-${candidate.source_grade}`}>{candidate.source_grade}</span></div>{candidate.evidence.map((item, index) => <a href={item.url} target="_blank" rel="noreferrer" className="evidence-source" key={index}><div className="source-monogram">{item.publisher.slice(0, 2).toUpperCase()}</div><div><strong>{item.publisher}</strong><p>{item.quote}</p><small>Open source <Icon name="external" size={11}/></small></div></a>)}</section></div>
              <div className="action-bar"><div><small>Editor’s verdict</small><strong>{candidate.decision ? pretty(candidate.decision.decision) : "Awaiting your decision"}</strong></div><button type="button" className="ghost" onClick={() => void queueResearch()} disabled={researchBusy}>{researchBusy ? "Queuing…" : "Research more"}</button><button type="button" className="ghost" onClick={() => setDecisionMode("similar_not_same")}>Not the same</button><button type="button" className="reject" onClick={() => setDecisionMode("rejected")}><Icon name="close"/>Reject</button><button type="button" className="approve" onClick={() => setDecisionMode("approved")}><Icon name="check"/>Approve story</button>{candidate.decision?.decision === "approved" && <button type="button" className="download" onClick={() => void generateCollage()} disabled={collageBusy}><Icon name={collageBusy ? "refresh" : "image"}/>{collageBusy ? "Rendering…" : "Preview collage"}</button>}</div>
            </>}
          </>}
        </div>
      </section>
      <footer className="page-footer"><span>High Heel Confidential</span><i/>Editorial research, accelerated.</footer>
    </section>

    {decisionMode && <div className="modal-backdrop" onMouseDown={() => setDecisionMode(null)}><section className="decision-modal" onMouseDown={event => event.stopPropagation()}><div className="modal-icon"><Icon name={decisionMode === "approved" ? "check" : decisionMode === "rejected" ? "close" : "search"}/></div><div className="modal-title"><small>Editorial action</small><h2>{pretty(decisionMode)}</h2><p>Capture the judgment behind this decision. The note becomes part of the permanent evidence trail.</p></div><label>Decision rationale<textarea autoFocus value={reason} onChange={event => setReason(event.target.value)} placeholder="Describe the source and visual evidence behind this decision…"/></label><div className="modal-note"><Icon name="shield"/><span>Approval remains blocked when identity, duplicate, source or image-rights checks fail.</span></div><footer><button type="button" className="ghost" onClick={() => setDecisionMode(null)}>Cancel</button><button type="button" className={decisionMode === "approved" ? "approve" : "primary"} onClick={() => void submitDecision()} disabled={decisionBusy}>{decisionBusy ? "Saving…" : "Save verdict"}</button></footer></section></div>}

    {showIntake && <div className="modal-backdrop" onMouseDown={() => !sourceImportBusy && setShowIntake(false)}><section className="intake-modal source-intake-modal" role="dialog" aria-modal="true" aria-labelledby="source-intake-title" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title"><small>Editor-selected source</small><h2 id="source-intake-title">Import a public fashion post</h2><p>Paste a public post URL. The studio will collect exposed title, caption and images, identify the outfit, search the archive, and create the same editable collage workflow used for Reddit.</p></div>
      <form className="source-url-intake" onSubmit={submitSourceUrl}>
        <label>Public post URL<input autoFocus required name="source_url" type="url" placeholder="https://www.instagram.com/p/…" disabled={sourceImportBusy}/></label>
        <div className="source-support-list"><span>Instagram</span><span>Threads</span><span>X</span><span>Facebook</span><span>Pinterest</span><span>TikTok</span><span>YouTube</span><span>Reddit</span></div>
        <details className="source-context-hints"><summary><span>Add optional outfit context</span><small>Useful when the caption omits a name or designer</small></summary><div><label>Searchable title<input name="title_hint" placeholder="Celebrity in Designer at Event" maxLength={500} disabled={sourceImportBusy}/></label><div className="form-row"><label>Celebrity<input name="celebrity" placeholder="Auto-detect" maxLength={180} disabled={sourceImportBusy}/></label><label>Designer<input name="designer" placeholder="Auto-detect" maxLength={180} disabled={sourceImportBusy}/></label></div><label>Event<input name="event_name" placeholder="Auto-detect" maxLength={240} disabled={sourceImportBusy}/></label><label>Extra searchable description<textarea name="description_hint" placeholder="Garment, colour, collection or designer details…" maxLength={3000} disabled={sourceImportBusy}/></label></div></details>
        <div className="modal-note"><Icon name="shield"/><span>Public media only. Private or login-gated posts are not bypassed. Imported images remain draft-only and require credit and publication-rights review.</span></div>
        <footer><button type="button" className="ghost" onClick={() => setShowIntake(false)} disabled={sourceImportBusy}>Cancel</button><button className="primary" type="submit" disabled={sourceImportBusy}><Icon name={sourceImportBusy ? "refresh" : "link"}/>{sourceImportBusy ? "Importing & researching…" : "Import & create collage"}</button></footer>
      </form>
      <details className="manual-reddit-intake"><summary><span>Manual Reddit intake</span><small>Use when automated media extraction is unavailable</small></summary><form onSubmit={submitIntake}><label>Reddit permalink<input required name="reddit_url" type="url" placeholder="https://www.reddit.com/r/BollywoodFashion/comments/…"/></label><label>Post title<input required name="title" placeholder="Celebrity in Designer at Event"/></label><div className="form-row"><label>Celebrity<input name="celebrity" placeholder="Unresolved"/></label><label>Designer<input name="designer" placeholder="Unresolved"/></label></div><label>Event<input name="event_name" placeholder="Unresolved"/></label><label>Description<textarea name="body" placeholder="Paste the source description or add editor notes…"/></label><footer><button className="ghost" type="submit">Create context-review case</button></footer></form></details>
    </section></div>}

    {showCollageEditor && selected && <div className="modal-backdrop collage-editor-backdrop" onMouseDown={() => !editorBusy && setShowCollageEditor(false)}><section className="collage-editor-modal" role="dialog" aria-modal="true" aria-labelledby="collage-editor-title" onMouseDown={event => event.stopPropagation()}>
      <header><div><small>Collage workspace</small><h2 id="collage-editor-title">Edit this collage.</h2><p>Reorder, replace, resize, or crop each image, then review its fashion-archive history and source rights in the same panel.</p></div><button type="button" className="modal-close" onClick={() => setShowCollageEditor(false)} disabled={editorBusy} aria-label="Close collage editor"><Icon name="close"/></button></header>
      <div className="collage-editor-summary"><span><b>{editorSelectedPanels.length}</b> selected panels</span><span><Icon name="shield" size={13}/>Source and rights metadata stay attached</span><span>{editorWatermark?.enabled ? "HHC watermark ready" : "Watermark optional"}</span></div>
      <div className="collage-editor-body">
        <section className="selected-panel-list"><div className="editor-section-heading"><div><small>Final image order</small><h3>Panels in collage</h3></div><button type="button" onClick={resetCollageLayout}>Reset automatic layout</button></div>
          <div className="panel-sort-list">{editorSelectedPanels.map((panel, index) => {
            const requiredCurrent = ["current_primary", "current_angle"].includes(panel.role) && selectedCurrentPanelCount === 1;
            const option = panelOption(panel.id);
            const tuning = tuningPanelId === panel.id;
            return <article className={`panel-sort-card ${tuning ? "is-tuning" : ""}`} key={panel.id}>
              <span className="panel-order">{(index + 1).toString().padStart(2, "0")}</span>
              <img src={asset(panel.image_path)} alt={panel.label} style={{ objectFit: option.crop_mode === "crop" ? "cover" : "contain", objectPosition: `${option.focal_x * 100}% ${option.focal_y * 100}%` }}/>
              <div><small>{pretty(panel.role)}</small><strong>{panel.person || panel.label}</strong><p>{panel.label} · Grade {panel.source_grade}</p></div>
              <div className="panel-controls">
                <button type="button" className={tuning ? "active" : ""} onClick={() => setTuningPanelId(current => current === panel.id ? null : panel.id)} aria-label={`Resize or crop ${panel.label}`} aria-expanded={tuning} title="Resize or crop"><Icon name="tune" size={15}/></button>
                <button type="button" onClick={() => moveEditorPanel(index, -1)} disabled={index === 0} aria-label={`Move ${panel.label} up`}><Icon name="up" size={15}/></button>
                <button type="button" onClick={() => moveEditorPanel(index, 1)} disabled={index === editorSelectedPanels.length - 1} aria-label={`Move ${panel.label} down`}><Icon name="down" size={15}/></button>
                <button type="button" className="remove" onClick={() => { setEditorPanelIds(current => current.filter(id => id !== panel.id)); setEditorPanelOptions(current => { const next = { ...current }; delete next[panel.id]; return next; }); if (tuning) setTuningPanelId(null); }} disabled={requiredCurrent || editorSelectedPanels.length === 1} aria-label={`Remove ${panel.label}`} title={requiredCurrent ? "Keep at least one current source image" : "Remove panel"}><Icon name="trash" size={15}/></button>
              </div>
              {tuning && <div className="panel-tuning">
                <div className="panel-tuning-heading"><div><small>Image layout</small><strong>Resize &amp; crop</strong></div><button type="button" onClick={() => updatePanelOption(panel.id, DEFAULT_PANEL_OPTION)}>Reset image</button></div>
                <label className="panel-range"><span>Panel width <b>{Math.round(option.width_scale * 100)}%</b></span><input type="range" min="65" max="175" step="5" value={Math.round(option.width_scale * 100)} onChange={event => updatePanelOption(panel.id, { width_scale: Number(event.target.value) / 100 })}/><small>Narrower</small><small>Wider</small></label>
                <div className="crop-mode-control"><span>Image treatment</span><div><button type="button" className={option.crop_mode === "fit" ? "active" : ""} onClick={() => updatePanelOption(panel.id, { crop_mode: "fit", zoom: 1 })}>Show full image</button><button type="button" className={option.crop_mode === "crop" ? "active" : ""} onClick={() => updatePanelOption(panel.id, { crop_mode: "crop", crop_rect: option.crop_rect || { ...DEFAULT_CROP_RECT } })}>Manual crop</button></div><p>{option.crop_mode === "fit" ? "The complete photo stays visible; a soft background fills extra space." : "Draw and resize a freeform box to remove page text, banners, products, or any other unwanted area."}</p></div>
                {option.crop_mode === "crop" && <ManualCropEditor image={asset(panel.image_path)} label={panel.label} option={option} onChange={patch => updatePanelOption(panel.id, patch)}/>} 
              </div>}
            </article>;
          })}</div>
        </section>
        <aside className="available-panel-list"><div className="editor-section-heading"><div><small>Replacement library</small><h3>Available images</h3></div><span>{editorAvailablePanels.length}</span></div>
          <CollageArchiveRights selected={selected}/>
          <CollageAdjustmentEditor
            baseImage={asset(selected.latest_collage?.source_preview_url || selected.latest_collage?.base_preview_url || selected.latest_collage?.preview_url || "")}
            adjustments={editorCollageAdjustments}
            onChange={setEditorCollageAdjustments}
          />
          <WatermarkEditor
            baseImage={asset(selected.latest_collage?.source_preview_url || selected.latest_collage?.base_preview_url || selected.latest_collage?.preview_url || "")}
            collageAdjustments={editorCollageAdjustments}
            watermark={editorWatermark}
            onChange={setEditorWatermark}
            onUpload={uploadWatermark}
            uploadBusy={watermarkBusy}
          />
          <details className="editor-upload-panel">
            <summary><span><Icon name="upload" size={15}/><b>Upload your own image</b></span><small>JPEG, PNG or WebP · up to 20 MB</small></summary>
            <form onSubmit={uploadCollageImage}>
              <label className="upload-file"><span>Choose image</span><input name="image" type="file" accept="image/jpeg,image/png,image/webp" required disabled={uploadBusy}/></label>
              <div className="upload-form-row"><label>Panel label<input name="label" defaultValue="Editor-supplied comparison" maxLength={180} required disabled={uploadBusy}/></label><label>Person/model<input name="person" placeholder={selected.celebrity} maxLength={180} disabled={uploadBusy}/></label></div>
              <label>Original source URL <em>optional</em><input name="source_url" type="url" placeholder="https://…" disabled={uploadBusy}/></label>
              <label>Image credit<input name="credit" placeholder="Photographer, agency, publication or owner" maxLength={300} required disabled={uploadBusy}/></label>
              <label className="rights-confirm"><input name="rights_confirmed" type="checkbox" value="true" required disabled={uploadBusy}/><span>I confirm this image may be stored and used in an internal editorial draft. Publishing rights will still be reviewed.</span></label>
              <button type="submit" disabled={uploadBusy}><Icon name={uploadBusy ? "refresh" : "upload"} size={14}/>{uploadBusy ? "Uploading…" : "Upload & add panel"}</button>
            </form>
          </details>
          {editorAvailablePanels.length ? <div className="available-panel-grid">{editorAvailablePanels.map(panel => <article key={panel.id}><img src={asset(panel.image_path)} alt={panel.label}/><div><small>{pretty(panel.role)}</small><strong>{panel.person || panel.label}</strong><p>{panel.publisher}</p><button type="button" onClick={() => setEditorPanelIds(current => [...current, panel.id])}><Icon name="plus" size={13}/>Add to collage</button></div></article>)}</div> : <div className="all-panels-used"><Icon name="check"/><strong>All available images are selected.</strong><span>Remove a panel to swap it for another source image.</span></div>}
        </aside>
      </div>
      <footer><div><Icon name="shield"/><span>This saves a new draft and audit entry. It does not publish to WordPress.</span></div><div><button type="button" className="ghost" onClick={() => setShowCollageEditor(false)} disabled={editorBusy}>Cancel</button><button type="button" className="download" onClick={() => void saveCollageEdit()} disabled={editorBusy || !editorPanelIds.length}><Icon name={editorBusy ? "refresh" : "image"}/>{editorBusy ? "Rendering…" : "Save & re-render"}</button></div></footer>
    </section></div>}

    {collageResult && <div className="modal-backdrop collage-backdrop" onMouseDown={() => setCollageResult(null)}><section className="collage-result-modal" onMouseDown={event => event.stopPropagation()}><header><div><small>Render complete</small><h2>Your outfit collage is ready.</h2><p>{collageResult.assetCount} source-backed images with the saved panel sizes, crops, manifest and evidence bundle.</p></div><button type="button" className="modal-close" onClick={() => setCollageResult(null)} aria-label="Close"><Icon name="close"/></button></header><div className="collage-result-frame"><img src={collageResult.previewUrl} alt="Generated outfit collage preview"/></div><footer><span><Icon name="check"/>Saved layout applied · originals untouched</span><div><a className="ghost" href={collageResult.bundleUrl} target="_blank" rel="noreferrer"><Icon name="download"/>Evidence bundle</a><a className="download" href={collageResult.previewUrl} target="_blank" rel="noreferrer"><Icon name="external"/>Open full size</a></div></footer></section></div>}
    {toast && <div className="toast" role="status" aria-live="polite"><Icon name="spark"/><span>{toast}</span></div>}
  </main>;
}
