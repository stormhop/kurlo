export type AppThemeMode = 'system' | 'dark' | 'light';
export type ResolvedAppTheme = 'dark' | 'light';

export type LightThemeVariantId =
  | 'light'
  | 'github-light'
  | 'jetbrains-light'
  | 'vscode-light'
  | 'catppuccin-latte'
  | 'flexoki-paper'
  | 'high-contrast-light';

export type DarkThemeVariantId =
  | 'dark'
  | 'github-dimmed'
  | 'jetbrains-dark'
  | 'vscode-dark'
  | 'one-dark'
  | 'tokyo-night'
  | 'catppuccin-mocha'
  | 'nord'
  | 'everforest'
  | 'high-contrast-dark';

export type ThemeVariantId = LightThemeVariantId | DarkThemeVariantId;

export type AppTheme = {
  mode: AppThemeMode;
  light: LightThemeVariantId;
  dark: DarkThemeVariantId;
};

export type ThemeVariant = {
  id: ThemeVariantId;
  mode: ResolvedAppTheme;
  name: string;
  preview: {
    background: string;
    surface: string;
    rail: string;
    border: string;
    accent: string;
    text: string;
  };
};

export const THEME_KEY = 'kurlo.theme.v2';
const LEGACY_THEME_KEY = 'kurlo.theme.v1';

export const DEFAULT_THEME_SETTINGS: AppTheme = {
  mode: 'system',
  light: 'light',
  dark: 'dark',
};

export const THEME_VARIANTS: ThemeVariant[] = [
  {
    id: 'light',
    mode: 'light',
    name: 'Light',
    preview: { background: '#ffffff', surface: '#f7f7f8', rail: '#ececef', border: '#dfdfe4', accent: '#4f5be8', text: '#17171a' },
  },
  {
    id: 'github-light',
    mode: 'light',
    name: 'GitHub Light',
    preview: { background: '#ffffff', surface: '#f6f8fa', rail: '#e6eaef', border: '#d1d9e0', accent: '#0969da', text: '#1f2328' },
  },
  {
    id: 'jetbrains-light',
    mode: 'light',
    name: 'JetBrains Light',
    preview: { background: '#ffffff', surface: '#f7f8fa', rail: '#dfe1e5', border: '#dfe1e5', accent: '#336fe6', text: '#000000' },
  },
  {
    id: 'vscode-light',
    mode: 'light',
    name: 'VS Code Light Modern',
    preview: { background: '#ffffff', surface: '#f8f8f8', rail: '#e8e8e8', border: '#e0e0e0', accent: '#005fb8', text: '#1f1f1f' },
  },
  {
    id: 'catppuccin-latte',
    mode: 'light',
    name: 'Catppuccin Latte',
    preview: { background: '#eff1f5', surface: '#e6e9ef', rail: '#ccd0da', border: '#c5c9d4', accent: '#8839ef', text: '#4c4f69' },
  },
  {
    id: 'flexoki-paper',
    mode: 'light',
    name: 'Flexoki Paper',
    preview: { background: '#fffcf0', surface: '#f2f0e5', rail: '#dad8ce', border: '#dad8ce', accent: '#205ea6', text: '#100f0f' },
  },
  {
    id: 'high-contrast-light',
    mode: 'light',
    name: 'High Contrast Light',
    preview: { background: '#ffffff', surface: '#f4f4f5', rail: '#dcdce0', border: '#6e6e78', accent: '#1d3fc4', text: '#000000' },
  },
  {
    id: 'dark',
    mode: 'dark',
    name: 'Dark',
    preview: { background: '#111113', surface: '#0c0c0e', rail: '#1f1f23', border: '#2d2d32', accent: '#5865f2', text: '#ececef' },
  },
  {
    id: 'github-dimmed',
    mode: 'dark',
    name: 'GitHub Dark Dimmed',
    preview: { background: '#22272e', surface: '#1c2128', rail: '#2d333b', border: '#444c56', accent: '#316dca', text: '#cdd9e5' },
  },
  {
    id: 'jetbrains-dark',
    mode: 'dark',
    name: 'JetBrains Dark',
    preview: { background: '#1e1f22', surface: '#191a1c', rail: '#2b2d30', border: '#393b40', accent: '#336fe6', text: '#dfe1e5' },
  },
  {
    id: 'vscode-dark',
    mode: 'dark',
    name: 'VS Code Dark Modern',
    preview: { background: '#1f1f1f', surface: '#181818', rail: '#323232', border: '#3c3c3c', accent: '#0077d2', text: '#cccccc' },
  },
  {
    id: 'one-dark',
    mode: 'dark',
    name: 'One Dark',
    preview: { background: '#282c34', surface: '#21252b', rail: '#2f343e', border: '#3e4452', accent: '#4b74c6', text: '#d7dae0' },
  },
  {
    id: 'tokyo-night',
    mode: 'dark',
    name: 'Tokyo Night',
    preview: { background: '#1a1b26', surface: '#16161e', rail: '#222436', border: '#2f3549', accent: '#7aa2f7', text: '#c0caf5' },
  },
  {
    id: 'catppuccin-mocha',
    mode: 'dark',
    name: 'Catppuccin Mocha',
    preview: { background: '#1e1e2e', surface: '#181825', rail: '#2a2b3c', border: '#3c3e52', accent: '#cba6f7', text: '#cdd6f4' },
  },
  {
    id: 'nord',
    mode: 'dark',
    name: 'Nord',
    preview: { background: '#2e3440', surface: '#292e39', rail: '#3b4252', border: '#4c566a', accent: '#88c0d0', text: '#d8dee9' },
  },
  {
    id: 'everforest',
    mode: 'dark',
    name: 'Everforest',
    preview: { background: '#2d353b', surface: '#272e33', rail: '#343f44', border: '#475258', accent: '#a7c080', text: '#d3c6aa' },
  },
  {
    id: 'high-contrast-dark',
    mode: 'dark',
    name: 'High Contrast Dark',
    preview: { background: '#0b0b0c', surface: '#000000', rail: '#18181b', border: '#8c8c96', accent: '#8c9bff', text: '#ffffff' },
  },
];

