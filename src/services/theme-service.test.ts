/**
 * Property-Based Tests for Theme Service
 * 
 * Property 5: Theme File Validation Round-Trip
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5
 * 
 * For any valid theme definition, serializing to JSON and parsing back
 * SHALL produce an equivalent theme. Invalid theme files SHALL be rejected
 * with appropriate error messages.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateThemeFile,
  validateColor,
  mergeWithBaseTheme,
  themeFileToDefinition,
  themeDefinitionToFile,
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
} from './theme-service';
import type { ThemeFile, ThemeTokens, DeepPartial } from '../types/theme';

// ============================================================================
// Arbitrary Generators for Property-Based Testing
// ============================================================================

/**
 * Generate valid hex digit
 */
const hexDigitArb = fc.constantFrom(
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'a', 'b', 'c', 'd', 'e', 'f', 'A', 'B', 'C', 'D', 'E', 'F'
);

/**
 * Generate valid hex color values
 */
const hexColorArb = fc.oneof(
  // #RGB
  fc.tuple(hexDigitArb, hexDigitArb, hexDigitArb)
    .map(([r, g, b]) => `#${r}${g}${b}`),
  // #RRGGBB
  fc.tuple(hexDigitArb, hexDigitArb, hexDigitArb, hexDigitArb, hexDigitArb, hexDigitArb)
    .map(([r1, r2, g1, g2, b1, b2]) => `#${r1}${r2}${g1}${g2}${b1}${b2}`),
  // #RRGGBBAA
  fc.tuple(hexDigitArb, hexDigitArb, hexDigitArb, hexDigitArb, hexDigitArb, hexDigitArb, hexDigitArb, hexDigitArb)
    .map(([r1, r2, g1, g2, b1, b2, a1, a2]) => `#${r1}${r2}${g1}${g2}${b1}${b2}${a1}${a2}`)
);

/**
 * Generate valid RGB color values
 */
const rgbColorArb = fc.tuple(
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 })
).map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);

/**
 * Generate valid RGBA color values
 */
