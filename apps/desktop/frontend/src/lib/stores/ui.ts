export type TopView = 'overview' | 'request' | 'environment' | 'globals' | 'git' | 'runner' | 'collection' | 'mock' | 'history';
export type SettingsTab = 'general' | 'theme' | 'proxy' | 'shortcuts' | 'support' | 'about';
export type SnippetLanguage =
  | 'curl'
  | 'go'
  | 'javascript'
  | 'node'
  | 'python'
  | 'java'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'rust'
  | 'httpie'
  | 'axios';

export const SNIPPET_LABELS: Record<SnippetLanguage, string> = {
  curl: 'cURL',
  go: 'Go native',
  javascript: 'JavaScript fetch',
  node: 'Node.js fetch',
  python: 'Python requests',
  java: 'Java OkHttp',
  csharp: 'C# HttpClient',
  php: 'PHP cURL',
  ruby: 'Ruby Net::HTTP',
  swift: 'Swift URLSession',
  kotlin: 'Kotlin OkHttp',
  rust: 'Rust reqwest',
  httpie: 'HTTPie',
  axios: 'Axios',
};

export const SNIPPET_LANGUAGES: SnippetLanguage[] = [
  'curl',
  'httpie',
  'axios',
  'javascript',
  'node',
  'python',
  'go',
  'java',
  'csharp',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'rust',
];