export const LIGHT_THEME_VARIANTS = THEME_VARIANTS.filter((variant): variant is ThemeVariant & { id: LightThemeVariantId; mode: 'light' } => variant.mode === 'light');
export const DARK_THEME_VARIANTS = THEME_VARIANTS.filter((variant): variant is ThemeVariant & { id: DarkThemeVariantId; mode: 'dark' } => variant.mode === 'dark');

const LIGHT_THEME_IDS = new Set<ThemeVariantId>(LIGHT_THEME_VARIANTS.map(variant => variant.id));
const DARK_THEME_IDS = new Set<ThemeVariantId>(DARK_THEME_VARIANTS.map(variant => variant.id));
export const RETIRED_THEME_VARIANTS: Record<string, ThemeVariantId> = {
  'light-monochrome': 'light',
  'light-pastel': 'flexoki-paper',
  'dark-monochrome': 'dark',
  'dark-pastel': 'everforest',
  'catppuccin-frappe': 'catppuccin-mocha',
  'catppuccin-macchiato': 'catppuccin-mocha',
};

const THEME_VARIANT_BY_ID = new Map<ThemeVariantId, ThemeVariant>(THEME_VARIANTS.map(variant => [variant.id, variant]));

function isAppThemeMode(value: unknown): value is AppThemeMode {
  return value === 'system' || value === 'dark' || value === 'light';
}

function currentVariantId(value: unknown): unknown {
  return typeof value === 'string' && Object.hasOwn(RETIRED_THEME_VARIANTS, value) ? RETIRED_THEME_VARIANTS[value] : value;
}

function isLightThemeVariant(value: unknown): value is LightThemeVariantId {
  return typeof value === 'string' && LIGHT_THEME_IDS.has(value as ThemeVariantId);
}

function isDarkThemeVariant(value: unknown): value is DarkThemeVariantId {
  return typeof value === 'string' && DARK_THEME_IDS.has(value as ThemeVariantId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeThemeSettings(input: unknown): AppTheme {
  if (isAppThemeMode(input)) {
    return { ...DEFAULT_THEME_SETTINGS, mode: input };
  }
  if (!isRecord(input)) return { ...DEFAULT_THEME_SETTINGS };
  const light = currentVariantId(input.light);
  const dark = currentVariantId(input.dark);
  return {
    mode: isAppThemeMode(input.mode) ? input.mode : DEFAULT_THEME_SETTINGS.mode,
    light: isLightThemeVariant(light) ? light : DEFAULT_THEME_SETTINGS.light,
    dark: isDarkThemeVariant(dark) ? dark : DEFAULT_THEME_SETTINGS.dark,
  };
}

export function systemTheme(): ResolvedAppTheme {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function readStoredAppTheme(): AppTheme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored) return normalizeThemeSettings(JSON.parse(stored));
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    const migrated = normalizeThemeSettings(legacy);
    if (legacy) localStorage.setItem(THEME_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {}
  return { ...DEFAULT_THEME_SETTINGS };
}

export function resolveAppTheme(settings: AppTheme): ResolvedAppTheme {
  return settings.mode === 'system' ? systemTheme() : settings.mode;
}

export function withThemeVariant(settings: AppTheme, id: ThemeVariantId): AppTheme {
  if (isLightThemeVariant(id)) return { ...settings, light: id };
  if (isDarkThemeVariant(id)) return { ...settings, dark: id };
  return settings;
}

export function themeVariantFor(settings: AppTheme, resolvedAppTheme = resolveAppTheme(settings)): ThemeVariant {
  const id = resolvedAppTheme === 'light' ? settings.light : settings.dark;
  return THEME_VARIANT_BY_ID.get(id) ?? THEME_VARIANT_BY_ID.get(DEFAULT_THEME_SETTINGS[resolvedAppTheme])!;
}

export function applyDocumentTheme(settings: AppTheme = readStoredAppTheme()) {
  const appTheme = normalizeThemeSettings(settings);
  const resolvedAppTheme = resolveAppTheme(appTheme);
  const themeVariant = themeVariantFor(appTheme, resolvedAppTheme);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolvedAppTheme;
    document.documentElement.dataset.themeVariant = themeVariant.id;
    document.documentElement.style.colorScheme = resolvedAppTheme;
  }
  return { appTheme, resolvedAppTheme, themeVariant };
}

export function syncNativeThemeBackground(resolvedAppTheme: ResolvedAppTheme, themeVariant = themeVariantFor(DEFAULT_THEME_SETTINGS, resolvedAppTheme)) {
  const hex = themeVariant.preview.background.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  try {
    if (resolvedAppTheme === 'dark') window.runtime?.WindowSetDarkTheme?.();
    else window.runtime?.WindowSetLightTheme?.();
    window.runtime?.WindowSetBackgroundColour?.(r, g, b, 255);
    void window.go?.api?.App?.SetAppThemeBackground?.(resolvedAppTheme, themeVariant.preview.background);
  } catch {}
}

export const initialThemeState = applyDocumentTheme();
