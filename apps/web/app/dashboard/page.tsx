"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type WorkspaceView = "today" | "women" | "men" | "queue" | "archive" | "rights";
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
type PanelLayoutOption = {
  width_scale: number;
  crop_mode: "fit" | "crop";
  focal_x: number;
  focal_y: number;
  zoom: number;
};
type CollageEditor = {
  panels: CollagePanel[];
  default_ids: string[];
  selected_ids: string[];
  panel_options: Record<string, PanelLayoutOption>;
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
  latest_collage?: { id: string; preview_url: string; bundle_url: string; created_at: string } | null;
};
type CollageResult = { previewUrl: string; bundleUrl: string; assetCount: number };

const REVIEW_STATUSES = new Set(["review_ready", "context_review", "needs_research", "research_queued"]);
const ARCHIVE_STATUSES = new Set(["approved", "rejected", "auto_rejected", "similar_not_same"]);
const DEFAULT_PANEL_OPTION: PanelLayoutOption = { width_scale: 1, crop_mode: "fit", focal_x: .5, focal_y: .5, zoom: 1 };

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
    description: "Women’s and mixed-celebrity looks from the daily Reddit intake, with outfit research and collage status together.",
    listTitle: "Women’s looks",
    listKicker: "Dedicated content desk",
  },
  men: {
    label: "Men’s fashion",
    short: "Men’s desk",
    title: "Men’s fashion intelligence.",
    accent: "A sharper menswear archive.",
    description: "Men’s and mixed-celebrity looks separated into a focused listing without losing their shared editorial evidence.",
    listTitle: "Men’s looks",
    listKicker: "Dedicated content desk",
  },
  queue: {
    label: "Review queue",
    short: "Decisions",
    title: "Your editorial queue.",
    accent: "Resolve what needs a human eye.",
    description: "Review context gaps, verify garment identity and make defensible decisions before any collage is produced.",
    listTitle: "Awaiting action",
    listKicker: "Human review",
  },
  archive: {
    label: "Fashion archive",
    short: "History",
    title: "The outfit archive.",
    accent: "Approved stories and closed leads.",
    description: "Search completed outfit research, revisit approved comparisons and regenerate source-backed collage bundles.",
    listTitle: "Resolved stories",
    listKicker: "Editorial memory",
  },
  rights: {
    label: "Rights desk",
    short: "Sources",
    title: "Image rights, made visible.",
    accent: "Know every source before use.",
    description: "Inspect source grade, official status, exact-outfit verification and usage restrictions for every panel.",
    listTitle: "Source cases",
    listKicker: "Provenance desk",
  },
};

const FILTERS: Record<WorkspaceView, string[]> = {
  today: ["all", "review_ready", "context_review", "needs_research", "approved"],
  women: ["all", "review_ready", "context_review", "needs_research", "approved"],
  men: ["all", "review_ready", "context_review", "needs_research", "approved"],
  queue: ["all", "review_ready", "context_review", "needs_research", "research_queued"],
  archive: ["all", "approved", "auto_rejected", "rejected", "similar_not_same"],
  rights: ["all", "low", "medium", "high"],
};

const pretty = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
const asset = (path: string) => path.startsWith("http") ? path : path.startsWith("/static/") || path.startsWith("/outputs/") || path.startsWith("/media-files/") ? `/media${path}` : path;
const isHistorical = (value: string) => /^(same_item|same_outfit)_/.test(value);
const isBlocked = (value: string) => ["do_not_use", "blocked", "unknown_blocked"].includes(value);
const assetRoleLabel = (role: OutfitAsset["role"]) => role === "designer_reference" ? "Original outfit" : role === "editor_upload" ? "Editor upload" : "Current angle";

