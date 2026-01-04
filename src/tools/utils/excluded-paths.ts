/**
 * Centralized list of excluded directories and files
 * Used by file executors and context builder to prevent reading problematic paths
 * that would fill up the context window or cause performance issues
 */

// ============================================
// DIRECTORIES TO ALWAYS EXCLUDE FROM FILE READS
// Covers all major languages, frameworks, and build systems
// ============================================
/**
 * Check if a directory name should be excluded from tree traversal
 */
export function isDirectoryExcluded(dirName: string): boolean {
  return EXCLUDED_DIRECTORIES.has(dirName) || EXCLUDED_DIRECTORIES.has(dirName.toLowerCase());
}

/**
 * Check if a file should be excluded based on name or extension
 */
export function isFileExcluded(fileName: string): boolean {
  if (EXCLUDED_FILES.has(fileName)) {
    return true;
  }
  
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot !== -1) {
    const ext = fileName.substring(lastDot).toLowerCase();
    return EXCLUDED_EXTENSIONS.has(ext);
  }
  
  return false;
}

/**
 * Check if a path should be blocked from reading
 * @param path The file path to check
 * @returns Object with blocked status and reason
 */
export function isPathExcluded(path: string): { excluded: boolean; reason?: string } {
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  const segments = normalizedPath.split('/');
  const fileName = segments[segments.length - 1] || '';
  
  // Check each path segment against excluded directories
  for (const segment of segments) {
    if (EXCLUDED_DIRECTORIES.has(segment)) {
      return { 
        excluded: true, 
        reason: `Reading from '${segment}' directory is blocked to prevent context overflow` 
      };
    }
  }
  
  // Check filename against excluded files
  if (EXCLUDED_FILES.has(fileName)) {
    return { 
      excluded: true, 
      reason: `File '${fileName}' is excluded (lock file or system file)` 
    };
  }
  
  // Check file extension
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot !== -1) {
    const ext = fileName.substring(lastDot).toLowerCase();
    if (EXCLUDED_EXTENSIONS.has(ext)) {
      return { 
        excluded: true, 
        reason: `Files with extension '${ext}' are excluded (binary/compiled file)` 
      };
    }
  }
  
  return { excluded: false };
}

