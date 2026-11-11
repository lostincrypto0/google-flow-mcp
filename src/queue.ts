import { randomUUID } from "node:crypto";

export type JobStatus = "awaiting_approval" | "queued" | "running" | "done" | "failed" | "cancelled";

export interface SceneParams {
  prompt: string;
  type: "video" | "image";
  max_credits: number;
  duration?: number;
  resolution?: "360p" | "720p";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  variants?: number;
  first_frame?: string;
  first_frame_at?: number;
  last_frame?: string;
  reference_images?: string[];
  chain_from?: string;
  reference_from?: string;
  edit_asset?: string;
  agent_scenes?: string[];
  // The scene number each agent scene is saved as. A retry of scenes 7 and 12 keeps scene-07 and scene-12; without it
  // the numbers run on from file_stem.
  agent_numbers?: number[];
  // Reference images for an agent batch: attached once as ingredients in the agent composer (absolute paths, uploaded
  // once, or "asset:<title>"), with a short name each, plus which of them every scene uses (names, per scene).
  agent_refs?: { image: string; name: string }[];
  agent_scene_refs?: string[][];
  // Flow asset names of agent_refs after upload, so a retry round re-attaches without uploading again.
  agent_ref_assets?: string[];
  continue_from?: string;
  attach?: string[];
  continue_mode?: "exact" | "likeness";
  retries?: number;
  download_quality?: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  params: SceneParams;
  files: string[];
  attempts: number;
  credits?: number;
  // Credit guard: the estimate shown to the user, what they approved (the ceiling for this job), what it really
  // cost, and whether it can cost anything at all. A paid job never runs, or re-runs, without the user's approval.
  estimate?: number;
  approved?: number;
  spent?: number;
  paid?: boolean;
  basis?: string;
  // The Flow project this job is made in (its name as Flow shows it), so the user sees where before approving.
  flow_project?: string;
  // Set just before the click that makes Flow generate. A paid job that fails before it has spent nothing.
  committed?: boolean;
  progress?: string;
  note?: string;
  error?: string;
  // Scene numbers a batch still could not make after all its own retries; flow_retry redoes just these.
  failed_scenes?: number[];
  createdAt: string;
  finishedAt?: string;
}

export type JobRunner = (job: Job) => Promise<string[]>;
// Asked before every job starts: a reason not to run it (limit reached, STOP file, safety breaker), or null.
export type JobGate = (job: Job) => string | null;
export type JobMeta = Pick<Job, "estimate" | "paid" | "basis" | "flow_project"> & { hold?: boolean };

// Flow is driven like a careful person would: one generation at a time, with a
// randomised pause between them.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 70) * 1000;

export class JobQueue {
  private jobs = new Map<string, Job>();
  private working = false;
  private lastFinished = 0;
  pausedReason: string | null = null;

  constructor(private runner: JobRunner, private gate?: JobGate) {}

  // hold: the job waits as "awaiting_approval" and only approve() lets it run.
  add(params: SceneParams, { hold, ...meta }: JobMeta = {}): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      status: hold ? "awaiting_approval" : "queued",
      ...meta,
      approved: hold ? undefined : (meta.estimate ?? 0),
      params,
      files: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    void this.work();
    return job;
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  // Puts a failed or cancelled job back in line with the same settings and file name.
  retry(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      // A paid job goes back to the user: running it again spends again, and that is theirs to decide.
      job.status = job.paid ? "awaiting_approval" : "queued";
      if (job.paid) job.approved = undefined;
      job.error = undefined;
      job.finishedAt = undefined;
      void this.work();
    }
    return job;
  }

  // The user's go-ahead: `approved` becomes this job's ceiling.
  approve(id: string, approved: number): Job | undefined {
    const job = this.jobs.get(id);
    if (job && job.status === "awaiting_approval") {
      job.approved = approved;
      job.params.max_credits = approved;
      job.note = undefined;
      job.status = "queued";
      void this.work();
    }
    return job;
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "queued" || job.status === "awaiting_approval")) {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
    }
    return job;
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.list().find((j) => j.status === "queued");
        if (!job) return;
        if (this.lastFinished) {
          const pause = PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
          const remaining = this.lastFinished + pause - Date.now();
          if (remaining > 0) {
            this.pausedReason = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await new Promise((r) => setTimeout(r, remaining));
            this.pausedReason = null;
          }
        }
        if (job.status !== "queued") continue;
        const stop = this.gate?.(job);
        if (stop) {
          // Nothing runs past a stop. Everything queued goes back to waiting, so carrying on is the user's decision.
          for (const j of this.list().filter((q) => q.status === "queued")) {
            j.status = "awaiting_approval";
            j.approved = undefined;
            j.note = stop;
          }
          return;
        }
        job.status = "running";
        job.attempts++;
        try {
          job.files = await this.runner(job);
          job.status = "done";
          job.error = undefined;
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          // Failed tiles are already retried inside Flow (its own Retry button); only an agent that produced nothing
          // is re-queued here. Timeouts are never retried automatically: they may still have spent credits.
          const retryable = /agent finished without creating/i.test(job.error);
          job.status = retryable && !job.paid && job.attempts <= (job.params.retries ?? 1) ? "queued" : "failed";
        }
        job.finishedAt = new Date().toISOString();
        this.lastFinished = Date.now();
      }
    } finally {
      this.working = false;
    }
  }
}
