export interface AttachmentDropDetail {
  paths: string[];
}

const ATTACHMENT_DROP_EVENT = "aurora:attach-files";

export const dispatchAttachmentDrop = (paths: string[]) => {
  const normalizedPaths = paths.filter(Boolean);
  if (normalizedPaths.length === 0) return;

  window.dispatchEvent(
    new CustomEvent<AttachmentDropDetail>(ATTACHMENT_DROP_EVENT, {
      detail: { paths: normalizedPaths },
    }),
  );
};

export const addAttachmentDropListener = (
  handler: (paths: string[]) => void,
) => {
  const listener = (event: Event) => {
    const { detail } = event as CustomEvent<AttachmentDropDetail>;
    if (!detail?.paths?.length) return;
    handler(detail.paths);
  };

  window.addEventListener(ATTACHMENT_DROP_EVENT, listener);
  return () => window.removeEventListener(ATTACHMENT_DROP_EVENT, listener);
};
