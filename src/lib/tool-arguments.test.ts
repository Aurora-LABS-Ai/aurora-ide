import { describe, expect, it } from 'vitest';

import { parseToolArguments, parseToolArgumentsForDisplay } from './tool-arguments';

describe('parseToolArguments', () => {
  it('parses valid argument objects', () => {
    const result = parseToolArguments('{"command":"echo hello","timeout":1200}');

    expect(result.status).toBe('parsed');
    expect(result.args).toEqual({
      command: 'echo hello',
      timeout: 1200,
    });
  });

  it('repairs invalid Windows path backslashes', () => {
    const raw = '{"path":"C:' + '\\' + 'Users' + '\\' + 'Alvan' + '\\' + 'project"}';
    const result = parseToolArguments(raw);

    expect(result.status).toBe('repaired');
    expect(result.args).toEqual({
      path: 'C:\\Users\\Alvan\\project',
    });
  });

  it('marks incomplete JSON as invalid', () => {
    const result = parseToolArguments('{"path":"E:/VOID-EDITOR"');

    expect(result.status).toBe('invalid');
    expect(result.args).toEqual({});
    expect(result.error).toBeDefined();
  });
});

describe('parseToolArgumentsForDisplay', () => {
  it('falls back to raw payload for invalid JSON', () => {
    const raw = '{"path":"C:' + '\\' + 'Users' + '\\' + 'Alvan"';
    const displayArgs = parseToolArgumentsForDisplay(raw);

    expect(displayArgs).toEqual({ raw });
  });
});
