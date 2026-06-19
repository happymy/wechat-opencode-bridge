import { vi } from 'vitest';

vi.mock('node:readline', () => ({
  createInterface: () => ({ on: vi.fn(), close: vi.fn() }),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => '00000000-0000-0000-0000-000000000000'),
}));

const mockSessionList = vi.fn();
const mockSessionGet = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionPrompt = vi.fn();
const mockSessionStatus = vi.fn();
const mockModelList = vi.fn();
const mockProviders = vi.fn();

const mockClient = {
  session: {
    list: mockSessionList,
    get: mockSessionGet,
    create: mockSessionCreate,
    prompt: mockSessionPrompt,
    status: mockSessionStatus,
    compact: vi.fn(),
  },
  v2: { model: { list: mockModelList } },
  config: { providers: mockProviders },
};

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: vi.fn(() => mockClient),
}));

export { mockClient, mockSessionList, mockSessionGet, mockSessionCreate, mockSessionPrompt, mockSessionStatus, mockModelList, mockProviders };
