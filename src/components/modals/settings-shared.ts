import type React from 'react';

export const UI_FONT_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'inter', label: 'Inter' },
  { value: 'segoe', label: 'Segoe UI' },
  { value: 'roboto', label: 'Roboto' },
  { value: 'manrope', label: 'Manrope' },
  { value: 'poppins', label: 'Poppins' },
  { value: 'sourceSans', label: 'Source Sans 3' },
  { value: 'openSans', label: 'Open Sans' },
  { value: 'nunito', label: 'Nunito Sans' },
  { value: 'lato', label: 'Lato' },
  { value: 'ubuntu', label: 'Ubuntu' },
] as const;

export const settingsShellStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-editor-background) 82%, var(--aurora-sidebar-background) 18%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 78%, transparent)',
  boxShadow: `
    0 24px 80px color-mix(in srgb, var(--aurora-common-shadow) 32%, transparent),
    inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 9%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 18%, transparent)
  `,
  backdropFilter: 'blur(14px)',
};

export const settingsPaneStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-sidebar-background) 72%, var(--aurora-editor-background) 28%)',
  boxShadow: `
    inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 7%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 12%, transparent)
  `,
};

export const settingsCardStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-title-bar-background) 58%, var(--aurora-sidebar-background) 42%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 74%, transparent)',
  boxShadow: `
    0 10px 24px color-mix(in srgb, var(--aurora-common-shadow) 12%, transparent),
    inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 7%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 12%, transparent)
  `,
};

export const settingsInputStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-common-secondary) 82%, var(--aurora-common-muted) 18%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 82%, transparent)',
  boxShadow: `
    inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 6%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 10%, transparent)
  `,
};

export const settingsSubtlePanelStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-common-muted) 74%, var(--aurora-sidebar-background) 26%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 58%, transparent)',
  boxShadow: `
    inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 5%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 8%, transparent)
  `,
};

export const settingsPrimaryButtonStyle: React.CSSProperties = {
  backgroundColor: 'var(--aurora-common-primary)',
  boxShadow: '0 10px 24px color-mix(in srgb, var(--aurora-common-primary) 22%, transparent)',
};

export const settingsDangerPanelStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-common-danger) 8%, transparent)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-danger) 24%, transparent)',
};

// ---------------------------------------------------------------------------
// Professional / enterprise settings primitives.
// The tokens below replace the consumer-style "big rounded card with mobile
// app icon badges" aesthetic with a tighter, IDE-grade form layout.
// All values intentionally use 6-8px radii, 1px borders, and no glow shadows.
// ---------------------------------------------------------------------------

export const settingsSectionPanelStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-title-bar-background) 56%, var(--aurora-sidebar-background) 44%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
  borderRadius: 8,
  boxShadow: `
    inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 4%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 6%, transparent)
  `,
};

export const settingsRowDividerColor =
  'color-mix(in srgb, var(--aurora-common-border) 38%, transparent)';

export const settingsControlButtonStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-common-secondary) 76%, var(--aurora-title-bar-background) 24%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
  borderRadius: 6,
  boxShadow: `
    inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 4%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 8%, transparent)
  `,
};

export const settingsPrimaryActionStyle: React.CSSProperties = {
  backgroundColor: 'var(--aurora-common-primary)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-primary) 90%, var(--aurora-common-shadow) 10%)',
  borderRadius: 6,
  boxShadow: `
    inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 22%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 14%, transparent)
  `,
};

export const settingsDangerActionStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-common-danger) 14%, var(--aurora-common-secondary) 86%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-danger) 36%, transparent)',
  borderRadius: 6,
};

export const settingsCodeBlockStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-editor-background) 70%, var(--aurora-title-bar-background) 30%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
  borderRadius: 6,
};
