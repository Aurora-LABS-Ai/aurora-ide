/**
 * Tool Icons for Agent Mode
 * 
 * Custom SVG icons for different tool categories.
 * Uses CSS variables for theming.
 */

import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

// File operations
export const FileIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-primary)' }}
  >
    <path 
      d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M14 2V8H20" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

export const FileEditIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-primary)' }}
  >
    <path 
      d="M12 20H21" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M16.5 3.50001C16.8978 3.10219 17.4374 2.87869 18 2.87869C18.2786 2.87869 18.5544 2.93356 18.8118 3.04017C19.0692 3.14677 19.303 3.30303 19.5 3.50001C19.697 3.697 19.8532 3.93085 19.9598 4.18822C20.0665 4.44559 20.1213 4.72144 20.1213 5.00001C20.1213 5.27859 20.0665 5.55444 19.9598 5.81181C19.8532 6.06918 19.697 6.30303 19.5 6.50001L7 19L3 20L4 16L16.5 3.50001Z" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

export const FileCreateIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-success)' }}
  >
    <path 
      d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M14 2V8H20" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M12 18V12" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M9 15H15" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

export const FileDeleteIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-error)' }}
  >
    <path 
      d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M14 2V8H20" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M9 15H15" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

// Folder operations
export const FolderIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-info)' }}
  >
    <path 
      d="M22 19C22 19.5304 21.7893 20.0391 21.4142 20.4142C21.0391 20.7893 20.5304 21 20 21H4C3.46957 21 2.96086 20.7893 2.58579 20.4142C2.21071 20.0391 2 19.5304 2 19V5C2 4.46957 2.21071 3.96086 2.58579 3.58579C2.96086 3.21071 3.46957 3 4 3H9L11 6H20C20.5304 6 21.0391 6.21071 21.4142 6.58579C21.7893 6.96086 22 7.46957 22 8V19Z" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.1"
    />
  </svg>
);

export const FolderOpenIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-info)' }}
  >
    <path 
      d="M22 19C22 19.5304 21.7893 20.0391 21.4142 20.4142C21.0391 20.7893 20.5304 21 20 21H4C3.46957 21 2.96086 20.7893 2.58579 20.4142C2.21071 20.0391 2 19.5304 2 19V5C2 4.46957 2.21071 3.96086 2.58579 3.58579C2.96086 3.21071 3.46957 3 4 3H9L11 6H20C20.5304 6 21.0391 6.21071 21.4142 6.58579C21.7893 6.96086 22 7.46957 22 8V19Z" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M2 10H22" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

// Terminal/Shell
export const TerminalIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-warning)' }}
  >
    <path 
      d="M4 17L10 11L4 5" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M12 19H20" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

// Search
export const SearchIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-primary)' }}
  >
    <circle 
      cx="11" 
      cy="11" 
      r="8" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M21 21L16.65 16.65" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

export const SearchReplaceIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-primary)' }}
  >
    <circle 
      cx="11" 
      cy="11" 
      r="6" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M21 21L16 16" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M17 8L21 4M21 4H17M21 4V8" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

// Code/Patch
export const CodeIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-primary)' }}
  >
    <path 
      d="M16 18L22 12L16 6" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
    <path 
      d="M8 6L2 12L8 18" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

// Generic tool
export const ToolIcon: React.FC<IconProps> = ({ size = 14, className = '' }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    className={className}
    style={{ color: 'var(--aurora-common-muted-foreground)' }}
  >
    <path 
      d="M14.7 6.3C14.5168 6.48693 14.4141 6.73825 14.4141 7C14.4141 7.26175 14.5168 7.51307 14.7 7.7L16.3 9.3C16.4869 9.48324 16.7382 9.58588 17 9.58588C17.2617 9.58588 17.5131 9.48324 17.7 9.3L21.47 5.53C21.9728 6.51393 22.1251 7.63436 21.9037 8.71271C21.6823 9.79107 21.0992 10.7676 20.2484 11.4864C19.3976 12.2052 18.3282 12.6257 17.2106 12.6818C16.0931 12.738 14.9873 12.4269 14.07 11.8L6.55 19.32C6.16218 19.7078 5.63587 19.925 5.0875 19.925C4.53913 19.925 4.01282 19.7078 3.625 19.32C3.23718 18.9322 3.02002 18.4059 3.02002 17.8575C3.02002 17.3091 3.23718 16.7828 3.625 16.395L11.145 8.875C10.5099 7.95744 10.1968 6.84729 10.2555 5.72623C10.3142 4.60517 10.7413 3.53443 11.4692 2.68546C12.197 1.8365 13.1848 1.2589 14.2746 1.04553C15.3644 0.832158 16.494 0.995286 17.48 1.51L14.7 4.29V6.3Z" 
      stroke="currentColor" 
      strokeWidth="1.5" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    />
  </svg>
);

// Helper to get the right icon for a tool name
export const getToolIcon = (toolName: string, size = 14): React.ReactNode => {
  const iconMap: Record<string, React.FC<IconProps>> = {
    // File operations
    'file_read': FileIcon,
    'file_write': FileEditIcon,
    'file_create': FileCreateIcon,
    'file_delete': FileDeleteIcon,
    'file_patch': FileEditIcon,
    'multi_file_read': FileIcon,
    
    // Search operations
    'search_replace': SearchReplaceIcon,
    'multi_search_replace': SearchReplaceIcon,
    'aurora_search': SearchIcon,
    'grep_search': SearchIcon,
    
    // Folder operations
    'list_workspace': FolderOpenIcon,
    'list_directory': FolderOpenIcon,
    'create_directory': FolderIcon,
    'delete_directory': FolderIcon,
    
    // Shell
    'shell_execute': TerminalIcon,
    'run_command': TerminalIcon,
    
    // Code
    'code_analysis': CodeIcon,
  };

  const IconComponent = iconMap[toolName] || ToolIcon;
  return <IconComponent size={size} />;
};
