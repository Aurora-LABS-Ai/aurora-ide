/**
 * Add Theme Architecture Notice to UI Files
 * 
 * This script adds a comment header to all UI files (TSX, CSS) in the src folder
 * to remind contributors (including AI assistants like Claude, Gemini) not to use
 * hardcoded colors and to follow the theme architecture.
 * 
 * Usage: node scripts/add-theme-notice.js
 * 
 * Options:
 *   --dry-run    Preview changes without modifying files
 *   --remove     Remove the theme notice from files
 */

const fs = require('fs');
const path = require('path');

// Configuration
const SRC_DIR = path.join(__dirname, '..', 'src');

// File patterns to process
const FILE_PATTERNS = {
  tsx: /\.tsx$/,
  css: /\.css$/,
};

// Directories to include (relative to src/)
const INCLUDE_DIRS = [
  'components',
  '', // root src files like App.tsx, main.tsx
];

// Files to explicitly include from root
const INCLUDE_ROOT_FILES = ['App.tsx', 'main.tsx', 'App.css', 'index.css'];

// The notice comment for TSX files
const TSX_NOTICE = `/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

`;

// The notice comment for CSS files
const CSS_NOTICE = `/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 * 
 * Use theme tokens via CSS variables:
 *   - var(--aurora-{category}-{token})
 *   - Example: var(--aurora-editor-background)
 *   - Example: var(--aurora-common-primary)
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 */

`;

// Marker to identify our notice (for updates/removal)
const NOTICE_MARKER = 'THEME ARCHITECTURE NOTICE:';

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REMOVE_MODE = args.includes('--remove');

/**
 * Check if a file already has the theme notice
 */
function hasThemeNotice(content) {
  return content.includes(NOTICE_MARKER);
}

/**
 * Remove the theme notice from content
 */
function removeThemeNotice(content, fileType) {
  if (!hasThemeNotice(content)) {
    return { content, changed: false };
  }

  // Pattern to match our notice block
  const noticePattern = /\/\*\*[\s\S]*?THEME ARCHITECTURE NOTICE:[\s\S]*?\*\/\s*\n*/;
  const newContent = content.replace(noticePattern, '');
  
  return { content: newContent, changed: newContent !== content };
}

/**
 * Add the theme notice to content
 */
function addThemeNotice(content, fileType) {
  if (hasThemeNotice(content)) {
    return { content, changed: false };
  }

  const notice = fileType === 'css' ? CSS_NOTICE : TSX_NOTICE;
  
  // For TSX files, preserve any shebang or 'use client' directive
  let insertPosition = 0;
  
  if (fileType === 'tsx') {
    // Check for 'use client' or 'use server' directive
    const directiveMatch = content.match(/^(['"]use (client|server)['"];?\s*\n)/);
    if (directiveMatch) {
      insertPosition = directiveMatch[0].length;
    }
  }
  
  const newContent = 
    content.slice(0, insertPosition) + 
    notice + 
    content.slice(insertPosition);
  
  return { content: newContent, changed: true };
}

/**
 * Get all files to process
 */
function getFilesToProcess() {
  const files = [];
  
  function walkDir(dir, relativePath = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relativePath, entry.name);
      
      if (entry.isDirectory()) {
        // Skip node_modules, dist, etc.
        if (['node_modules', 'dist', '.git', 'target'].includes(entry.name)) {
          continue;
        }
        walkDir(fullPath, relPath);
      } else if (entry.isFile()) {
        // Check if file matches our patterns
        const isTsx = FILE_PATTERNS.tsx.test(entry.name);
        const isCss = FILE_PATTERNS.css.test(entry.name);
        
        if (isTsx || isCss) {
          // Check if it's in an included directory or is an included root file
          const dirName = path.dirname(relPath);
          const isInIncludedDir = INCLUDE_DIRS.some(d => {
            if (d === '') return dirName === '.';
            return relPath.startsWith(d);
          });
          
          const isIncludedRootFile = dirName === '.' && INCLUDE_ROOT_FILES.includes(entry.name);
          
          if (isInIncludedDir || isIncludedRootFile) {
            files.push({
              fullPath,
              relativePath: relPath,
              type: isTsx ? 'tsx' : 'css',
            });
          }
        }
      }
    }
  }
  
  walkDir(SRC_DIR);
  return files;
}

/**
 * Process a single file
 */
function processFile(file) {
  const content = fs.readFileSync(file.fullPath, 'utf-8');
  
  const { content: newContent, changed } = REMOVE_MODE
    ? removeThemeNotice(content, file.type)
    : addThemeNotice(content, file.type);
  
  if (changed) {
    if (!DRY_RUN) {
      fs.writeFileSync(file.fullPath, newContent, 'utf-8');
    }
    return true;
  }
  
  return false;
}

/**
 * Main execution
 */
function main() {
  console.log('');
  console.log('========================================');
  console.log('  Theme Architecture Notice Tool');
  console.log('========================================');
  console.log('');
  
  if (DRY_RUN) {
    console.log('[DRY RUN MODE] No files will be modified.\n');
  }
  
  if (REMOVE_MODE) {
    console.log('[REMOVE MODE] Removing theme notices from files.\n');
  } else {
    console.log('[ADD MODE] Adding theme notices to files.\n');
  }
  
  const files = getFilesToProcess();
  console.log(`Found ${files.length} UI files to process.\n`);
  
  let modifiedCount = 0;
  let skippedCount = 0;
  
  for (const file of files) {
    const wasModified = processFile(file);
    
    if (wasModified) {
      modifiedCount++;
      const action = REMOVE_MODE ? 'Would remove from' : 'Would add to';
      const actionDone = REMOVE_MODE ? 'Removed from' : 'Added to';
      console.log(`  ${DRY_RUN ? action : actionDone}: ${file.relativePath}`);
    } else {
      skippedCount++;
    }
  }
  
  console.log('');
  console.log('----------------------------------------');
  console.log(`  ${REMOVE_MODE ? 'Removed' : 'Added'}: ${modifiedCount} files`);
  console.log(`  Skipped (${REMOVE_MODE ? 'no notice' : 'already has notice'}): ${skippedCount} files`);
  console.log('----------------------------------------');
  console.log('');
  
  if (DRY_RUN && modifiedCount > 0) {
    console.log('Run without --dry-run to apply changes.');
    console.log('');
  }
}

main();

