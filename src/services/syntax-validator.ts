/**
 * Syntax Validator Service
 * 
 * Uses @babel/parser for production-ready JavaScript/TypeScript/JSX/TSX parsing.
 * This provides accurate syntax validation before the agent writes code to disk.
 */

import { parse, type ParserOptions } from '@babel/parser';

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  line?: number;
  column?: number;
  message: string;
  severity: 'error';
}

export interface ValidationWarning {
  line?: number;
  column?: number;
  message: string;
  severity: 'warning';
}

// File extensions that support validation
const SUPPORTED_EXTENSIONS = ['json', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'mts', 'cjs', 'cts'];

/**
 * Validate file content based on file extension
 */
export function validateSyntax(content: string, filename: string): ValidationResult {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    // No validator for this file type - pass through
    return { valid: true, errors: [], warnings: [] };
  }
  
  if (ext === 'json') {
    return validateJSON(content);
  }
  
  // Use Babel parser for JS/TS/JSX/TSX
  return validateWithBabel(content, ext);
}

/**
 * Check if a file type supports validation
 */
export function supportsValidation(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return SUPPORTED_EXTENSIONS.includes(ext);
}

// ============================================
// JSON VALIDATOR
// ============================================

function validateJSON(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  
  try {
    JSON.parse(content);
    return { valid: true, errors: [], warnings: [] };
  } catch (e) {
    const error = e as SyntaxError;
    const match = error.message.match(/at position (\d+)/);
    let line = 1;
    let column = 1;
    
    if (match) {
      const position = parseInt(match[1], 10);
      const lines = content.substring(0, position).split('\n');
      line = lines.length;
      column = (lines[lines.length - 1]?.length || 0) + 1;
    }
    
    errors.push({
      line,
      column,
      message: `JSON syntax error: ${error.message}`,
      severity: 'error',
    });
    
    return { valid: false, errors, warnings: [] };
  }
}

// ============================================
// BABEL PARSER VALIDATOR
// ============================================

function validateWithBabel(content: string, ext: string): ValidationResult {
  const errors: ValidationError[] = [];
  
  // Determine parser options based on file extension
  const plugins: ParserOptions['plugins'] = [];
  
  // Add TypeScript plugin for .ts/.tsx/.mts/.cts files
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) {
    plugins.push('typescript');
  }
  
  // Add JSX plugin for .jsx/.tsx files
  if (['jsx', 'tsx'].includes(ext)) {
    plugins.push('jsx');
  }
  
  // Common plugins for modern JavaScript/TypeScript
  plugins.push(
    'decorators-legacy',           // Support decorators
    'classProperties',             // Support class properties
    'classPrivateProperties',      // Support private class properties
    'classPrivateMethods',         // Support private class methods
    'exportDefaultFrom',           // Support export default from
    'exportNamespaceFrom',         // Support export * as ns from
    'dynamicImport',               // Support dynamic import()
    'nullishCoalescingOperator',   // Support ??
    'optionalChaining',            // Support ?.
    'optionalCatchBinding',        // Support catch without binding
    'throwExpressions',            // Support throw expressions
    'topLevelAwait',               // Support top-level await
    'importMeta',                  // Support import.meta
    'importAttributes',            // Support import attributes
  );
  
  const parserOptions: ParserOptions = {
    sourceType: 'module',
    allowImportExportEverywhere: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    errorRecovery: false, // We want strict validation
    plugins,
  };
  
  try {
    parse(content, parserOptions);
    return { valid: true, errors: [], warnings: [] };
  } catch (e) {
    const error = e as { loc?: { line: number; column: number }; message: string };
    
    // Extract line and column from Babel error
    const line = error.loc?.line;
    const column = error.loc?.column;
    
    // Clean up the error message (remove position info since we have it separately)
    let message = error.message;
    // Remove the position suffix like " (1:0)"
    message = message.replace(/\s*\(\d+:\d+\)\s*$/, '');
    
    errors.push({
      line,
      column: column !== undefined ? column + 1 : undefined, // Babel columns are 0-indexed
      message,
      severity: 'error',
    });
    
    return { valid: false, errors, warnings: [] };
  }
}

// ============================================
// FORMAT VALIDATION RESULT FOR AGENT
// ============================================

/**
 * Format validation errors for the agent to understand and fix
 */
export function formatValidationForAgent(result: ValidationResult, filename: string): string {
  if (result.valid) {
    return '';
  }
  
  const lines: string[] = [
    `SYNTAX VALIDATION FAILED for ${filename}:`,
    '',
  ];
  
  for (const error of result.errors) {
    if (error.line) {
      lines.push(`  Line ${error.line}${error.column ? `, Col ${error.column}` : ''}: ${error.message}`);
    } else {
      lines.push(`  ${error.message}`);
    }
  }
  
  lines.push('');
  lines.push('Please fix these syntax errors before the file can be saved.');
  
  return lines.join('\n');
}

export default {
  validateSyntax,
  supportsValidation,
  formatValidationForAgent,
};
