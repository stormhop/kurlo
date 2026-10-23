import type { Component } from 'svelte';
import type { Method, RequestTab, RequestType } from '../types/models';
import type { TopView } from './ui';

export type LazyComponent = Component<Record<string, unknown>>;

export type AppLazyComponentState = {
  requestTab: RequestTab;
  requestType: RequestType;
  method: Method;
  topView: TopView;
  codePanelOpen: boolean;
  codePanelAvailable: boolean;
  cookieJarOpen: boolean;
  globalSearchOpen: boolean;
  settingsOpen: boolean;
  sseSessionVisible: boolean;
};

class AppLazyComponents {
  AuthTabComponent = $state<LazyComponent | null>(null);
  BodyTabComponent = $state<LazyComponent | null>(null);
  CodeSnippetPanelComponent = $state<LazyComponent | null>(null);
  CollectionRunnerWorkspaceComponent = $state<LazyComponent | null>(null);
  CollectionWorkspaceComponent = $state<LazyComponent | null>(null);
  CookieJarModalComponent = $state<LazyComponent | null>(null);
  DocsTabComponent = $state<LazyComponent | null>(null);
  EnvironmentWorkspaceComponent = $state<LazyComponent | null>(null);
  ExamplesTabComponent = $state<LazyComponent | null>(null);
  GitWorkspaceComponent = $state<LazyComponent | null>(null);
  MockServerWorkspaceComponent = $state<LazyComponent | null>(null);
  GlobalSearchModalComponent = $state<LazyComponent | null>(null);
  GraphQLQueryTabComponent = $state<LazyComponent | null>(null);
  GraphQLSchemaTabComponent = $state<LazyComponent | null>(null);
  GrpcMessageTabComponent = $state<LazyComponent | null>(null);
  GrpcMetadataTabComponent = $state<LazyComponent | null>(null);
  GrpcResponsePanelComponent = $state<LazyComponent | null>(null);
  McpCallTabComponent = $state<LazyComponent | null>(null);
  McpResponsePanelComponent = $state<LazyComponent | null>(null);
  AiPromptTabComponent = $state<LazyComponent | null>(null);
  AiToolsTabComponent = $state<LazyComponent | null>(null);
  AiConversationPanelComponent = $state<LazyComponent | null>(null);
  GrpcServiceDefinitionTabComponent = $state<LazyComponent | null>(null);
  GrpcSettingsTabComponent = $state<LazyComponent | null>(null);
  HeadersTabComponent = $state<LazyComponent | null>(null);
  ParamsTabComponent = $state<LazyComponent | null>(null);
  RequestSettingsTabComponent = $state<LazyComponent | null>(null);
  ResponsePanelComponent = $state<LazyComponent | null>(null);
  ScriptsTabComponent = $state<LazyComponent | null>(null);
  SettingsModalComponent = $state<LazyComponent | null>(null);
  SSEPanelComponent = $state<LazyComponent | null>(null);
  SocketIOEventsTabComponent = $state<LazyComponent | null>(null);
  SocketIOMessageTabComponent = $state<LazyComponent | null>(null);
  SocketIOPanelComponent = $state<LazyComponent | null>(null);
  SocketIOSettingsTabComponent = $state<LazyComponent | null>(null);
  WebSocketMessageTabComponent = $state<LazyComponent | null>(null);
  WebSocketPanelComponent = $state<LazyComponent | null>(null);
  WebSocketSettingsTabComponent = $state<LazyComponent | null>(null);

  async loadAuthTab() {
    if (!this.AuthTabComponent) this.AuthTabComponent = (await import('../components/AuthTab.svelte')).default as LazyComponent;
  }

  async loadBodyTab() {
    if (!this.BodyTabComponent) this.BodyTabComponent = (await import('../components/BodyTab.svelte')).default as LazyComponent;
  }

  async loadCodeSnippetPanel() {
    if (!this.CodeSnippetPanelComponent) this.CodeSnippetPanelComponent = (await import('../components/CodeSnippetPanel.svelte')).default as LazyComponent;
  }

  async loadCollectionRunnerWorkspace() {
    if (!this.CollectionRunnerWorkspaceComponent) this.CollectionRunnerWorkspaceComponent = (await import('../components/CollectionRunnerWorkspace.svelte')).default as LazyComponent;
  }

  async loadCollectionWorkspace() {
    if (!this.CollectionWorkspaceComponent) this.CollectionWorkspaceComponent = (await import('../components/CollectionWorkspace.svelte')).default as LazyComponent;
  }

  async loadCookieJarModal() {
    if (!this.CookieJarModalComponent) this.CookieJarModalComponent = (await import('../components/CookieJarModal.svelte')).default as LazyComponent;
  }

  async loadDocsTab() {
    if (!this.DocsTabComponent) this.DocsTabComponent = (await import('../components/DocsTab.svelte')).default as LazyComponent;
  }