function belongsToView(item: CaseSummary, view: WorkspaceView) {
  if (view === "women") return ["women", "mixed"].includes(item.fashion_category);
  if (view === "men") return ["men", "mixed"].includes(item.fashion_category);
  if (view === "queue") return REVIEW_STATUSES.has(item.status);
  if (view === "archive") return ARCHIVE_STATUSES.has(item.status);
  return true;
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
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 15v5h16v-5"/></>,
    tune: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[name]}</svg>;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status status-${status}`}><i />{pretty(status)}</span>;
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

function RightsCard({ image, eyebrow, title, subtitle, status, source, exact, official }: { image: string; eyebrow: string; title: string; subtitle: string; status: string; source: string; exact: boolean; official?: boolean }) {
  const blocked = isBlocked(status);
  return <article className={`rights-card ${blocked ? "is-blocked" : ""}`}>
    <div className="rights-image"><img src={asset(image)} alt={title}/><span>{eyebrow}</span></div>
    <div className="rights-copy">
      <div className="rights-tags"><span className={blocked ? "blocked" : "pending"}>{blocked ? "Blocked" : pretty(status)}</span>{official && <span className="official">Official source</span>}{exact && <span className="exact">Exact outfit</span>}</div>
      <h3>{title}</h3><p>{subtitle}</p>
      {source ? <a href={source} target="_blank" rel="noreferrer"><Icon name="external" size={12}/>Inspect original source</a> : <span className="missing-source">Source URL missing</span>}
    </div>
  </article>;
}

function RightsWorkspace({ selected }: { selected: CaseDetail | null }) {
  if (!selected) return <div className="review-empty"><span>RD</span><h2>Select a source case</h2><p>Rights and provenance details will appear here.</p></div>;
  const allStatuses = ["editorial_review_required", ...selected.candidates.map(item => item.rights_status), ...selected.assets.map(item => item.rights_status)];
  const blocked = allStatuses.filter(isBlocked).length;
  const official = selected.assets.filter(item => item.verified_source).length;
  return <div className="rights-workspace">
    <header className="rights-hero">
      <div><small>Rights dossier / {selected.designer}</small><h2>{selected.celebrity}</h2><p>{selected.event_name} · {selected.event_date || "Date unresolved"}</p></div>
      <a href={selected.permalink} target="_blank" rel="noreferrer"><Icon name="external"/>Open Reddit source</a>
    </header>
    <div className="rights-summary">
      <div><small>Source panels</small><strong>{allStatuses.length}</strong></div>
      <div><small>Verified product looks</small><strong>{official}</strong></div>
      <div><small>Blocked assets</small><strong>{blocked}</strong></div>
      <div><small>Publishing state</small><strong>{blocked ? "Hold" : "Review required"}</strong></div>
    </div>
    <div className="rights-notice"><Icon name="shield"/><div><strong>A URL is not a publishing licence.</strong><span>Confirm photographer, agency and designer credit terms before WordPress publication.</span></div></div>
    <div className="rights-grid">
      <RightsCard image={selected.base_image} eyebrow="Current Reddit image" title={selected.celebrity} subtitle={selected.event_name} status="editorial_review_required" source={selected.permalink} exact />
      {selected.candidates.map(item => <RightsCard key={item.id} image={item.image_path} eyebrow="Historical candidate" title={item.person} subtitle={`${item.event_name} · Grade ${item.source_grade}`} status={item.rights_status} source={item.evidence[0]?.url || ""} exact={Boolean(item.checks.identity)} />)}
      {selected.assets.map(item => <RightsCard key={item.id} image={item.image_path} eyebrow={item.role === "designer_reference" ? "Original product look" : item.role === "editor_upload" ? "Editor upload" : "Current angle"} title={item.label} subtitle={`${item.publisher} · Grade ${item.source_grade}`} status={item.rights_status} source={item.source_url} exact={item.exact_match} official={item.verified_source} />)}
    </div>
  </div>;
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
  const [tuningPanelId, setTuningPanelId] = useState<string | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
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
    const filterMatch = filter === "all" || (workspaceView === "rights" ? item.risk_level === filter : item.status === filter);
    const haystack = `${item.celebrity} ${item.designer} ${item.event_name} ${item.title} ${item.match_type} ${item.fashion_category}`.toLowerCase();
    return filterMatch && haystack.includes(search.trim().toLowerCase());
  }), [cases, filter, search, workspaceView]);

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
  const queueCount = cases.filter(item => REVIEW_STATUSES.has(item.status)).length;
  const archiveCount = cases.filter(item => ARCHIVE_STATUSES.has(item.status)).length;
  const womenCount = cases.filter(item => ["women", "mixed"].includes(item.fashion_category)).length;
  const menCount = cases.filter(item => ["men", "mixed"].includes(item.fashion_category)).length;
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
      if (caseId && workspaceView !== "queue") await openCase(caseId);
      if (workspaceView === "queue") setSelected(null);
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
    setTuningPanelId(null);
    setShowCollageEditor(true);
  }

  function panelOption(panelId: string): PanelLayoutOption {
    return { ...DEFAULT_PANEL_OPTION, ...(editorPanelOptions[panelId] || {}) };
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
    if (!selected || !editorPanelIds.length) return setToast("Keep at least one current Reddit image in the collage.");
    setEditorBusy(true);
    try {
      const selectedOptions = Object.fromEntries(
        editorPanelIds.map(panelId => [panelId, panelOption(panelId)]),
      );
      const response = await fetch(`/api/backend/cases/${selected.id}/collage/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ panel_ids: editorPanelIds, panel_options: selectedOptions, editor_id: "editor@atelier" }),
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
      setToast(`Collage updated with ${data.asset_count} source-backed panel${data.asset_count === 1 ? "" : "s"}.`);
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
      setToast(`Moved to ${category === "mixed" ? "both fashion desks" : `${pretty(category)}’s fashion`}.`);
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

  return <main className="shell studio-shell">
    <aside className="sidebar studio-sidebar">
      <div className="brand"><span className="brand-mark">H</span><div><strong>High Heel<br/>Confidential</strong><small>Outfit intelligence studio</small></div></div>
      <button type="button" className="edition-card" onClick={() => void load(true)} title="Refresh this daily edition">
        <span><small>Edition</small><strong>{editionCode}</strong></span><Icon name="refresh" size={15}/>
      </button>
      <nav aria-label="Workspace navigation">
        <button type="button" className={`nav-item ${workspaceView === "today" ? "active" : ""}`} onClick={() => switchView("today")} aria-current={workspaceView === "today" ? "page" : undefined}><Icon name="grid"/><span className="nav-copy"><strong>Today&apos;s edit</strong><small>Daily outfit desk</small></span><b>{cases.length}</b></button>
        <button type="button" className={`nav-item ${workspaceView === "women" ? "active" : ""}`} onClick={() => switchView("women")} aria-current={workspaceView === "women" ? "page" : undefined}><Icon name="woman"/><span className="nav-copy"><strong>Women&apos;s fashion</strong><small>Women &amp; mixed looks</small></span><b>{womenCount}</b></button>
        <button type="button" className={`nav-item ${workspaceView === "men" ? "active" : ""}`} onClick={() => switchView("men")} aria-current={workspaceView === "men" ? "page" : undefined}><Icon name="man"/><span className="nav-copy"><strong>Men&apos;s fashion</strong><small>Men &amp; mixed looks</small></span><b>{menCount}</b></button>
        <button type="button" className={`nav-item ${workspaceView === "queue" ? "active" : ""}`} onClick={() => switchView("queue")} aria-current={workspaceView === "queue" ? "page" : undefined}><Icon name="queue"/><span className="nav-copy"><strong>Review queue</strong><small>Needs your decision</small></span><b>{queueCount}</b></button>
        <button type="button" className={`nav-item ${workspaceView === "archive" ? "active" : ""}`} onClick={() => switchView("archive")} aria-current={workspaceView === "archive" ? "page" : undefined}><Icon name="archive"/><span className="nav-copy"><strong>Fashion archive</strong><small>Resolved outfit stories</small></span><b>{archiveCount}</b></button>
        <button type="button" className={`nav-item ${workspaceView === "rights" ? "active" : ""}`} onClick={() => switchView("rights")} aria-current={workspaceView === "rights" ? "page" : undefined}><Icon name="shield"/><span className="nav-copy"><strong>Rights desk</strong><small>Sources and usage</small></span><b>{dashboard?.rights_pending || 0}</b></button>
      </nav>
      <button type="button" className="sidebar-add" onClick={() => void runAutomation()} disabled={automationBusy}><Icon name={automationBusy ? "refresh" : "spark"}/><span>{automationBusy ? "Building today’s drafts…" : "Run daily automation"}</span></button>
      <div className="sidebar-spacer"/>
      <div className="system-card"><div className={`pulse ${providersLive ? "" : "standby"}`}/><div><strong>{providersLive ? "Research connected" : "Curated demo mode"}</strong><small>{providersLive ? "Live providers operational" : "Live providers pending"}</small></div></div>
      <div className="profile"><span>SK</span><div><strong>Senior editor</strong><small>Secure demo session</small></div><button type="button" className="logout-button" onClick={logout} title="Sign out"><Icon name="close"/></button></div>
    </aside>

    <section className="content studio-content">
      <header className="command-bar">
        <div className="workspace-crumb"><span>HHC Studio</span><Icon name="arrow" size={12}/><strong>{meta.label}</strong></div>
        <div className="global-search"><Icon name="search" size={16}/><input ref={searchRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search celebrity, designer, event…" aria-label="Search outfits"/>{search ? <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><Icon name="close" size={13}/></button> : <kbd>/</kbd>}</div>
        <div className="command-actions"><button type="button" className="icon-button" onClick={() => void load(true)} title="Refresh" disabled={refreshing}><Icon name="refresh"/></button><button type="button" className="primary" onClick={() => void runAutomation()} disabled={automationBusy}><Icon name={automationBusy ? "refresh" : "spark"}/>{automationBusy ? "Building drafts…" : "Run daily automation"}</button></div>
      </header>

      <header className="editorial-header studio-hero">
        <div className="header-rail"><span>{meta.short} / {editionCode}</span><i/><span>{dateLabel}</span></div>
        <div className="hero-row"><div><div className="eyebrow"><span/>{workspaceView === "rights" ? "Source governance" : "Curated from r/BollywoodFashion"}</div><h1>{meta.title} <em>{meta.accent}</em></h1><p>{meta.description}</p></div><div className="hero-seal"><span>{visibleCases.length.toString().padStart(2, "0")}</span><small>Visible<br/>outfits</small></div></div>
      </header>

      <section className={`provider-strip ${providersLive ? "is-live" : "is-demo"}`} aria-label="Research provider status">
        <div className="provider-summary"><span className="provider-icon"><Icon name={providersLive ? "spark" : "clock"} size={17}/></span><div><small>Research environment</small><strong>{providersLive ? "Live intelligence" : "Curated demonstration"}</strong></div></div>
        <p>{providersLive ? "Reddit discovery, title-and-description extraction, archive matching and draft collage rendering run automatically." : "The automated Reddit provider is waiting for configuration."}</p>
        <div className="provider-stages"><span className={providersLive ? "ready" : "waiting"}><i/>Reddit intake<small>{providersLive ? "Automatic" : "Waiting"}</small></span><span className={providersLive ? "ready" : "waiting"}><i/>Look extraction<small>{providersLive ? "Automatic" : "Waiting"}</small></span><span className={providersLive ? "ready" : "waiting"}><i/>Archive search<small>{providersLive ? "Local archive" : "Waiting"}</small></span><span className="ready"><i/>Collage studio<small>Automatic</small></span></div>
      </section>

      <section className="metrics" aria-label="Editorial summary">
        <article><span className="metric-number">01</span><div><small>Outfit cases</small><strong>{dashboard?.total ?? "—"}</strong><span>Current edition</span></div></article>
        <article><span className="metric-number">02</span><div><small>Review queue</small><strong>{queueCount}</strong><span>Needs a decision</span></div></article>
        <article><span className="metric-number">03</span><div><small>Resolved archive</small><strong>{archiveCount}</strong><span>Approved or closed</span></div></article>
        <article className="guardrail"><div className="guardrail-orbit"><Icon name="shield" size={18}/></div><span>Editorial promise</span><strong>Human taste. Machine speed.</strong><small>Nothing publishes without your final word.</small></article>
      </section>

      <section className="workspace studio-workspace">
        <div className="queue-panel">
          <div className="panel-heading"><div><small>{meta.listKicker}</small><h2>{meta.listTitle}</h2></div><span className="queue-count">{visibleCases.length.toString().padStart(2, "0")}</span></div>
          <div className="filters">{FILTERS[workspaceView].map(item => <button type="button" key={item} className={filter === item ? "selected" : ""} onClick={() => setFilter(item)}>{item === "all" ? "All" : workspaceView === "rights" ? `${pretty(item)} risk` : pretty(item)}</button>)}</div>
          <div className="case-list">
            {loading && <div className="loading-card"><i/><span>Preparing the edit…</span></div>}
            {!loading && visibleCases.map((item, index) => <button type="button" key={item.id} className={`case-card ${selected?.id === item.id ? "current" : ""}`} onClick={() => void openCase(item.id)}>
              <span className="case-index">{(index + 1).toString().padStart(2, "0")}</span><div className="case-thumb"><img src={asset(item.base_image)} alt={`${item.celebrity} in ${item.designer}`}/></div>
              <div className="case-copy"><div><StatusPill status={item.status}/><span className={`fashion-chip fashion-${item.fashion_category}`}>{item.fashion_category === "unclassified" ? "Unfiled" : pretty(item.fashion_category)}</span><span className={`risk risk-${item.risk_level}`}>{item.risk_level}</span></div><strong>{item.celebrity}</strong><p>{item.designer} · {item.event_name}</p><footer><span>{item.event_date || "Date unresolved"}</span><b>{Math.round(item.confidence * 100)}% signal</b></footer></div><Icon name="arrow" size={15}/>
            </button>)}
            {!loading && !visibleCases.length && <div className="empty enhanced-empty"><Icon name="search"/><strong>No matching outfits</strong><span>Clear the search or choose another filter.</span><button type="button" className="ghost" onClick={() => { setSearch(""); setFilter("all"); }}>Reset view</button></div>}
          </div>
        </div>

        <div className="review-panel">
          {workspaceView === "rights" ? <RightsWorkspace selected={selected}/> : !selected ? <div className="review-empty"><span>HHC</span><h2>No outfit selected</h2><p>Choose a look from the rail to open its editorial file.</p></div> : <>
            <div className="review-heading"><div><div className="review-meta"><StatusPill status={selected.status}/><span className={`fashion-chip fashion-${selected.fashion_category}`}>{selected.fashion_category === "unclassified" ? "Content desk open" : pretty(selected.fashion_category)}</span>{selected.demo_data && <span className="demo-chip">Demonstration</span>}</div><h2>{selected.celebrity}</h2><p><b>{selected.designer}</b><i/>{selected.event_name}</p></div><div className="review-heading-actions"><div className="category-editor"><small>Content listing</small><div>{(["women", "men", "mixed"] as const).map(category => <button type="button" key={category} className={selected.fashion_category === category ? "active" : ""} onClick={() => void updateFashionCategory(category)} disabled={categoryBusy}>{category === "mixed" ? "Both" : pretty(category)}</button>)}</div></div><a className="source-link" href={selected.permalink} target="_blank" rel="noreferrer"><Icon name="external"/>Reddit source</a></div></div>

            {selected.latest_collage && <section className="automatic-draft-card">
              <div className="automatic-draft-image"><img src={asset(selected.latest_collage.preview_url)} alt={`Automatic collage for ${selected.celebrity}`}/><span>Generated automatically</span></div>
              <div className="automatic-draft-copy"><small>Today’s ready-to-review output</small><h3>Single-image collage complete</h3><p>Every usable image from the Reddit post is arranged edge-to-edge in one collage, followed by the historical or exact original-outfit comparison when available.</p><div><span><Icon name="check" size={13}/>{automaticPanelCount} source panel{automaticPanelCount === 1 ? "" : "s"} in one image</span><span><Icon name="shield" size={13}/>Draft only — never auto-published</span></div><footer><button type="button" className="primary" onClick={() => setCollageResult({ previewUrl: asset(selected.latest_collage!.preview_url), bundleUrl: selected.latest_collage!.bundle_url.replace(/^\/api\//, "/api/backend/"), assetCount: automaticPanelCount })}><Icon name="eye"/>View collage</button><button type="button" className="ghost" onClick={openCollageEditor}><Icon name="edit"/>Edit collage</button><a className="ghost" href={selected.latest_collage.bundle_url.replace(/^\/api\//, "/api/backend/")} target="_blank" rel="noreferrer"><Icon name="download"/>Evidence bundle</a></footer></div>
            </section>}

            {!candidate && <>
              <AssetBoard assets={supplementaryAssets}/>
              <div className="no-candidate-state"><span><Icon name="search" size={22}/></span><small>Archive discovery</small><h3>No exact historical match found yet</h3><p>This source-only collage was still created automatically. Every daily run rechecks the growing Reddit archive using the post title, description, designer attribution and image signals.</p><button type="button" className="primary" onClick={() => void runAutomation()} disabled={automationBusy}>{automationBusy ? "Checking Reddit…" : "Check for new outfits now"}</button></div>
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

    {showIntake && <div className="modal-backdrop" onMouseDown={() => setShowIntake(false)}><form className="intake-modal" onSubmit={submitIntake} onMouseDown={event => event.stopPropagation()}><div className="modal-title"><small>Manual source intake</small><h2>Add a look to today’s edit</h2><p>Paste a Reddit post and preserve the title and description that make the outfit searchable.</p></div><label>Reddit permalink<input required name="reddit_url" type="url" placeholder="https://www.reddit.com/r/BollywoodFashion/comments/…"/></label><label>Post title<input required name="title" placeholder="Celebrity in Designer at Event"/></label><div className="form-row"><label>Celebrity<input name="celebrity" placeholder="Unresolved"/></label><label>Designer<input name="designer" placeholder="Unresolved"/></label></div><label>Event<input name="event_name" placeholder="Unresolved"/></label><label>Description<textarea name="body" placeholder="Paste the source description or add editor notes…"/></label><div className="modal-note"><Icon name="shield"/><span>This creates a Context Review case and never publishes automatically.</span></div><footer><button type="button" className="ghost" onClick={() => setShowIntake(false)}>Cancel</button><button className="primary" type="submit">Add to today’s edit</button></footer></form></div>}

    {showCollageEditor && selected && <div className="modal-backdrop collage-editor-backdrop" onMouseDown={() => !editorBusy && setShowCollageEditor(false)}><section className="collage-editor-modal" role="dialog" aria-modal="true" aria-labelledby="collage-editor-title" onMouseDown={event => event.stopPropagation()}>
      <header><div><small>Optional manual control</small><h2 id="collage-editor-title">Edit this collage.</h2><p>Reorder, replace, resize, or crop each image. Originals stay untouched and all source metadata remains attached.</p></div><button type="button" className="modal-close" onClick={() => setShowCollageEditor(false)} disabled={editorBusy} aria-label="Close collage editor"><Icon name="close"/></button></header>
      <div className="collage-editor-summary"><span><b>{editorSelectedPanels.length}</b> selected panels</span><span><Icon name="shield" size={13}/>Source and rights metadata stay attached</span><span>Today’s Reddit look remains required</span></div>
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
                <button type="button" className="remove" onClick={() => { setEditorPanelIds(current => current.filter(id => id !== panel.id)); setEditorPanelOptions(current => { const next = { ...current }; delete next[panel.id]; return next; }); if (tuning) setTuningPanelId(null); }} disabled={requiredCurrent || editorSelectedPanels.length === 1} aria-label={`Remove ${panel.label}`} title={requiredCurrent ? "Keep at least one current Reddit image" : "Remove panel"}><Icon name="trash" size={15}/></button>
              </div>
              {tuning && <div className="panel-tuning">
                <div className="panel-tuning-heading"><div><small>Image layout</small><strong>Resize &amp; crop</strong></div><button type="button" onClick={() => updatePanelOption(panel.id, DEFAULT_PANEL_OPTION)}>Reset image</button></div>
                <label className="panel-range"><span>Panel width <b>{Math.round(option.width_scale * 100)}%</b></span><input type="range" min="65" max="175" step="5" value={Math.round(option.width_scale * 100)} onChange={event => updatePanelOption(panel.id, { width_scale: Number(event.target.value) / 100 })}/><small>Narrower</small><small>Wider</small></label>
                <div className="crop-mode-control"><span>Image treatment</span><div><button type="button" className={option.crop_mode === "fit" ? "active" : ""} onClick={() => updatePanelOption(panel.id, { crop_mode: "fit", zoom: 1 })}>Show full image</button><button type="button" className={option.crop_mode === "crop" ? "active" : ""} onClick={() => updatePanelOption(panel.id, { crop_mode: "crop" })}>Crop to fill</button></div><p>{option.crop_mode === "fit" ? "The complete photo stays visible; a soft background fills extra space." : "Drag the focus and zoom controls to choose the visible area."}</p></div>
                {option.crop_mode === "crop" && <div className="crop-controls">
                  <label className="panel-range"><span>Horizontal focus <b>{Math.round(option.focal_x * 100)}%</b></span><input type="range" min="0" max="100" step="1" value={Math.round(option.focal_x * 100)} onChange={event => updatePanelOption(panel.id, { focal_x: Number(event.target.value) / 100 })}/><small>Left</small><small>Right</small></label>
                  <label className="panel-range"><span>Vertical focus <b>{Math.round(option.focal_y * 100)}%</b></span><input type="range" min="0" max="100" step="1" value={Math.round(option.focal_y * 100)} onChange={event => updatePanelOption(panel.id, { focal_y: Number(event.target.value) / 100 })}/><small>Top</small><small>Bottom</small></label>
                  <label className="panel-range"><span>Crop zoom <b>{Math.round(option.zoom * 100)}%</b></span><input type="range" min="100" max="250" step="5" value={Math.round(option.zoom * 100)} onChange={event => updatePanelOption(panel.id, { zoom: Number(event.target.value) / 100 })}/><small>Original</small><small>Closer</small></label>
                </div>}
              </div>}
            </article>;
          })}</div>
        </section>
        <aside className="available-panel-list"><div className="editor-section-heading"><div><small>Replacement library</small><h3>Available images</h3></div><span>{editorAvailablePanels.length}</span></div>
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
