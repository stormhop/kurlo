export const stepPauseMs = Number.parseInt(process.env.KURLO_E2E_STEP_PAUSE_MS ?? '0', 10);

export const responseScreenshotPath = process.env.KURLO_E2E_RESPONSE_SCREENSHOT ?? '';

export const docsScreenshotDir = process.env.KURLO_DOCS_SCREENSHOT_DIR ?? '';

export const readmeScreenshotPath = process.env.KURLO_README_SCREENSHOT ?? '';

export const aboutScreenshotDir = process.env.KURLO_ABOUT_SCREENSHOT_DIR ?? '';

export const DOCS_VIEWPORT = { width: 1200, height: 780 };

export const DOCS_CROP_PADDING = 26;

export const DOCS_DARK_VARIANTS = new Set(['request-mqtt', 'request-kafka', 'request-editor', 'request-mcp', 'request-ai', 'agent-approval', 'collection-docs-generate', 'collection-docs-folders', 'secret-managers-environment']);
