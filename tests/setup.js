import { vi } from 'vitest';

vi.mock('node:fs', () => {
  const store = {};
  return {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn((path, data) => { store[path] = data; }),
    statSync: vi.fn(() => ({})),
    _store: store,
  };
});
