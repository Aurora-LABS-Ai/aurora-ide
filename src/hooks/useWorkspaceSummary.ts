import { useEffect, useState } from "react";

import {
  scanWorkspace,
  type WorkspaceSummary,
} from "../services/workspace-summary";

export const useWorkspaceSummary = (
  rootPath: string,
): WorkspaceSummary | null => {
  const [state, setState] = useState<{
    rootPath: string;
    summary: WorkspaceSummary | null;
  }>({
    rootPath: "",
    summary: null,
  });

  useEffect(() => {
    let cancelled = false;

    if (!rootPath) {
      return () => {
        cancelled = true;
      };
    }

    void scanWorkspace(rootPath).then((result) => {
      if (!cancelled) {
        setState({
          rootPath,
          summary: result,
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  if (!rootPath || state.rootPath !== rootPath) {
    return null;
  }

  return state.summary;
};