  async loadEnvironmentWorkspace() {
    if (!this.EnvironmentWorkspaceComponent) this.EnvironmentWorkspaceComponent = (await import('../components/EnvironmentWorkspace.svelte')).default as LazyComponent;
  }

  async loadGitWorkspace() {
    if (!this.GitWorkspaceComponent) this.GitWorkspaceComponent = (await import('../components/GitWorkspace.svelte')).default as LazyComponent;
  }

  async loadMockServerWorkspace() {
    if (!this.MockServerWorkspaceComponent) this.MockServerWorkspaceComponent = (await import('../components/MockServerWorkspace.svelte')).default as LazyComponent;
  }

  async loadGlobalSearchModal() {
    if (!this.GlobalSearchModalComponent) this.GlobalSearchModalComponent = (await import('../components/GlobalSearchModal.svelte')).default as LazyComponent;
  }

  async loadGraphQLQueryTab() {
    if (!this.GraphQLQueryTabComponent) this.GraphQLQueryTabComponent = (await import('../components/GraphQLQueryTab.svelte')).default as LazyComponent;
  }

  async loadGraphQLSchemaTab() {
    if (!this.GraphQLSchemaTabComponent) this.GraphQLSchemaTabComponent = (await import('../components/GraphQLSchemaTab.svelte')).default as LazyComponent;
  }

  async loadGrpcMessageTab() {
    if (!this.GrpcMessageTabComponent) this.GrpcMessageTabComponent = (await import('../components/GrpcMessageTab.svelte')).default as LazyComponent;
  }

  async loadGrpcMetadataTab() {
    if (!this.GrpcMetadataTabComponent) this.GrpcMetadataTabComponent = (await import('../components/GrpcMetadataTab.svelte')).default as LazyComponent;
  }

  async loadGrpcResponsePanel() {
    if (!this.GrpcResponsePanelComponent) this.GrpcResponsePanelComponent = (await import('../components/GrpcResponsePanel.svelte')).default as LazyComponent;
  }

  async loadMcpCallTab() {
    if (!this.McpCallTabComponent) this.McpCallTabComponent = (await import('../components/McpCallTab.svelte')).default as LazyComponent;
  }

  async loadMcpResponsePanel() {
    if (!this.McpResponsePanelComponent) this.McpResponsePanelComponent = (await import('../components/McpResponsePanel.svelte')).default as LazyComponent;
  }

  async loadAiPromptTab() {
    if (!this.AiPromptTabComponent) this.AiPromptTabComponent = (await import('../components/AiPromptTab.svelte')).default as LazyComponent;
  }

  async loadAiToolsTab() {
    if (!this.AiToolsTabComponent) this.AiToolsTabComponent = (await import('../components/AiToolsTab.svelte')).default as LazyComponent;
  }

  async loadAiConversationPanel() {
    if (!this.AiConversationPanelComponent) this.AiConversationPanelComponent = (await import('../components/AiConversationPanel.svelte')).default as LazyComponent;
  }

  async loadGrpcServiceDefinitionTab() {
    if (!this.GrpcServiceDefinitionTabComponent) this.GrpcServiceDefinitionTabComponent = (await import('../components/GrpcServiceDefinitionTab.svelte')).default as LazyComponent;
  }

  async loadGrpcSettingsTab() {
    if (!this.GrpcSettingsTabComponent) this.GrpcSettingsTabComponent = (await import('../components/GrpcSettingsTab.svelte')).default as LazyComponent;
  }

  async loadHeadersTab() {
    if (!this.HeadersTabComponent) this.HeadersTabComponent = (await import('../components/HeadersTab.svelte')).default as LazyComponent;
  }

  async loadParamsTab() {
    if (!this.ParamsTabComponent) this.ParamsTabComponent = (await import('../components/ParamsTab.svelte')).default as LazyComponent;
  }

  async loadRequestSettingsTab() {
    if (!this.RequestSettingsTabComponent) this.RequestSettingsTabComponent = (await import('../components/RequestSettingsTab.svelte')).default as LazyComponent;
  }

  async loadResponsePanel() {
    if (!this.ResponsePanelComponent) this.ResponsePanelComponent = (await import('../components/ResponsePanel.svelte')).default as LazyComponent;
  }

  async loadExamplesTab() {
    if (!this.ExamplesTabComponent) this.ExamplesTabComponent = (await import('../components/ExamplesTab.svelte')).default as LazyComponent;
  }

  async loadScriptsTab() {
    if (!this.ScriptsTabComponent) this.ScriptsTabComponent = (await import('../components/ScriptsTab.svelte')).default as LazyComponent;
  }

  async loadSettingsModal() {
    if (!this.SettingsModalComponent) this.SettingsModalComponent = (await import('../components/SettingsModal.svelte')).default as LazyComponent;
  }

  async loadSSEPanel() {
    if (!this.SSEPanelComponent) this.SSEPanelComponent = (await import('../components/SSEPanel.svelte')).default as LazyComponent;
  }

