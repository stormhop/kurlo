import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './lib/theme';
import { applyUiScale } from './lib/uiScale';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { installFatalErrorGuard } from './lib/fatalError';

installFatalErrorGuard();
applyUiScale();

const target = document.getElementById('app') as HTMLElement;

if (import.meta.env.DEV) {
  void import('./lib/devRecovery').then(({ installDevRecovery }) => installDevRecovery(target));
}

const app = mount(App, {
  target
});

export default app;
