// Keep engine credentials on the server. The browser only talks to the same-origin
// authenticated gateway, which injects the Railway engine token.
const engineBase = `${import.meta.env.BASE_URL}api/engine`.replace(/\/+$/, "");

export interface EngineCapabilities {
  engine: string;
  version: string;
  canvas: {
    width_inches: number;
    height_inches: number;
    width_mm?: number;
    height_mm?: number;
    color_mode: string;
  };
  formats: {
    svg: { supported: boolean; color_space: string; true_paths: boolean };
    eps: { supported: boolean; color_space: string; standard: string };
    ai: {
      supported: boolean;
      available_locally: boolean;
      desktop_handoff: boolean;
      reason: string;
    };
  };
  ocr: { available: boolean; engine: string; advisory_only: boolean };
  ai_assistance: { configured: boolean; features: string[]; automatic_export_or_approval: boolean };
  ai_artwork_generation?: {
    configured: boolean;
    models: string[];
    output: string;
    requires_operator_review: boolean;
    automatic_export_or_approval: boolean;
  };
  ai_flat_artwork_reconstruction?: {
    configured: boolean;
    models: string[];
    output: string;
    automatic_photo_flattening: boolean;
    hidden_artwork_reconstruction: boolean;
    requires_operator_confirmation: boolean;
    source_fidelity_verified: boolean;
  };
  panel_detection: {
    local_candidate_detection: boolean;
    front_back_classification_without_ai: boolean;
    requires_confirmation: boolean;
    ai_opt_in: boolean;
  };
  processing: {
    crop: boolean;
    four_point_perspective: boolean;
    color_vector_tracing: boolean;
    automatic_fabric_flattening: boolean;
    hidden_artwork_reconstruction: boolean;
    guided_mesh_flattening: boolean;
  };
  limits: { upload_mib: number; source_megapixels: number; trace_max_dimension: number };
}

export interface UploadedSource {
  source_id: string;
  width: number;
  height: number;
  coordinate_system: string;
}

export interface SourceAnalysis {
  width_px: number;
  height_px: number;
  has_transparency: boolean;
  source_ppi_at_canvas: { horizontal: number; vertical: number };
  sharpness_heuristic: number;
  issues: string[];
  source_color: Record<string, unknown>;
  canvas: {
    width_inches: number;
    height_inches: number;
    width_mm?: number;
    height_mm?: number;
    width_points: number;
    height_points: number;
    color_mode: string;
  };
  part_detection: { status: string; requires_operator_confirmation: boolean };
}

export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectionCandidate {
  candidate_id: string;
  position_hint: string | null;
  suggested_side: "front" | "back" | "unknown";
  source_bbox_px: PixelBox;
  geometry_score?: number;
  score_type?: string;
  region?: {
    part: string;
    confidence: number;
    note: string;
  };
}

export interface DetectionResult {
  status: string;
  method: string;
  source_dimensions: { width_px: number; height_px: number };
  coordinate_system: string;
  candidates: DetectionCandidate[];
  candidate_pair_found: boolean;
  front_back_classified: boolean;
  requires_operator_confirmation: boolean;
  score_type?: string;
  warnings: string[];
}

export interface ArtworkPanelRequest {
  side: "front" | "back";
  source_id: string;
  crop: PixelBox;
  run_ocr: boolean;
  reconstruction_mode: "trace_source" | "ai_flat_artwork";
}

export interface CreateArtworkJobRequest {
  panels: [ArtworkPanelRequest, ArtworkPanelRequest];
  dpi: 330 | 600;
  formats: Array<"svg" | "eps">;
  native_ai_mode: "disabled";
}

export interface CreateGeneratedArtworkRequest {
  brief: string;
  front_notes: string;
  back_notes: string;
  dpi: 330 | 600;
  formats: Array<"svg" | "eps">;
}

export interface ArtworkJob {
  job_id: string;
  status: string;
  stage: string;
  progress: number;
  production_ready?: boolean;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export class EngineApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "EngineApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${engineBase}${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...init?.headers,
      },
    });
  } catch {
    throw new EngineApiError(
      "The engine service could not be reached. Check the API connection and try again.",
      0,
      "ENGINE_UNREACHABLE",
    );
  }

  if (!response.ok) {
    let message = `Engine request failed (${response.status}).`;
    let code: string | undefined;
    try {
      const body = await response.json();
      const detail = body?.error ?? body?.detail ?? body;
      if (typeof detail === "string") message = detail;
      if (typeof detail?.message === "string") message = detail.message;
      if (typeof detail?.code === "string") code = detail.code;
    } catch {
      // Keep the HTTP status message when the service returns non-JSON content.
    }
    throw new EngineApiError(message, response.status, code);
  }

  return response.json() as Promise<T>;
}

function safeId(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error("The engine returned an invalid identifier.");
  }
  return value;
}

export const engineApi = {
  get baseUrl() {
    return engineBase;
  },

  getCapabilities(signal?: AbortSignal) {
    return request<EngineCapabilities>("/capabilities", { signal });
  },

  uploadSource(file: File, signal?: AbortSignal) {
    const body = new FormData();
    body.append("file", file);
    return request<UploadedSource>("/sources", { method: "POST", body, signal });
  },

  analyzeSource(sourceId: string, ai = false, signal?: AbortSignal) {
    return request<SourceAnalysis>(
      `/sources/${safeId(sourceId)}/analyze?ai=${ai}`,
      { method: "POST", signal },
    );
  },

  sourcePreviewUrl(sourceId: string) {
    return `${engineBase}/sources/${safeId(sourceId)}/preview`;
  },

  detectPanels(sourceId: string, ai = false, signal?: AbortSignal) {
    return request<DetectionResult>(
      `/sources/${safeId(sourceId)}/detect-panels?ai=${ai}`,
      { method: "POST", signal },
    );
  },

  createJob(payload: CreateArtworkJobRequest, signal?: AbortSignal) {
    return request<ArtworkJob>("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  },

  createGeneratedJob(payload: CreateGeneratedArtworkRequest, signal?: AbortSignal) {
    return request<ArtworkJob>("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  },

  getJob(jobId: string, signal?: AbortSignal) {
    return request<ArtworkJob>(`/jobs/${safeId(jobId)}`, { signal });
  },

  async downloadFile(jobId: string, filename: string, signal?: AbortSignal) {
    const safeFilename = new Set([
      "front-body.svg",
      "front-body.eps",
      "back-body.svg",
      "back-body.eps",
      "manifest.json",
      "front-body-preview.png",
      "back-body-preview.png",
      "front-flat-art-draft.png",
      "back-flat-art-draft.png",
    ]);
    if (!safeFilename.has(filename)) throw new Error("Unsupported engine output.");
    const response = await fetch(
      `${engineBase}/jobs/${safeId(jobId)}/files/${filename}`,
      { signal, credentials: "same-origin" },
    );
    if (!response.ok) {
      throw new EngineApiError(`The ${filename} file is not available yet.`, response.status);
    }
    return response.blob();
  },

  async downloadBundle(jobId: string, signal?: AbortSignal) {
    const response = await fetch(`${engineBase}/jobs/${safeId(jobId)}/bundle`, {
      signal,
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new EngineApiError("The artwork bundle is not available yet.", response.status);
    }
    return response.blob();
  },
};
