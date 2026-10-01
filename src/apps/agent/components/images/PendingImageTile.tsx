/**
 * Agent Window — a picture that is being made, or failed to be.
 *
 * Takes the same slot in the grid a finished tile will, at the aspect the
 * model will deliver, so the grid never jumps when the picture lands. While
 * pending it holds the silk placeholder the transcript uses for the same wait;
 * a failure keeps the slot and says why in it, with Retry and Dismiss, rather
 * than vanishing and leaving the user to guess whether anything happened.
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { SilkPlaceholder } from "@/apps/agent/components/theme/SilkPlaceholder";
import type { ImageJob } from "@/apps/agent/store/images/useAgentImagesStore";

export const PendingImageTile: React.FC<{
  job: ImageJob;
  onRetry: () => void;
  onDismiss: () => void;
}> = ({ job, onRetry, onDismiss }) => {
  const failed = job.status === "failed";
  return (
    <div className="agw-gallery-item">
      <div
        className="agw-gallery-tile agw-images-job"
        data-status={job.status}
        style={{ aspectRatio: job.aspectRatio }}
        role={failed ? "alert" : "status"}
        aria-label={failed ? `Could not make: ${job.prompt}` : `Making: ${job.prompt}`}
      >
        {failed ? (
          <div className="agw-images-job-failed">
            <p>{job.error || "The picture could not be made."}</p>
            <div className="agw-gallery-actions">
              <button type="button" onClick={onRetry}>
                <AgentIcon name="reset" size={14} />
                Retry
              </button>
              <button type="button" onClick={onDismiss}>
                <AgentIcon name="close" size={14} />
                Dismiss
              </button>
            </div>
          </div>
        ) : (
          <SilkPlaceholder
            className="agw-images-job-silk"
            aspectRatio={job.aspectRatio}
            label="Making the picture"
          />
        )}
        <div className="agw-images-job-caption" title={job.prompt}>
          {job.modelLabel} · {job.prompt}
        </div>
      </div>
    </div>
  );
};
