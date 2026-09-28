import type { ApiClient } from "../api/client";
import { jobsApi } from "../api/jobs";

export async function downloadJobArtifact(
  api: ApiClient,
  jobId: string,
  artifact: "input" | "output",
) {
  const grant = await jobsApi(api).grant(jobId, artifact, crypto.randomUUID());
  const anchor = document.createElement("a");
  anchor.href = grant.url;
  anchor.rel = "noopener noreferrer";
  anchor.target = "_blank";
  anchor.click();
}
