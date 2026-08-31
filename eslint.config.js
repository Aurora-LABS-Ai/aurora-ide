import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * Module boundaries (see reorganized-plan.md, Phase 2.3).
 *
 * Aurora ships two products from one bundle: the IDE (`src/components`,
 * `src/hooks`) and the agent window (`src/agent-window`). They share a kernel
 * of stores/services/lib. The direction that must hold is:
 *
 *     ide → shared        agent → shared        ide ↮ agent
 *
 * Without this rule the two drift back into each other — which is how the IDE
 * ended up transitively bundling the entire agent app through one barrel
 * import. Enforced on the specifier, so it catches both `@/agent-window/…`
 * and relative `../agent-window/…` forms.
 *
 * Phase 3 moves these folders to `apps/ide`, `apps/agent` and `kernel`; only
 * the globs below need to change, not the intent.
 */
const NO_AGENT_FROM_IDE = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@/apps/agent/**', '**/apps/agent/**'],
          message:
            'IDE and kernel code must not reach into the agent app. If both products need this, move it to kernel/ (see reorganized-plan.md).',
        },
      ],
    },
  ],
}

/** kernel is the shared floor: it may not depend on either product. */
const KERNEL_DEPENDS_ON_NOTHING = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@/apps/**', '**/apps/**'],
          message:
            'kernel/ must not import from apps/. The dependency direction is apps → kernel, never back.',
        },
      ],
    },
  ],
}

/**
 * IDE-owned component folders, listed explicitly rather than as
 * `@/components/**` + `!@/components/ui/**`. Negation inside a `group` is not
 * dependable here, and a silently-inverted rule is worse than a verbose one.
 * `components/ui` is deliberately absent — it is the shared primitive layer
 * (Phase 3: `kernel/ui`) and the agent window is meant to use it.
 *
 * Only alias forms need listing: after the Phase 2.2 codemod every
 * boundary-crossing import is `@/…`, while `../hooks/…` inside the agent
 * window resolves to the agent's OWN hooks and must stay legal.
 */
const NO_IDE_FROM_AGENT = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@/apps/ide/**', '**/apps/ide/**'],
          message:
            'The agent app must not import from the IDE app. Shared primitives live in kernel/ui, shared logic in kernel/.',
        },
      ],
    },
  ],
}

export default defineConfig([
  // Everything here is GENERATED or VENDORED — nobody authors it, so a finding
  // in it is not something anyone can act on, and there are enough of them to
  // hide the findings that are.
  //
  //   dist, build, src-tauri/target, src-tauri/gen
  //     Build output. `build/` is where Tauri puts the compiled app (aurora.exe,
  //     .pdb, DirectML.dll, installer bundles) and it also carries whatever JS
  //     the bundler happened to emit. ESLint cannot parse most of it, so it
  //     reported 1018 parse errors from `build/release` alone — against 47 real
  //     findings in src/. A whole-repo run was therefore useless: a genuine
  //     regression could not be seen in the noise, so nobody ran it, so the
  //     gate did not exist. All four are gitignored (.gitignore: dist, build,
  //     target, src-tauri/target/, src-tauri/gen/).
  //
  //   thirdparty
  //     Vendored upstream repos kept for reference — their own git, their own
  //     style, their own lint config. Gitignored and never bundled, so linting
  //     it buries Aurora's own findings under other projects' opinions.
  //
  // Anything added here must be genuinely generated or vendored. Silencing
  // authored code by adding its folder is how a lint gate stops meaning
  // anything; disable the specific rule on the specific line instead, with the
  // reason.
  globalIgnores([
    'dist',
    'build',
    'src-tauri/target',
    'src-tauri/gen',
    'thirdparty',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },

  // ── IDE + kernel code may not import the agent app ────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/apps/agent/**',
      // The router. It renders <AgentWindow/> for the /agent-window route and
      // is the one file that legitimately knows about both products.
      'src/App.tsx',
      'src/main.tsx',
      // Launcher. Imports apps/agent/adapters/window (an invoke wrapper) to
      // open the separate OS window. Must NOT import the app's barrel — that
      // pulls the whole agent app into the IDE chunk.
      'src/apps/ide/app/TitleBar.tsx',
      // The bridge exists precisely to span both products (agent events →
      // Monaco, agent file writes → editor, close → save both). Making it
      // obey the rule would only push the same coupling somewhere less
      // honest. Keep it small: if something here serves ONE product, it
      // belongs in that product.
      'src/bridge/**',
      // TODO(reorg 3.5): the 2110-line settings store still mixes agent
      // config (providers, models, execution mode) with editor prefs.
      // Splitting it removes this exemption. Do not add files to this list.
      'src/kernel/store/useSettingsStore.ts',
    ],
    rules: NO_AGENT_FROM_IDE,
  },

  // ── The agent app may not import the IDE app ──────────────────────────────
  {
    files: ['src/apps/agent/**/*.{ts,tsx}'],
    rules: NO_IDE_FROM_AGENT,
  },

  // ── kernel is the floor: it depends on neither product ────────────────────
  {
    files: ['src/kernel/**/*.{ts,tsx}'],
    // See the TODO(reorg 3.5) note above — same store, same reason.
    ignores: ['src/kernel/store/useSettingsStore.ts'],
    rules: KERNEL_DEPENDS_ON_NOTHING,
  },
])