  async loadSocketIOEventsTab() {
    if (!this.SocketIOEventsTabComponent) this.SocketIOEventsTabComponent = (await import('../components/SocketIOEventsTab.svelte')).default as LazyComponent;
  }

  async loadSocketIOMessageTab() {
    if (!this.SocketIOMessageTabComponent) this.SocketIOMessageTabComponent = (await import('../components/SocketIOMessageTab.svelte')).default as LazyComponent;
  }

  async loadSocketIOPanel() {
    if (!this.SocketIOPanelComponent) this.SocketIOPanelComponent = (await import('../components/SocketIOPanel.svelte')).default as LazyComponent;
  }

  async loadSocketIOSettingsTab() {
    if (!this.SocketIOSettingsTabComponent) this.SocketIOSettingsTabComponent = (await import('../components/SocketIOSettingsTab.svelte')).default as LazyComponent;
  }

  async loadWebSocketMessageTab() {
    if (!this.WebSocketMessageTabComponent) this.WebSocketMessageTabComponent = (await import('../components/WebSocketMessageTab.svelte')).default as LazyComponent;
  }

  async loadWebSocketPanel() {
    if (!this.WebSocketPanelComponent) this.WebSocketPanelComponent = (await import('../components/WebSocketPanel.svelte')).default as LazyComponent;
  }

  async loadWebSocketSettingsTab() {
    if (!this.WebSocketSettingsTabComponent) this.WebSocketSettingsTabComponent = (await import('../components/WebSocketSettingsTab.svelte')).default as LazyComponent;
  }

  preloadForAppShell(state: AppLazyComponentState) {
    if (state.requestTab === 'auth') void this.loadAuthTab();
    if (state.requestTab === 'body') void this.loadBodyTab();
    if (state.requestTab === 'docs') void this.loadDocsTab();
    if (state.requestTab === 'headers') void this.loadHeadersTab();
    if (state.requestTab === 'params') void this.loadParamsTab();
    if (state.requestTab === 'scripts') void this.loadScriptsTab();
    if (state.requestTab === 'examples') void this.loadExamplesTab();
    if (state.requestTab === 'settings' && state.requestType !== 'ws' && state.requestType !== 'socketio' && state.requestType !== 'grpc') void this.loadRequestSettingsTab();
    if (state.codePanelOpen && state.codePanelAvailable) void this.loadCodeSnippetPanel();
    if (state.cookieJarOpen) void this.loadCookieJarModal();
    if (state.globalSearchOpen) void this.loadGlobalSearchModal();
    if (state.settingsOpen) void this.loadSettingsModal();
    if (state.topView === 'collection') void this.loadCollectionWorkspace();
    if (state.topView === 'environment') void this.loadEnvironmentWorkspace();
    if (state.topView === 'git') void this.loadGitWorkspace();
    if (state.topView === 'runner') void this.loadCollectionRunnerWorkspace();
    if (state.topView === 'mock') void this.loadMockServerWorkspace();
    if (state.requestType === 'graphql' && state.requestTab === 'query') void this.loadGraphQLQueryTab();
    if (state.requestType === 'graphql' && state.requestTab === 'schema') void this.loadGraphQLSchemaTab();
    if (state.requestType === 'http' && (state.method === 'SSE' || state.sseSessionVisible)) void this.loadSSEPanel();
    if (state.requestType === 'ws') {
      void this.loadWebSocketPanel();
      if (state.requestTab === 'body') void this.loadWebSocketMessageTab();
      if (state.requestTab === 'settings') void this.loadWebSocketSettingsTab();
    }
    if (state.requestType === 'socketio') {
      void this.loadSocketIOPanel();
      if (state.requestTab === 'body') void this.loadSocketIOMessageTab();
      if (state.requestTab === 'events') void this.loadSocketIOEventsTab();
      if (state.requestTab === 'settings') void this.loadSocketIOSettingsTab();
    }
    if (state.requestType === 'mcp') {
      void this.loadMcpResponsePanel();
      if (state.requestTab === 'body') void this.loadMcpCallTab();
    }
    if (state.requestType === 'ai') {
      void this.loadAiConversationPanel();
      if (state.requestTab === 'body') void this.loadAiPromptTab();
      if (state.requestTab === 'tools') void this.loadAiToolsTab();
    }
    if (state.requestType === 'grpc') {
      void this.loadGrpcResponsePanel();
      if (state.requestTab === 'body') void this.loadGrpcMessageTab();
      if (state.requestTab === 'metadata') void this.loadGrpcMetadataTab();
      if (state.requestTab === 'service') void this.loadGrpcServiceDefinitionTab();
      if (state.requestTab === 'settings') void this.loadGrpcSettingsTab();
    }
    if (state.requestType !== 'ws' && state.requestType !== 'socketio' && state.requestType !== 'grpc' && state.requestType !== 'mcp' && state.requestType !== 'ai' && !(state.requestType === 'http' && (state.method === 'SSE' || state.sseSessionVisible))) {
      void this.loadResponsePanel();
    }
  }
}

export const appLazyComponents = new AppLazyComponents();