export const EXCLUDED_DIRECTORIES = new Set([
  // === VERSION CONTROL ===
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '_darcs',
  '.fossil',

  // === JAVASCRIPT/NODE.JS ===
  'node_modules',
  '.pnpm',
  '.npm',
  '.yarn',
  '.pnp',
  'bower_components',
  'jspm_packages',

  // === NEXT.JS / REACT ===
  '.next',
  '.docusaurus',
  '.gatsby',
  '.expo',
  '.expo-shared',

  // === VUE / NUXT ===
  '.nuxt',
  '.output',
  '.vuepress',
  '.temp',

  // === ANGULAR ===
  '.angular',

  // === SVELTE ===
  '.svelte-kit',

  // === BUNDLERS & BUILD TOOLS ===
  'dist',
  'build',
  'out',
  'output',
  '.parcel-cache',
  '.rollup.cache',
  '.webpack',
  '.turbo',
  '.vercel',
  '.netlify',
  '.serverless',
  '.amplify',
  '.firebase',
  '.esbuild',
  '.swc',
  'storybook-static',

  // === RUST ===
  'target',

  // === GO ===
  'vendor',
  'bin',
  'pkg',

  // === JAVA / KOTLIN / ANDROID ===
  '.gradle',
  '.idea',
  'gradle',
  '.m2',
  '.mvn',
  'classes',
  'libs',
  'intermediates',
  'generated',
  'outputs',
  'captures',
  '.cxx',
  '.externalNativeBuild',
  'jniLibs',
  'apk',
  'aab',
  // Android SDK / NDK
  'ndk',
  'sdk',
  'android-sdk',
  'android-ndk',
  // Android build
  'app/build',
  'app/release',
  'app/debug',

  // === C / C++ ===
  'cmake-build-debug',
  'cmake-build-release',
  'cmake-build-relwithdebinfo',
  'cmake-build-minsizerel',
  'CMakeFiles',
  'Debug',
  'Release',
  'x64',
  'x86',
  'Win32',
  'ARM',
  'ARM64',
  '.vs',
  'ipch',
  'obj',

  // === .NET / C# / XAMARIN / MAUI ===
  'bin',
  'obj',
  'packages',
  '.nuget',
  'TestResults',
  'AppPackages',
  'BundleArtifacts',
  // Xamarin/MAUI
  'Resources/drawable-*',

  // === PYTHON ===
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.eggs',
  '*.egg-info',
  '.venv',
  'venv',
  'env',
  'ENV',
  '.env',
  '.pyenv',
  '.conda',
  'site-packages',
  'htmlcov',
  '.ipynb_checkpoints',

  // === RUBY ===
  '.bundle',
  '.gem',

  // === PHP ===
  // 'vendor' already listed under Go

  // === SWIFT / IOS / XCODE ===
  'DerivedData',
  'Pods',
  '.build',
  'Carthage',
  'xcuserdata',
  '*.xcworkspace',
  'SourcePackages',
  'ModuleCache',

  // === FLUTTER / DART ===
  '.dart_tool',
  '.pub-cache',
  '.pub',
  'ephemeral',

  // === REACT NATIVE ===
  'ios/Pods',
  'ios/build',
  'android/build',
  'android/app/build',
  'android/.gradle',

  // === ELIXIR ===
  '_build',
  'deps',
  '.elixir_ls',

  // === HASKELL ===
  '.stack-work',
  '.cabal-sandbox',

  // === SCALA / SBT ===
  'project/target',
  'project/project',

  // === TESTING & COVERAGE ===
  'coverage',
  '.nyc_output',
  '__snapshots__',
  '.jest',
  '.mocha',
  'test-results',
  'test-output',
  'allure-results',
  'allure-report',
  'playwright-report',
  '.playwright',
  'cypress/screenshots',
  'cypress/videos',

  // === CACHES ===
  '.cache',
  '.temp',
  '.tmp',
  'tmp',
  'temp',
  'logs',
  'log',

  // === IDE / EDITOR ===
  '.idea',
  '.vscode',
  '.vs',
  '*.xcodeproj',
  '*.xcworkspace',
  '.settings',
  '.project',
  '.classpath',
  '.factorypath',
  'nbproject',
  '.nb-gradle',
  '.history',

  // === OS GENERATED ===
  '__MACOSX',
  '.Spotlight-V100',
  '.Trashes',
  'ehthumbs.db',
  '$RECYCLE.BIN',

  // === DOCKER ===
  '.docker',

  // === TERRAFORM ===
  '.terraform',
  '.terragrunt-cache',

  // === KUBERNETES / HELM ===
  'charts',

  // === MISC BUILD ARTIFACTS ===
  'artifacts',
  'publish',
  '_site',
  'public/build',
  'static/build',

  // === UNITY ===
  'Library',
  'Temp',
  'Obj',
  'Logs',
  'MemoryCaptures',
  'Build',
  'Builds',
  'UserSettings',

  // === UNREAL ENGINE ===
  'Binaries',
  'Intermediate',
  'Saved',
  'DerivedDataCache',

  // === ELECTRON ===
  '.electron',
  'release-builds',

  // === TAURI ===
  'src-tauri/target',

  // === MONOREPO TOOLS ===
  '.nx',
  '.rush',
  '.pnpm-store',
]);

// File extensions to always block (binary/compiled)
export const EXCLUDED_EXTENSIONS = new Set([
  // Compiled
  '.pyc', '.pyo', '.pyd',
  '.class', '.jar', '.war', '.ear',
  '.dll', '.exe', '.msi', '.msm', '.msp',
  '.o', '.obj', '.a', '.lib', '.so', '.dylib',
  '.ko', '.elf',
  // Debug
  '.pdb', '.idb', '.ilk',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.tgz', '.tbz2', '.txz',
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.icns',
  '.webp', '.tiff', '.tif', '.psd', '.ai', '.raw', '.cr2', '.nef',
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // Media
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov', '.mkv',
  '.flac', '.aac', '.m4a', '.m4v', '.flv', '.wmv',
  // Database
  '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb',
  // Maps
  '.map',
  // Mobile
  '.apk', '.aab', '.ipa', '.dex',
  // Unity/Game
  '.unity', '.prefab', '.asset', '.meta',
  // Other binary
  '.bin', '.dat', '.pak', '.bundle',
]);

// Files that should never be read (lock files, binaries, etc.)
export const EXCLUDED_FILES = new Set([
  // === LOCK FILES (huge, not useful for context) ===
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'pubspec.lock',
  'packages.lock.json',
  'paket.lock',
  'mix.lock',
  'shrinkwrap.yaml',

  // === OS FILES ===
  '.DS_Store',
  'Thumbs.db',
  'Desktop.ini',

  // === ENVIRONMENT FILES ===
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.test',
  '.env.test.local',
  '.env.production',
  '.env.production.local',
  '.envrc',
]);
