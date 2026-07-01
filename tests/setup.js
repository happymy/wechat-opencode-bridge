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
const mockSessionAbort = vi.fn();
const mockSessionRevert = vi.fn();
const mockSessionUnrevert = vi.fn();
const mockModelList = vi.fn();
const mockProviders = vi.fn();
const mockPermissionList = vi.fn();
const mockPermissionReply = vi.fn();
const mockQuestionList = vi.fn();
const mockQuestionReply = vi.fn();
const mockQuestionReject = vi.fn();
const mockEventSubscribe = vi.fn();
const mockProjectList = vi.fn();
const mockProjectDirectories = vi.fn();

const mockClient = {
  session: {
    list: mockSessionList,
    get: mockSessionGet,
    create: mockSessionCreate,
    prompt: mockSessionPrompt,
    status: mockSessionStatus,
    abort: mockSessionAbort,
    revert: mockSessionRevert,
    unrevert: mockSessionUnrevert,
  },
  v2: {
    model: { list: mockModelList },
    session: { compact: vi.fn() },
  },
  config: { providers: mockProviders },
  permission: { list: mockPermissionList, reply: mockPermissionReply },
  question: { list: mockQuestionList, reply: mockQuestionReply, reject: mockQuestionReject },
  event: { subscribe: mockEventSubscribe },
  project: { list: mockProjectList, directories: mockProjectDirectories },
};

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: vi.fn(() => mockClient),
}));

export {
  mockClient,
  mockSessionList, mockSessionGet, mockSessionCreate, mockSessionPrompt, mockSessionStatus,
  mockSessionAbort, mockSessionRevert, mockSessionUnrevert,
  mockModelList, mockProviders,
  mockPermissionList, mockPermissionReply,
  mockQuestionList, mockQuestionReply, mockQuestionReject,
  mockEventSubscribe,
  mockProjectList, mockProjectDirectories,
};