const rgbaColorArb = fc.tuple(
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.float({ min: 0, max: 1, noNaN: true })
).map(([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`);

/**
 * Generate any valid color value
 */
const validColorArb = fc.oneof(hexColorArb, rgbColorArb, rgbaColorArb);

/**
 * Generate invalid color values
 */
const invalidColorArb = fc.oneof(
  fc.constant('not-a-color'),
  fc.constant('#GGG'),
  fc.constant('rgb(300, 0, 0)'),
  fc.constant('rgba(0, 0, 0, 2)'),
  fc.constant(''),
  fc.constant('   ')
);

/**
 * Generate valid theme type
 */
const themeTypeArb = fc.constantFrom('dark', 'light') as fc.Arbitrary<'dark' | 'light'>;

/**
 * Generate valid semver version
 */
const versionArb = fc.tuple(
  fc.integer({ min: 0, max: 99 }),
  fc.integer({ min: 0, max: 99 }),
  fc.integer({ min: 0, max: 99 })
).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/**
 * Generate valid theme metadata (used for reference)
 */
const _themeMetadataArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }),
  author: fc.string({ minLength: 1, maxLength: 50 }),
  version: versionArb,
  type: themeTypeArb,
});
// Suppress unused warning - kept for documentation
void _themeMetadataArb;


/**
 * Generate partial editor tokens with valid colors
 */
const partialEditorTokensArb = fc.record({
  background: validColorArb,
  foreground: validColorArb,
}, { requiredKeys: [] });

/**
 * Generate partial common tokens with valid colors
 */
const partialCommonTokensArb = fc.record({
  primary: validColorArb,
  error: validColorArb,
}, { requiredKeys: [] });

/**
 * Generate partial theme colors
 */
const partialColorsArb = fc.record({
  editor: partialEditorTokensArb,
  common: partialCommonTokensArb,
}, { requiredKeys: [] });

/**
 * Generate valid token color rule
 */
const tokenColorRuleArb = fc.record({
  name: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
  scope: fc.oneof(
    fc.string({ minLength: 1, maxLength: 30 }),
    fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 3 })
  ),
  settings: fc.record({
    foreground: fc.option(hexColorArb, { nil: undefined }),
    fontStyle: fc.option(
      fc.constantFrom('italic', 'bold', 'underline') as fc.Arbitrary<'italic' | 'bold' | 'underline'>,
      { nil: undefined }
    ),
  }),
});

/**
 * Generate valid theme file
 */
const validThemeFileArb: fc.Arbitrary<ThemeFile> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }),
  author: fc.string({ minLength: 1, maxLength: 50 }),
  version: versionArb,
  type: themeTypeArb,
  description: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
  colors: partialColorsArb as fc.Arbitrary<DeepPartial<ThemeTokens>>,
  tokenColors: fc.array(tokenColorRuleArb, { minLength: 0, maxLength: 5 }),
});

// ============================================================================
// Property Tests
// ============================================================================

describe('Theme Service - Property 5: Theme File Validation Round-Trip', () => {
  /**
   * Feature: editor-enhancements, Property 5: Theme File Validation Round-Trip
   * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5
   */

  describe('Color Validation', () => {
    it('should accept all valid hex colors', () => {
      fc.assert(
        fc.property(hexColorArb, (color) => {
          const result = validateColor(color);
          expect(result.valid).toBe(true);
          expect(result.normalizedValue).toBeDefined();
        }),
        { numRuns: 100 }
      );
    });

    it('should accept all valid RGB colors', () => {
      fc.assert(
        fc.property(rgbColorArb, (color) => {
          const result = validateColor(color);
          expect(result.valid).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('should accept all valid RGBA colors', () => {
      fc.assert(
        fc.property(rgbaColorArb, (color) => {
          const result = validateColor(color);
          expect(result.valid).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('should reject invalid colors with error messages', () => {
      fc.assert(
        fc.property(invalidColorArb, (color) => {
          const result = validateColor(color);
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        }),
        { numRuns: 100 }
      );
    });
  });


  describe('Theme File Validation', () => {
    it('should validate all valid theme files', () => {
      fc.assert(
        fc.property(validThemeFileArb, (themeFile) => {
          const result = validateThemeFile(themeFile);
          // Valid theme files should pass validation
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        }),
        { numRuns: 100 }
      );
    });

    it('should reject theme files missing required metadata', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('name', 'author', 'version', 'type'),
          validThemeFileArb,
          (missingField, themeFile) => {
            // Remove a required field
            const invalidTheme = { ...themeFile };
            delete (invalidTheme as Record<string, unknown>)[missingField];

            const result = validateThemeFile(invalidTheme);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes(missingField))).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should reject theme files with invalid type', () => {
      fc.assert(
        fc.property(
          validThemeFileArb,
          fc.string({ minLength: 1 }).filter(s => s !== 'dark' && s !== 'light'),
          (themeFile, invalidType) => {
            const invalidTheme = { ...themeFile, type: invalidType };
            const result = validateThemeFile(invalidTheme);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('type'))).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Theme Merging with Base', () => {
    it('should preserve all base tokens when merging empty partial', () => {
      fc.assert(
        fc.property(themeTypeArb, (type) => {
          const base = type === 'dark' ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS;
          const merged = mergeWithBaseTheme({}, type);

          // All base tokens should be preserved
          expect(merged.editor.background).toBe(base.editor.background);
          expect(merged.common.primary).toBe(base.common.primary);
          expect(merged.terminal.red).toBe(base.terminal.red);
        }),
        { numRuns: 100 }
      );
    });

    it('should override base tokens with partial values', () => {
      fc.assert(
        fc.property(
          themeTypeArb,
          validColorArb,
          (type, customColor) => {
            const partial: DeepPartial<ThemeTokens> = {
              editor: { background: customColor },
            };
            const merged = mergeWithBaseTheme(partial, type);

            // Custom color should override base
            expect(merged.editor.background).toBe(customColor);
            // Other tokens should remain from base
            const base = type === 'dark' ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS;
            expect(merged.editor.foreground).toBe(base.editor.foreground);
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  describe('Round-Trip Conversion', () => {
    it('should preserve theme data through file-to-definition-to-file conversion', () => {
      fc.assert(
        fc.property(
          validThemeFileArb,
          fc.uuid(),
          (themeFile, id) => {
            // Convert to definition
            const definition = themeFileToDefinition(themeFile, id, false);

            // Verify definition has correct metadata
            expect(definition.id).toBe(id);
            expect(definition.name).toBe(themeFile.name);
            expect(definition.author).toBe(themeFile.author);
            expect(definition.version).toBe(themeFile.version);
            expect(definition.type).toBe(themeFile.type);
            expect(definition.isBuiltIn).toBe(false);

            // Convert back to file
            const roundTripped = themeDefinitionToFile(definition);

            // Verify metadata is preserved
            expect(roundTripped.name).toBe(themeFile.name);
            expect(roundTripped.author).toBe(themeFile.author);
            expect(roundTripped.version).toBe(themeFile.version);
            expect(roundTripped.type).toBe(themeFile.type);

            // Token colors should be preserved
            expect(roundTripped.tokenColors).toEqual(themeFile.tokenColors);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should produce valid theme files after round-trip', () => {
      fc.assert(
        fc.property(
          validThemeFileArb,
          fc.uuid(),
          (themeFile, id) => {
            // Convert to definition and back
            const definition = themeFileToDefinition(themeFile, id, false);
            const roundTripped = themeDefinitionToFile(definition);

            // The round-tripped file should still be valid
            const result = validateThemeFile(roundTripped);
            expect(result.valid).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Built-in Theme Protection', () => {
    it('should correctly mark built-in themes', () => {
      fc.assert(
        fc.property(
          validThemeFileArb,
          fc.uuid(),
          fc.boolean(),
          (themeFile, id, isBuiltIn) => {
            const definition = themeFileToDefinition(themeFile, id, isBuiltIn);
            expect(definition.isBuiltIn).toBe(isBuiltIn);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
